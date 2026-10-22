import { describe, expect, it } from 'vitest';
import {
  addCanvas,
  createTemplateDoc,
  deleteCanvas,
  docFromState,
  docToState,
  listCanvases,
  setActiveCanvas,
} from '@gmind/core';
import { resolveSnapshotCanvasId } from './versionSnapshot';

/**
 * 版本快照预览画布解析（多画布计划三 Task 4，item 11）：
 * 快照 doc 内取**同 canvasId** 的画布；快照不含该画布（旧快照/已删画布）
 * 回退第一画布（canvasOrder 首个存活）。
 */

function makeTwoCanvasDoc(): { doc: ReturnType<typeof createTemplateDoc>; c1: string; c2: string } {
  const doc = createTemplateDoc({ title: '本周计划', children: [{ text: '甲' }] });
  const c1 = listCanvases(doc)[0]!.id;
  const c2 = addCanvas(doc, { name: '画布 2' });
  setActiveCanvas(doc, c1);
  return { doc, c1, c2 };
}

describe('resolveSnapshotCanvasId（版本快照预览口径）', () => {
  it('快照含同 canvasId 画布 → 原样返回（预览与当前视图同画布）', () => {
    const { doc, c1, c2 } = makeTwoCanvasDoc();
    const snap = docFromState(docToState(doc));
    expect(resolveSnapshotCanvasId(snap, c2)).toBe(c2);
    expect(resolveSnapshotCanvasId(snap, c1)).toBe(c1);
    snap.destroy();
    doc.destroy();
  });

  it('快照不含该画布（画布在快照后被删）→ 回退第一画布', () => {
    const { doc, c1, c2 } = makeTwoCanvasDoc();
    const snap = docFromState(docToState(doc));
    deleteCanvas(snap, c2);
    expect(resolveSnapshotCanvasId(snap, c2)).toBe(c1);
    snap.destroy();
    doc.destroy();
  });

  it('canvasId 缺省/失效 → 第一画布（旧快照兼容口径）', () => {
    const { doc, c1 } = makeTwoCanvasDoc();
    const snap = docFromState(docToState(doc));
    expect(resolveSnapshotCanvasId(snap, undefined)).toBe(c1);
    expect(resolveSnapshotCanvasId(snap, 'no-such-canvas')).toBe(c1);
    snap.destroy();
    doc.destroy();
  });
});
