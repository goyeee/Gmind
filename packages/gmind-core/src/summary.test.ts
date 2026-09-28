import { describe, expect, it } from 'vitest';
import * as Y from 'yjs';
import { createTemplateDoc, ROOT_NODE_ID } from './doc';
import { GmindCoreError } from './errors';
import { getNode } from './read';
import { deleteNodes, moveNode, ORIGIN_SYSTEM } from './operations';
import { listSummaries, removeSummary, setSummary } from './summary';
import { attachRemoteNormalization, normalizeTree } from './repair';
import { createUndoManager, redo, undo } from './undo';
import { MAX_TEXT_LENGTH } from './constants';

/**
 * 概要（summary bracket）core 层测试 — M6 Task 6（企微对标）。
 *
 * 数据口径（M6 Global Constraints 裁定）：doc 级 `summaries` Y.Map
 * （id → {nodeIds: string[], label: string}），nodeIds 为同父连续兄弟片段；
 * 节点删除致片段断裂时 repair 收敛（全部消失→删概要；部分→保留存活子段）。
 *
 * 固定树：root → [周一[周会对齐], 周三[方案评审], 周五[周报复盘]]（种子镜像）。
 */

function buildDoc(): Y.Doc {
  return createTemplateDoc({
    title: 'T',
    children: [
      { text: '周一', children: [{ text: '周会对齐' }] },
      { text: '周三', children: [{ text: '方案评审' }] },
      { text: '周五', children: [{ text: '周报复盘' }] },
    ],
  });
}

function findId(doc: Y.Doc, text: string): string {
  for (const [id, node] of doc.getMap('nodes').entries()) {
    if ((node as Y.Map<unknown>).get('text') === text) return id;
  }
  throw new Error(`test helper: node "${text}" not found`);
}

/** 概要存储原始视图（测试断言用，绕过 listSummaries 的排序/防御层）。 */
function rawSummaries(doc: Y.Doc): Record<string, { nodeIds: string[]; label: string }> {
  const out: Record<string, { nodeIds: string[]; label: string }> = {};
  for (const [id, entry] of doc.getMap('summaries').entries()) {
    const m = entry as Y.Map<unknown>;
    const nodeIds = m.get('nodeIds') as Y.Array<string> | undefined;
    out[id] = {
      nodeIds: nodeIds ? nodeIds.toArray() : [],
      label: typeof m.get('label') === 'string' ? (m.get('label') as string) : '',
    };
  }
  return out;
}

describe('setSummary 校验（先于事务，拒绝即零变更）', () => {
  it('合法：同父连续三兄弟 → 返回 id，存储 nodeIds 按父序、label 可读回', () => {
    const doc = buildDoc();
    const mon = findId(doc, '周一');
    const wed = findId(doc, '周三');
    const fri = findId(doc, '周五');
    const id = setSummary(doc, [fri, mon, wed], '上半周'); // 乱序传入 → 按父序规范化存储
    expect(id).toMatch(/^[0-9A-HJ-NP-TV-Z]{26}$/);
    expect(rawSummaries(doc)[id]).toEqual({ nodeIds: [mon, wed, fri], label: '上半周' });
    expect(listSummaries(doc)).toEqual([{ id, nodeIds: [mon, wed, fri], label: '上半周' }]);
  });

  it('同片段重复 setSummary → 复用同一 id 仅更新 label（label 行内编辑提交口径）', () => {
    const doc = buildDoc();
    const mon = findId(doc, '周一');
    const wed = findId(doc, '周三');
    const id1 = setSummary(doc, [mon, wed], '概要');
    const id2 = setSummary(doc, [wed, mon], '上半周');
    expect(id2).toBe(id1);
    expect(Object.keys(rawSummaries(doc))).toHaveLength(1);
    expect(rawSummaries(doc)[id1]?.label).toBe('上半周');
    expect(rawSummaries(doc)[id1]?.nodeIds).toEqual([mon, wed]);
  });

  it('空片段 → SUMMARY_INVALID', () => {
    const doc = buildDoc();
    expect(() => setSummary(doc, [], 'x')).toThrowError(GmindCoreError);
    try {
      setSummary(doc, [], 'x');
    } catch (e) {
      expect((e as GmindCoreError).code).toBe('SUMMARY_INVALID');
    }
  });

  it('不同父节点 → SUMMARY_INVALID（周一 + 周一对齐的子节点跨层）', () => {
    const doc = buildDoc();
    const mon = findId(doc, '周一');
    const align = findId(doc, '周会对齐');
    expect(() => setSummary(doc, [mon, align], 'x')).toThrowError(/SUMMARY_INVALID|概要/);
  });

  it('同父但不连续（周一 + 周五，跳过周三）→ SUMMARY_INVALID', () => {
    const doc = buildDoc();
    expect(() => setSummary(doc, [findId(doc, '周一'), findId(doc, '周五')], 'x')).toThrowError(
      GmindCoreError,
    );
  });

  it('含中心主题 / 含不存在 id / 含重复 id → SUMMARY_INVALID', () => {
    const doc = buildDoc();
    const mon = findId(doc, '周一');
    expect(() => setSummary(doc, [ROOT_NODE_ID, mon], 'x')).toThrowError(GmindCoreError);
    expect(() => setSummary(doc, ['01NOPE', mon], 'x')).toThrowError(GmindCoreError);
    expect(() => setSummary(doc, [mon, mon], 'x')).toThrowError(GmindCoreError);
  });

  it('含已删除（墓碑）节点 → SUMMARY_INVALID；标签超长 → SUMMARY_INVALID', () => {
    const doc = buildDoc();
    const mon = findId(doc, '周一');
    const wed = findId(doc, '周三');
    deleteNodes(doc, [wed]);
    expect(() => setSummary(doc, [mon, wed], 'x')).toThrowError(GmindCoreError);
    expect(() => setSummary(doc, [mon], 'x'.repeat(MAX_TEXT_LENGTH + 1))).toThrowError(
      GmindCoreError,
    );
  });

  it('拒绝时零变更（summaries map 不产生任何写入）', () => {
    const doc = buildDoc();
    let updates = 0;
    doc.on('update', () => {
      updates += 1;
    });
    expect(() => setSummary(doc, [findId(doc, '周一'), findId(doc, '周五')], 'x')).toThrow();
    expect(updates).toBe(0);
    expect(Object.keys(rawSummaries(doc))).toHaveLength(0);
  });
});

describe('removeSummary / listSummaries', () => {
  it('removeSummary 删除条目；不存在的 id 静默 no-op（零写入）', () => {
    const doc = buildDoc();
    const id = setSummary(doc, [findId(doc, '周一'), findId(doc, '周三')], '上半周');
    removeSummary(doc, id);
    expect(Object.keys(rawSummaries(doc))).toHaveLength(0);
    let updates = 0;
    doc.on('update', () => {
      updates += 1;
    });
    removeSummary(doc, id); // 已删：静默
    expect(updates).toBe(0);
  });

  it('listSummaries 按 id 升序稳定输出；畸形条目确定性跳过', () => {
    const doc = buildDoc();
    const a = setSummary(doc, [findId(doc, '周一')], 'A');
    const b = setSummary(doc, [findId(doc, '周五')], 'B');
    const ordered = [a, b].sort();
    expect(listSummaries(doc).map((s) => s.id)).toEqual(ordered);
    // 畸形条目（远端坏数据）：非 Y.Map 值 / nodeIds 非 Y.Array / label 非字符串 → 跳过
    doc.getMap('summaries').set('junk-string', 'oops' as unknown as Y.Map<unknown>);
    const junkMap = new Y.Map<unknown>();
    junkMap.set('label', 42); // 缺 nodeIds / label 非字符串
    doc.getMap('summaries').set('junk-map', junkMap);
    const ids = listSummaries(doc).map((s) => s.id);
    expect(ids).toContain(a);
    expect(ids).toContain(b);
    expect(ids).not.toContain('junk-string');
    expect(ids).not.toContain('junk-map');
  });
});

describe('撤销语义', () => {
  it('setSummary/removeSummary 为 ORIGIN_USER：一次撤销移除概要、重做恢复', () => {
    const doc = buildDoc();
    const um = createUndoManager(doc);
    const mon = findId(doc, '周一');
    const wed = findId(doc, '周三');
    setSummary(doc, [mon, wed], '上半周');
    expect(Object.keys(rawSummaries(doc))).toHaveLength(1);
    undo(um);
    expect(Object.keys(rawSummaries(doc))).toHaveLength(0);
    redo(um);
    expect(Object.keys(rawSummaries(doc))).toHaveLength(1);
    removeSummary(doc, Object.keys(rawSummaries(doc))[0] as string);
    expect(Object.keys(rawSummaries(doc))).toHaveLength(0);
    undo(um);
    expect(Object.keys(rawSummaries(doc))).toHaveLength(1);
  });
});

describe('repair 收敛（节点删除致片段断裂，M6 Global Constraints 口径）', () => {
  it('片段内全部消失 → 概要删除（deleteNodes 写后自动收敛）', () => {
    const doc = buildDoc();
    const mon = findId(doc, '周一');
    const wed = findId(doc, '周三');
    setSummary(doc, [mon, wed], '上半周');
    deleteNodes(doc, [mon, wed]);
    expect(Object.keys(rawSummaries(doc))).toHaveLength(0);
  });

  it('部分删除 → 收敛到存活子段，label 保留（中间节点删除）', () => {
    const doc = buildDoc();
    const mon = findId(doc, '周一');
    const wed = findId(doc, '周三');
    const fri = findId(doc, '周五');
    setSummary(doc, [mon, wed, fri], '一周');
    deleteNodes(doc, [wed]);
    const entries = Object.entries(rawSummaries(doc));
    expect(entries).toHaveLength(1);
    expect(entries[0]?.[1]).toEqual({ nodeIds: [mon, fri], label: '一周' });
  });

  it('部分删除（片段尾节点删除）→ 收敛到存活段', () => {
    const doc = buildDoc();
    const mon = findId(doc, '周一');
    const wed = findId(doc, '周三');
    setSummary(doc, [mon, wed], '上半周');
    deleteNodes(doc, [mon]);
    expect(Object.values(rawSummaries(doc))).toEqual([{ nodeIds: [wed], label: '上半周' }]);
  });

  it('子树删除（连后代一起删）→ 片段按存活成员收敛', () => {
    const doc = buildDoc();
    const mon = findId(doc, '周一');
    const wed = findId(doc, '周三');
    setSummary(doc, [mon, wed], '上半周');
    deleteNodes(doc, [mon]); // 周一连同「周会对齐」整棵子树墓碑
    expect(getNode(doc, findId(doc, '周会对齐'))?.deleted).toBe(true);
    expect(Object.values(rawSummaries(doc))).toEqual([{ nodeIds: [wed], label: '上半周' }]);
  });

  it('moveNode 换父（成员离开片段）→ 收敛到存活段', () => {
    const doc = buildDoc();
    const mon = findId(doc, '周一');
    const wed = findId(doc, '周三');
    const fri = findId(doc, '周五');
    setSummary(doc, [mon, wed], '上半周');
    moveNode(doc, wed, fri); // 周三挂到周五下 → 片段只剩周一
    expect(Object.values(rawSummaries(doc))).toEqual([{ nodeIds: [mon], label: '上半周' }]);
  });

  it('干净概要零修复零写入（repair 空转不产生 update）', () => {
    const doc = buildDoc();
    const mon = findId(doc, '周一');
    const wed = findId(doc, '周三');
    setSummary(doc, [mon, wed], '上半周');
    let updates = 0;
    doc.on('update', () => {
      updates += 1;
    });
    expect(normalizeTree(doc, ORIGIN_SYSTEM)).toBe(0);
    expect(updates).toBe(0);
  });

  it('全量 normalizeTree 兜底：绕过写入口的裸墓碑（crafted doc）同样收敛', () => {
    const doc = buildDoc();
    const mon = findId(doc, '周一');
    const wed = findId(doc, '周三');
    const id = setSummary(doc, [mon, wed], '上半周');
    // 裸事务直接墓碑周三（模拟远端/历史残留，不经 deleteNodes 的 children 清理）
    doc.transact(() => {
      (doc.getMap('nodes').get(wed) as Y.Map<unknown>).set('deleted', true);
    }, ORIGIN_SYSTEM);
    normalizeTree(doc, ORIGIN_SYSTEM);
    const entry = rawSummaries(doc)[id];
    expect(entry).toEqual({ nodeIds: [mon], label: '上半周' });
  });

  it('远端事务同样收敛：attachRemoteNormalization 收到删除 update 后概要收敛', () => {
    // 副本 A 创建概要 + 删除片段成员；副本 B 从 A 的初始状态克隆后仅收 update
    // （远端裸事务路径）。两副本共享同一批 ULID，收敛断言才有意义。
    const a = buildDoc();
    const b = new Y.Doc();
    Y.applyUpdate(b, Y.encodeStateAsUpdate(a));
    const detach = attachRemoteNormalization(b);
    a.on('update', (update) => {
      Y.applyUpdate(b, update);
    });
    const mon = findId(a, '周一');
    const wed = findId(a, '周三');
    setSummary(a, [mon, wed], '上半周');
    expect(Object.values(rawSummaries(b))).toEqual([{ nodeIds: [mon, wed], label: '上半周' }]);
    deleteNodes(a, [mon]);
    expect(Object.values(rawSummaries(b))).toEqual([{ nodeIds: [wed], label: '上半周' }]);
    detach();
  });

  it('收敛后仍是合法片段：listSummaries 输出可直接再次 setSummary 同 id 更新', () => {
    const doc = buildDoc();
    const mon = findId(doc, '周一');
    const wed = findId(doc, '周三');
    const id = setSummary(doc, [mon, wed], '上半周');
    deleteNodes(doc, [mon]);
    const after = listSummaries(doc)[0];
    expect(after?.nodeIds).toEqual([wed]);
    const id2 = setSummary(doc, after?.nodeIds ?? [], '改名');
    expect(id2).toBe(id);
    expect(rawSummaries(doc)[id]?.label).toBe('改名');
  });
});
