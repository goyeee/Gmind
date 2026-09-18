import * as Y from 'yjs';

/** 写操作来源：'user'（可撤销）/ 'system'（内部/修复，不进撤销栈）。 */
export type WriteOrigin = string;
export const ORIGIN_USER: WriteOrigin = 'user';
export const ORIGIN_SYSTEM: WriteOrigin = 'system';

/** 撤销栈默认深度（FR-EDT-004）。 */
export const UNDO_STACK_MAX = 100;

/**
 * 撤销栈（FR-EDT-004）：仅跟踪 ORIGIN_USER 的事务——本人编辑可撤销；
 * system origin（折叠、normalize 修复等内部写）与无 origin 的裸事务（origin null）
 * 一律不进栈。captureTimeout 500ms 内的连续编辑合并为一条撤销单元（Yjs 默认语义）。
 */
export function createUndoManager(doc: Y.Doc): Y.UndoManager {
  return new Y.UndoManager(doc, {
    trackedOrigins: new Set([ORIGIN_USER]),
    captureTimeout: 500,
  });
}

/** 裁剪撤销栈深度至 max（默认 100），淘汰最早的栈项。 */
export function capUndoStack(um: Y.UndoManager, max: number = UNDO_STACK_MAX): void {
  while (um.undoStack.length > max) um.undoStack.shift();
}

/** 撤销一步；返回是否生效（Yjs 返回弹出的 StackItem，空栈为 null）。 */
export function undo(um: Y.UndoManager): boolean {
  return um.undo() !== null;
}

/** 重做一步；返回是否生效（重做栈为空时 Yjs 返回 null）。 */
export function redo(um: Y.UndoManager): boolean {
  return um.redo() !== null;
}
