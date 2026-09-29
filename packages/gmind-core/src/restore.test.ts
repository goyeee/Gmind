import { describe, expect, it } from 'vitest';
import * as Y from 'yjs';
import { ICON_GROUPS, iconValuesOf } from './constants';
import { ROOT_NODE_ID, createTemplateDoc, docFromState, docToState } from './doc';
import type { TemplateNodeSpec } from './doc';
import {
  addChild,
  deleteNodes,
  moveNode,
  setCollapsed,
  setHref,
  setImage,
  setIcon,
  setNodeTask,
  setNote,
  setStyle,
  setText,
} from './operations';
import { childrenIds, countAliveReachable, getMeta, getNode, setDocMeta } from './read';
import { normalizeTree } from './repair';
import { ORIGIN_SYSTEM, createUndoManager, undo } from './undo';
import { ORIGIN_RESTORE, restoreFromSnapshot } from './restore';

/**
 * restoreFromSnapshot（M4 Task 7，FR-VER-004）：结构 op-diff 单事务恢复。
 *
 * 场景纪律（binding）：先建 target、再 docFromState(docToState(...)) 建同源快照，
 * 漂移一律走 core API（与生产编辑路径同源）。断言口径：
 * - 收敛性 = 结构（root 先序 text 序列 + 逐节点字段）与快照一致；
 * - 计数语义：deleted=顶层删除 op 数（子树随整枝，不逐节点计）、created=重建节点数
 *   （重建以新 ULID，墓碑永久）、moved=实际执行的 moveNode 数、updated=内容字段有写
 *   的交集节点数（重建节点的回填计入 created，不计 updated）。
 */

/** 测试树：root → [A[A1], B]（存活节点 3 个：A/A1/B）。 */
function makeDoc(): Y.Doc {
  return createTemplateDoc({ title: 'T', children: [{ text: 'A', children: [{ text: 'A1' }] }, { text: 'B' }] });
}

/** 按文本查节点 id（测试辅助；模板生成的 ULID 不可预知）。 */
function idOf(doc: Y.Doc, text: string): string {
  for (const [id, node] of doc.getMap('nodes').entries()) {
    if ((node as Y.Map<unknown>).get('text') === text) return id;
  }
  throw new Error(`test helper: node with text "${text}" not found`);
}

/** 按文本查「存活」节点 id（排除 root 与墓碑）——重建节点以新 id 落地后按文本找回。 */
function aliveIdOf(doc: Y.Doc, text: string): string {
  for (const [id, node] of doc.getMap('nodes').entries()) {
    const n = node as Y.Map<unknown>;
    if (id !== ROOT_NODE_ID && n.get('deleted') !== true && n.get('text') === text) return id;
  }
  throw new Error(`test helper: alive node with text "${text}" not found`);
}

/** 快照 doc 的随机漂移源（确定性 LCG，同 chaos.test.ts 口径）。 */
function makeLcg(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s;
  };
}

/** 两 doc 自 root 起先序平行走树：id/parentId 可不同（重建换 id），结构与全字段须一致。 */
function expectConverged(target: Y.Doc, snapshot: Y.Doc): void {
  const walk = (tId: string, sId: string): void => {
    const t = getNode(target, tId)!;
    const s = getNode(snapshot, sId)!;
    expect(t.text, `text@${sId}`).toBe(s.text);
    expect(t.note, `note@${sId}`).toBe(s.note);
    expect(t.href, `href@${sId}`).toBe(s.href);
    expect(t.collapsed, `collapsed@${sId}`).toBe(s.collapsed);
    expect(t.icons, `icons@${sId}`).toEqual(s.icons);
    expect(t.task, `task@${sId}`).toEqual(s.task);
    expect(t.image, `image@${sId}`).toEqual(s.image);
    expect(t.style, `style@${sId}`).toEqual(s.style);
    expect(t.childIds, `childIds.len@${sId}`).toHaveLength(s.childIds.length);
    for (let i = 0; i < s.childIds.length; i += 1) walk(t.childIds[i]!, s.childIds[i]!);
  };
  walk(ROOT_NODE_ID, ROOT_NODE_ID);
  expect(countAliveReachable(target)).toBe(countAliveReachable(snapshot));
  expect(normalizeTree(target, ORIGIN_SYSTEM)).toBe(0); // 恢复产物满足 §4.2 全部不变量
}

/** 随机树（分层 children，文本唯一便于断言）。 */
function randomSpec(rnd: () => number, depth: number, prefix: string): TemplateNodeSpec {
  const spec: TemplateNodeSpec = { text: prefix };
  if (depth > 0) {
    spec.children = Array.from({ length: rnd() % 3 }, (_, i) => randomSpec(rnd, depth - 1, `${prefix}.${i}`));
  }
  return spec;
}

describe('ORIGIN_RESTORE', () => {
  it("常量值为 'restore'", () => {
    expect(ORIGIN_RESTORE).toBe('restore');
  });
});

describe('restoreFromSnapshot', () => {
  it('恢复：文本/结构差异收敛到快照；多余子树删除', () => {
    const base = makeDoc(); // root → [A[A1], B]
    const snap = docFromState(docToState(base)); // 快照定档
    setText(base, idOf(base, 'A'), '改了'); // 文本漂移
    const xId = addChild(base, idOf(base, 'B'), { text: '新增' }); // 多余子树（B 下）
    addChild(base, xId, { text: '多余孙' }); // 深层随 X 整枝墓碑，不单独计删除
    const r = restoreFromSnapshot(base, snap);
    expect(r).toEqual({ deleted: 1, created: 0, moved: 0, updated: 1 });
    expect(getNode(base, idOf(base, 'A'))!.text).toBe('A');
    expect(getNode(base, xId)!.deleted).toBe(true); // 墓碑保留（Yjs 语义）
    expect(childrenIds(base, idOf(base, 'B'))).toEqual([]); // 已从父 children 移除
    expect(countAliveReachable(base)).toBe(3); // 回到快照规模（A/A1/B）
    expectConverged(base, snap);
  });

  it('恢复：快照中已删节点以新 id 重建，内容完整（text/note/href/icons/image/style/collapsed）', () => {
    const base = makeDoc(); // root → [A[A1], B]
    const aId = idOf(base, 'A');
    setNote(base, aId, '原备注');
    setHref(base, aId, 'https://x');
    setIcon(base, aId, 'flag', 'flag');
    setImage(base, aId, { key: 'files/f1/pic.png', w: 100, h: 80 });
    setStyle(base, aId, { color: '#ff0000' });
    setCollapsed(base, aId, true);
    const snap = docFromState(docToState(base));
    deleteNodes(base, [aId]); // A 级联墓碑 A1；B 幸存
    expect(countAliveReachable(base)).toBe(1);
    const r = restoreFromSnapshot(base, snap);
    expect(r).toEqual({ deleted: 0, created: 2, moved: 0, updated: 0 }); // A 与 A1 均重建
    expect(countAliveReachable(base)).toBe(3); // 回到快照规模（重建口径与快照一致）

    const restored = aliveIdOf(base, 'A');
    expect(restored).not.toBe(aId); // 新 ULID：Yjs 墓碑永久，旧 id 不复用
    expect(getNode(base, aId)!.deleted).toBe(true); // 旧节点仍是墓碑（评论等旧 id 锚点降级为「原节点已删除」的产品裁定）
    const s = getNode(base, restored)!;
    expect(s.note).toBe('原备注');
    expect(s.href).toBe('https://x');
    expect(s.icons).toEqual({ flag: ['flag'] });
    expect(s.image).toEqual({ key: 'files/f1/pic.png', w: 100, h: 80 });
    expect(s.style).toEqual({ color: '#ff0000' });
    expect(s.collapsed).toBe(true);
    expect(s.childIds).toHaveLength(1); // A1 重建在其下
    const child = getNode(base, s.childIds[0]!)!;
    expect(child.text).toBe('A1');
    expect(child.parentId).toBe(restored);
    expect(child.id).not.toBe(idOf(base, 'A1')); // A1 同样以新 id 重建
    expectConverged(base, snap);
  });

  it('恢复：快照含值域外旧 emoji（M6 遗留）计划期跳过——不抛错、该标记不回写、其余字段正常恢复', () => {
    // B1（M7a-R1，M7b-W1 数组版沿用）：M6 存过 72 emoji、目录仅 28；repair 有意保留
    // 值域外旧 emoji（emoji 值本身即字形），setIcon 目录校验拒绝它们——restore 在
    // 计划期（事务外）按 canonicalSnapIcons 目录过滤，不可写值的组整体跳过。
    const base = makeDoc(); // root → [A[A1], B]
    const aId = idOf(base, 'A');
    // M6 遗留注入：值域外旧 emoji 经「外部状态直入」落库（绕过 setIcon 目录校验，
    // 与 repair 保留口径同形）；快照装载 docFromState 的 normalize 不收敛它
    // （M7b repair 对 emoji 组保留目录外字符）。
    const legacyIcons = new Y.Map<unknown>();
    legacyIcons.set('emoji', '🚀');
    (base.getMap('nodes').get(aId) as Y.Map<unknown>).set('icons', legacyIcons);
    const snap = docFromState(docToState(base));
    expect(getNode(snap, aId)!.icons).toEqual({ emoji: ['🚀'] }); // 前置：值域外值确在快照中

    // 漂移：文本改写 + 旧 emoji 换成目录内新值（日常触发场景），随后恢复旧版本
    setText(base, aId, '改了');
    setIcon(base, aId, 'emoji', '😄');

    const r = restoreFromSnapshot(base, snap); // 修复前：setIcon 拒绝 🚀 → 事务内抛错半恢复
    expect(r.updated).toBe(1); // 仅文本差异入计划；🚀 组计划期跳过
    expect(getNode(base, aId)!.text).toBe('A'); // 其余字段正常恢复
    expect(getNode(base, aId)!.icons).toEqual({ emoji: ['😄'] }); // 不可回写标记跳过：现状 😄 保留
    expect(normalizeTree(base, ORIGIN_SYSTEM)).toBe(0);

    // 变体：target 现状无 emoji——同样跳过，不回写快照值也不写 null 清除（现状保留）
    const base2 = makeDoc();
    const a2 = idOf(base2, 'A');
    const legacyIcons2 = new Y.Map<unknown>();
    legacyIcons2.set('emoji', '🚀');
    (base2.getMap('nodes').get(a2) as Y.Map<unknown>).set('icons', legacyIcons2);
    const snap2 = docFromState(docToState(base2));
    (base2.getMap('nodes').get(a2) as Y.Map<unknown>).delete('icons'); // 现状无 emoji
    setText(base2, a2, '改了');
    const r2 = restoreFromSnapshot(base2, snap2);
    expect(r2.updated).toBe(1);
    expect(getNode(base2, a2)!.text).toBe('A');
    expect(getNode(base2, a2)!.icons).toEqual({}); // 不回写 🚀、也不清（无 emoji 可清）
  });

  it('恢复：乱序重排收敛到快照同层顺序；meta 恢复 structureType/themeId 不动 title', () => {
    const base = makeDoc();
    const aId = idOf(base, 'A');
    const bId = idOf(base, 'B');
    const snap = docFromState(docToState(base));
    moveNode(base, bId, ROOT_NODE_ID, 0); // [B, A] 乱序
    setDocMeta(base, { title: '改过的标题', structureType: 'org', themeId: 'gmind-warm' });
    const r = restoreFromSnapshot(base, snap);
    expect(r).toEqual({ deleted: 0, created: 0, moved: 1, updated: 0 }); // B 归位/A 未动（或等价的单次归位）
    expect(childrenIds(base, ROOT_NODE_ID)).toEqual([aId, bId]); // 收敛到快照同层顺序
    const meta = getMeta(base);
    expect(meta.structureType).toBe('mindmap');
    expect(meta.themeId).toBe('gmind-light');
    expect(meta.title).toBe('改过的标题'); // title 不回滚：工作区文件名不随版本恢复变化
    expectConverged(base, snap);
  });

  it('恢复：对一致状态零操作（不开事务、计数全零）；双跑幂等', () => {
    const base = makeDoc();
    const snap = docFromState(docToState(base));

    // 一致状态：计数全零，且全程无任何事务写入（任何写入都会触发 update 事件）
    const origins: unknown[] = [];
    const observer = (_u: Uint8Array, origin: unknown): void => {
      origins.push(origin);
    };
    base.on('update', observer);
    expect(restoreFromSnapshot(base, snap)).toEqual({ deleted: 0, created: 0, moved: 0, updated: 0 });
    expect(origins).toEqual([]);
    base.off('update', observer);

    // 漂移（无删除 → 无重建换 id）→ 恢复 → 再恢复：第二次全零且仍无写入（幂等）。
    // 注：含删除的漂移会以新 ULID 重建，重建节点 id 不在快照 id 集内，再次恢复会再换
    // 一代 id（内容仍收敛，见混沌用例）——「双跑幂等」的精确语义 = 无重建场景零重复操作。
    setText(base, idOf(base, 'A'), '改了');
    const xId = addChild(base, ROOT_NODE_ID, { text: '多余' });
    moveNode(base, xId, idOf(base, 'B'));
    const r1 = restoreFromSnapshot(base, snap);
    expect(r1.deleted).toBe(1);
    expect(r1.updated).toBe(1);
    expect(countAliveReachable(base)).toBe(3);

    const origins2: unknown[] = [];
    const observer2 = (_u: Uint8Array, origin: unknown): void => {
      origins2.push(origin);
    };
    base.on('update', observer2);
    expect(restoreFromSnapshot(base, snap)).toEqual({ deleted: 0, created: 0, moved: 0, updated: 0 });
    expect(origins2).toEqual([]);
    base.off('update', observer2);
    expectConverged(base, snap);
  });

  it('恢复：不进撤销栈（ORIGIN_RESTORE 隔离 UndoManager）', () => {
    const base = makeDoc();
    const snap = docFromState(docToState(base));
    const um = createUndoManager(base);
    setText(base, idOf(base, 'A'), '改了'); // 用户漂移 1：进栈
    um.stopCapturing(); // 隔离 captureTimeout，两笔独立栈项
    const xId = addChild(base, ROOT_NODE_ID, { text: '多余' }); // 用户漂移 2：进栈
    um.stopCapturing();
    expect(um.undoStack.length).toBe(2);

    const r = restoreFromSnapshot(base, snap);
    expect(r).toEqual({ deleted: 1, created: 0, moved: 0, updated: 1 });
    expect(um.undoStack.length).toBe(2); // 恢复写入（ORIGIN_RESTORE）未进栈
    expect(getNode(base, xId)!.deleted).toBe(true);

    // undo 只回退本人编辑，不回滚恢复结果：X（addChild 项）可撤销；文本漂移项的插入
    // 已被恢复覆盖（yjs 弹栈跳过插入被删的栈项），恢复后的文档不再因 undo 回滚。
    expect(undo(um)).toBe(true); // 回退 addChild：X 彻底消失
    expect(getNode(base, xId)).toBeNull();
    expect(getNode(base, idOf(base, 'A'))!.text).toBe('A'); // 恢复写入的结果在
    expect(undo(um)).toBe(false); // 文本项插入已被恢复覆盖，无可撤销内容
    expect(um.undoStack.length).toBe(0);
    expectConverged(base, snap); // 恢复结果不被撤销（文档即快照态）
  });

  it('恢复：随机漂移收敛（种子化混沌）——结构与全字段、幂等', () => {
    for (const seed of [7, 42, 20260926]) {
      const rnd = makeLcg(seed);
      const base = createTemplateDoc({ title: 'T', children: [randomSpec(rnd, 3, 'n')] });
      enrichRandom(rnd, base);
      const snap = docFromState(docToState(base));

      // 随机漂移：加/删/移/改文本（候选只取存活节点，操作不抛错——同 chaos 纪律）
      for (let i = 0; i < 40; i += 1) {
        const alive = aliveIds(base);
        const pick = (): string => alive[rnd() % alive.length]!;
        switch (rnd() % 4) {
          case 0:
            addChild(base, pick(), { text: `x${i}` });
            break;
          case 1: {
            const victim = pick();
            if (victim !== ROOT_NODE_ID) deleteNodes(base, [victim]);
            break;
          }
          case 2: {
            const id = pick();
            const parent = pick();
            if (id !== ROOT_NODE_ID && parent !== id && !subtreeContains(base, id, parent)) {
              moveNode(base, id, parent);
            }
            break;
          }
          default:
            setText(base, pick(), `t${i}`);
        }
      }
      restoreFromSnapshot(base, snap);
      expectConverged(base, snap);
      // 再恢复：内容恒收敛（重建节点以新 ULID 再生一代——快照 id 集不含上一代重建 id，
      // 计数可为非零，但结构与全字段必须再次与快照一致且 normalize 零残留）。
      restoreFromSnapshot(base, snap);
      expectConverged(base, snap);
    }
  });
});

// ── 混沌辅助 ─────────────────────────────────────────────────────────────────

function aliveIds(doc: Y.Doc): string[] {
  const out: string[] = [ROOT_NODE_ID];
  for (const [id, node] of doc.getMap('nodes').entries()) {
    if (id !== ROOT_NODE_ID && (node as Y.Map<unknown>).get('deleted') !== true) out.push(id);
  }
  return out;
}

function subtreeContains(doc: Y.Doc, ancestorId: string, maybeDescendantId: string): boolean {
  const stack = [...childrenIds(doc, ancestorId)];
  while (stack.length > 0) {
    const id = stack.pop()!;
    if (id === maybeDescendantId) return true;
    stack.push(...childrenIds(doc, id));
  }
  return false;
}

/** 给随机树的部分节点补字段（icons 全组轮转[值取自组目录] + image/style/note/href/collapsed + task）。 */
function enrichRandom(rnd: () => number, doc: Y.Doc): void {
  let i = 0;
  for (const id of aliveIds(doc)) {
    if (id === ROOT_NODE_ID || rnd() % 2 === 0) continue;
    setNote(doc, id, `note${i}`);
    if (i % 2 === 0) setHref(doc, id, `https://x/${i}`);
    const group = ICON_GROUPS[i % ICON_GROUPS.length]!;
    const values = iconValuesOf(group);
    setIcon(doc, id, group, values[i % values.length]!);
    if (i % 5 === 0) setNodeTask(doc, id, { status: 'doing', progress: i % 101, owners: [`u${i}`] });
    if (i % 3 === 0) setImage(doc, id, { key: `k${i}`, w: 10 + i, h: 20 + i });
    setStyle(doc, id, { color: `#${i}` });
    if (i % 4 === 0) setCollapsed(doc, id, true);
    i += 1;
  }
}
