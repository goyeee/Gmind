import type { Direction } from '@gmind/engine';

/**
 * 全局键盘映射 — M1b Task 11。
 *
 * 绑定裁决（carry-in 5）：绑定 document 冒泡阶段（textarea 内 Enter/Esc 由
 * TextEditorOverlay stopPropagation 吞掉，只覆盖冒泡路径——本层监听必须走冒泡）；
 * 覆盖层打开时全部忽略（keydown 再兜底 document.activeElement / target 判定），
 * 焦点在 input/textarea/select 时也全部忽略（标题输入、下拉框原生行为优先）。
 */

export interface KeyboardMapDeps {
  /** 文本编辑覆盖层是否打开（打开则本层全部让路）。 */
  isEditorOpen(): boolean;
  undo(): void;
  redo(): void;
  /** Enter（未编辑态）：新建同级节点（root 上新建子级）并进入编辑。 */
  onEnter(): void;
  /** Tab 新建子级 / Shift+Tab 在当前与父之间插新父级。 */
  onTab(shift: boolean): void;
  /** Delete/Backspace 删除选中（root 降级清空子级）。 */
  onDelete(): void;
  /** Ctrl/Cmd+A 全选存活节点。 */
  onSelectAll(): void;
  /** Ctrl+/ 折叠/展开选中节点。 */
  onToggleCollapse(): void;
  /** 方向键几何导航。 */
  onNavigate(direction: Direction): void;
  /** Home/End 同级首/末。 */
  onSiblingEnd(which: 'first' | 'last'): void;
  onCopy(): void;
  onCut(): void;
  onPaste(): void;
}

function isEditableTarget(target: EventTarget | null): boolean {
  return (
    target instanceof Element &&
    target.closest('input, textarea, select, [contenteditable="true"]') !== null
  );
}

export function attachKeyboardMap(deps: KeyboardMapDeps): () => void {
  const onKeyDown = (e: KeyboardEvent): void => {
    if (deps.isEditorOpen()) return; // 覆盖层打开：按键归编辑器
    if (isEditableTarget(e.target)) return;

    const mod = e.ctrlKey || e.metaKey;
    const key = e.key;

    if (mod && !e.altKey && (key === 'z' || key === 'Z')) {
      e.preventDefault();
      if (e.shiftKey) deps.redo();
      else deps.undo();
      return;
    }
    if (mod && !e.shiftKey && !e.altKey && (key === 'y' || key === 'Y')) {
      e.preventDefault();
      deps.redo();
      return;
    }
    if (mod && !e.shiftKey && !e.altKey && (key === 'c' || key === 'C')) {
      e.preventDefault();
      deps.onCopy();
      return;
    }
    if (mod && !e.shiftKey && !e.altKey && (key === 'x' || key === 'X')) {
      e.preventDefault();
      deps.onCut();
      return;
    }
    if (mod && !e.shiftKey && !e.altKey && (key === 'v' || key === 'V')) {
      e.preventDefault();
      deps.onPaste();
      return;
    }
    if (mod && !e.shiftKey && !e.altKey && (key === 'a' || key === 'A')) {
      e.preventDefault();
      deps.onSelectAll();
      return;
    }
    if (mod && !e.altKey && (key === '/' || key === '?')) {
      e.preventDefault();
      deps.onToggleCollapse();
      return;
    }
    if (mod || e.altKey) return;

    switch (key) {
      case 'Enter':
        e.preventDefault();
        deps.onEnter();
        return;
      case 'Tab':
        e.preventDefault();
        deps.onTab(e.shiftKey);
        return;
      case 'Delete':
      case 'Backspace':
        e.preventDefault();
        deps.onDelete();
        return;
      case 'ArrowUp':
        e.preventDefault();
        deps.onNavigate('up');
        return;
      case 'ArrowDown':
        e.preventDefault();
        deps.onNavigate('down');
        return;
      case 'ArrowLeft':
        e.preventDefault();
        deps.onNavigate('left');
        return;
      case 'ArrowRight':
        e.preventDefault();
        deps.onNavigate('right');
        return;
      case 'Home':
        e.preventDefault();
        deps.onSiblingEnd('first');
        return;
      case 'End':
        e.preventDefault();
        deps.onSiblingEnd('last');
        return;
      default:
        return;
    }
  };

  // 冒泡阶段绑定（绑定裁决，见文件头）
  document.addEventListener('keydown', onKeyDown, false);
  return () => document.removeEventListener('keydown', onKeyDown);
}
