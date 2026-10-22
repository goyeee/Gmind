import { describe, expect, it } from 'vitest';
import * as Y from 'yjs';
import { createTemplateDoc, ROOT_NODE_ID } from './doc';
import { canvasNodesMap, canvasSummariesMap, listCanvases } from './canvas';
import { GmindCoreError } from './errors';
import { getNode } from './read';
import { deleteNodes, moveNode, ORIGIN_SYSTEM, ORIGIN_USER } from './operations';
import { listSummaries, planSummaryRepair, removeSummary, setSummary, validSummarySegment } from './summary';
import { applySummaryRepair } from './summary';
import { attachRemoteNormalization, normalizeTree } from './repair';
import { createUndoManager, redo, undo } from './undo';
import { MAX_TEXT_LENGTH } from './constants';

/**
 * 概要（summary bracket）core 层测试 — M6 Task 6（企微对标）＋多画布 Task 6。
 *
 * 数据口径（M6 Global Constraints 裁定）：doc 级 `summaries` Y.Map
 * （id → {nodeIds: string[], label: string}），nodeIds 为同父连续兄弟片段；
 * 节点删除致片段断裂时 repair 收敛（全部消失→删概要；部分→保留存活子段）。
 * 多画布（Task 6）：summaries 住**画布子图**内（canvasMap.summaries），全部公开
 * 函数带可选 canvasId（缺省 = 解析画布——activeCanvasId 兼容层，web/server 零改动）。
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
  for (const [id, node] of canvasNodesMap(doc).entries()) {
    if ((node as Y.Map<unknown>).get('text') === text) return id;
  }
  throw new Error(`test helper: node "${text}" not found`);
}

/** 概要存储原始视图（测试断言用，绕过 listSummaries 的排序/防御层）。
 *  多画布：显式 canvasId 读该画布子图；缺省读解析画布。 */
function rawSummariesOf(doc: Y.Doc, canvasId?: string): Record<string, { nodeIds: string[]; label: string }> {
  const out: Record<string, { nodeIds: string[]; label: string }> = {};
  for (const [id, entry] of canvasSummariesMap(doc, canvasId).entries()) {
    const m = entry as Y.Map<unknown>;
    const nodeIds = m.get('nodeIds') as Y.Array<string> | undefined;
    out[id] = {
      nodeIds: nodeIds ? nodeIds.toArray() : [],
      label: typeof m.get('label') === 'string' ? (m.get('label') as string) : '',
    };
  }
  return out;
}
const rawSummaries = (doc: Y.Doc): Record<string, { nodeIds: string[]; label: string }> =>
  rawSummariesOf(doc);

/**
 * 手工追加一个画布（确定性 id，多画布用例直接引用）：root + 指定子节点
 * （形状同 repair.test.ts 的 multiCanvasDoc，概要侧自含一份避免跨文件依赖）。
 */
function appendCanvas(doc: Y.Doc, canvasId: string, rootId: string, childIds: string[]): void {
  doc.transact(() => {
    const canvas = new Y.Map<unknown>();
    canvas.set('name', `画布-${canvasId}`);
    canvas.set('rootId', rootId);
    canvas.set('structureType', 'mindmap');
    canvas.set('themeId', 'gmind-light');
    const nodes = new Y.Map<Y.Map<unknown>>();
    const root = new Y.Map<unknown>();
    root.set('text', `R-${canvasId}`);
    root.set('parentId', '');
    const rootChildren = new Y.Array<string>();
    root.set('children', rootChildren);
    nodes.set(rootId, root);
    for (const childId of childIds) {
      const child = new Y.Map<unknown>();
      child.set('text', childId);
      child.set('parentId', rootId);
      child.set('children', new Y.Array<string>());
      nodes.set(childId, child);
      rootChildren.push([childId]);
    }
    canvas.set('nodes', nodes);
    canvas.set('summaries', new Y.Map<unknown>());
    (doc.getMap('canvases') as Y.Map<Y.Map<unknown>>).set(canvasId, canvas);
    (doc.getArray('canvasOrder') as Y.Array<string>).push([canvasId]);
  });
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
    canvasSummariesMap(doc).set('junk-string', 'oops' as unknown as Y.Map<unknown>);
    const junkMap = new Y.Map<unknown>();
    junkMap.set('label', 42); // 缺 nodeIds / label 非字符串
    canvasSummariesMap(doc).set('junk-map', junkMap);
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
      (canvasNodesMap(doc).get(wed) as Y.Map<unknown>).set('deleted', true);
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

describe('多画布作用域（Task 6：summaries 住画布子图，缺省 = 解析画布）', () => {
  /** 基线：模板画布（root，周一/周三/周五）+ 手工追加 c2（root-c2，c2-x/c2-y）。 */
  function twoCanvasDoc(): { doc: Y.Doc; c2: string } {
    const doc = buildDoc();
    appendCanvas(doc, 'c2', 'root-c2', ['c2-x', 'c2-y']);
    return { doc, c2: 'c2' };
  }

  it('setSummary 显式 canvasId 写对应画布子图；缺省写解析画布；两画布互不串', () => {
    const { doc, c2 } = twoCanvasDoc();
    const id2 = setSummary(doc, ['c2-x', 'c2-y'], 'C2 片段', ORIGIN_USER, c2);
    expect(Object.keys(rawSummariesOf(doc, c2))).toEqual([id2]);
    expect(rawSummaries(doc)).toEqual({}); // 缺省=解析画布（c1）：未写入
    const mon = findId(doc, '周一');
    const wed = findId(doc, '周三');
    const id1 = setSummary(doc, [mon, wed], 'C1 片段'); // 缺省画布
    expect(Object.keys(rawSummaries(doc))).toEqual([id1]);
    expect(Object.keys(rawSummariesOf(doc, c2))).toEqual([id2]);
    expect(listSummaries(doc, c2)).toEqual([{ id: id2, nodeIds: ['c2-x', 'c2-y'], label: 'C2 片段' }]);
    expect(listSummaries(doc)).toEqual([{ id: id1, nodeIds: [mon, wed], label: 'C1 片段' }]);
    // 概要 id 同一片段复用口径按画布隔离：c1 的片段在 c2 查询不到复用
    expect(listCanvases(doc).map((c) => c.id)).toContain(c2);
  });

  it('validSummarySegment 按画布解析：c2 节点在缺省画布下不成立，显式 c2 规范化返回', () => {
    const { doc, c2 } = twoCanvasDoc();
    expect(validSummarySegment(doc, ['c2-y', 'c2-x'])).toBeNull(); // c1 无这些节点
    expect(validSummarySegment(doc, ['c2-y', 'c2-x'], c2)).toEqual(['c2-x', 'c2-y']);
  });

  it('显式 canvasId 指向不存在/墓碑画布 → 写层硬失败 CANVAS_NOT_FOUND（canvas.ts 访问器契约）', () => {
    const { doc, c2 } = twoCanvasDoc();
    expect(() => setSummary(doc, ['c2-x'], 'x', ORIGIN_USER, 'nope')).toThrowError(GmindCoreError);
    try {
      setSummary(doc, ['c2-x'], 'x', ORIGIN_USER, 'nope');
    } catch (e) {
      expect((e as GmindCoreError).code).toBe('CANVAS_NOT_FOUND');
    }
    expect(() => listSummaries(doc, 'nope')).toThrowError(GmindCoreError);
    expect(() => removeSummary(doc, 'x', ORIGIN_USER, 'nope')).toThrowError(GmindCoreError);
    // 墓碑画布同样硬失败（墓碑冻结，内容不可写）
    (doc.getMap('canvases').get(c2) as Y.Map<unknown>).set('deleted', true);
    expect(() => setSummary(doc, ['c2-x'], 'x', ORIGIN_USER, c2)).toThrowError(GmindCoreError);
    expect(Object.keys(rawSummaries(doc))).toHaveLength(0); // 零写入
  });

  it('removeSummary 显式 canvasId 只删该画布条目；repair plan/apply 按画布直接可用', () => {
    const { doc, c2 } = twoCanvasDoc();
    const idC1 = setSummary(doc, [findId(doc, '周一')], 'C1');
    const idC2 = setSummary(doc, ['c2-x', 'c2-y'], 'C2', ORIGIN_USER, c2);
    removeSummary(doc, idC2, ORIGIN_USER, c2);
    expect(Object.keys(rawSummariesOf(doc, c2))).toHaveLength(0);
    expect(Object.keys(rawSummaries(doc))).toEqual([idC1]);

    // c2 片段断裂（裸墓碑 c2-y）：planSummaryRepair 显式 c2 收敛、显式 c1 无计划
    const idC2b = setSummary(doc, ['c2-x', 'c2-y'], 'C2', ORIGIN_USER, c2); // 新 id（idC2 已删）
    doc.transact(() => {
      (canvasNodesMap(doc, c2).get('c2-y') as Y.Map<unknown>).set('deleted', true);
    }, ORIGIN_SYSTEM);
    const planC2 = planSummaryRepair(doc, c2);
    expect(planC2?.removeIds ?? []).toEqual([]);
    expect(planC2?.updates).toEqual([{ id: idC2b, nodeIds: ['c2-x'] }]);
    expect(planSummaryRepair(doc, findCanvasIdOf(doc))).toBeNull(); // c1 干净
    doc.transact(() => {
      expect(applySummaryRepair(doc, planC2, c2)).toBe(1);
    });
    expect(Object.values(rawSummariesOf(doc, c2))).toEqual([{ nodeIds: ['c2-x'], label: 'C2' }]);
    // 裸墓碑残留（父 children 未清理）由全量 normalize 收口：③ 清 1 处；概要已收敛幂等
    expect(normalizeTree(doc, ORIGIN_SYSTEM)).toBe(1);
    expect(normalizeTree(doc, ORIGIN_SYSTEM)).toBe(0);
  });
});

/** 解析画布 id 测试辅助（activeCanvasId 指向；模板文档恒为其唯一画布）。 */
function findCanvasIdOf(doc: Y.Doc): string {
  const active = doc.getMap('meta').get('activeCanvasId');
  if (typeof active === 'string' && active !== '') return active;
  return listCanvases(doc)[0]!.id;
}
