import * as Y from 'yjs';
import { canvasesMap, listCanvases } from '@gmind/core';

/**
 * 版本快照预览的画布解析（多画布计划三 Task 4，item 11）：
 * 快照 doc 内取**同 canvasId** 的画布（预览与当前视图同一画布）；
 * 快照不含该画布（旧快照/该画布在快照后创建/已删成墓碑）→ 回退第一画布
 * （canvasOrder 首个存活，listCanvases 口径）。画布集全灭（crafted 态）返回
 * undefined——调用方按 core 缺省解析处理（抛错由既有 toast 通道兜底）。
 */
export function resolveSnapshotCanvasId(doc: Y.Doc, canvasId?: string): string | undefined {
  if (canvasId !== undefined) {
    const canvas = canvasesMap(doc).get(canvasId);
    if (canvas instanceof Y.Map && canvas.get('deleted') !== true) return canvasId;
  }
  return listCanvases(doc)[0]?.id;
}
