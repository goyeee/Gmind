/**
 * 文本编辑覆盖层 — M1b Task 9（FR-EDT-005）。
 *
 * 绑定裁决（M1b 计划 Task 9）：
 * - open() 在 document.body 上创建绝对定位 <textarea class="gm-text-editor">，覆盖
 *   节点盒的屏幕矩形（anchorRect：页面用 viewport.toScreen 换算；anchorRect 为
 *   **页面坐标**（client + 滚动偏移），position:absolute 直接落位）：
 *   left/top = anchorRect 原点各减 4px 内边距补偿，width = max(w, 60)，
 *   height = max(h, 行高下限)，fontSize = EDITOR_BASE_FONT_SIZE × scale，
 *   1px 边框 + 白底 + 高 zIndex。创建即聚焦并全选（覆盖式输入）。
 * - IME 安全：compositionstart → composing=true，期间 input 只落本地值（不截断、
 *   不提交、Esc 不取消——组字中的按键归 IME）；compositionend → composing=false
 *   并立即做截断评估。keydown 同时看 e.isComposing（浏览器组字派发的事件自带）。
 * - 500 字截断（FR-EDT-005）：非组字输入/组字结束/提交兜底三处检查，
 *   value 超 500 → slice(0,500) 且 onTruncated() 每个截断事件恰一次；
 *   提示文案「节点文本长度已达上限」由页面层负责。
 * - 键盘：Enter（无 Shift）→ 提交并关闭，preventDefault + stopPropagation 吞掉
 *   事件（页面 Task 11 的 keydown 映射不得再次响应）；Shift+Enter → 不拦截
 *   （textarea 原生换行）；Esc → onCancel 并关闭；blur → 提交（除非已在关闭中）。
 * - close(commit)：移除监听与元素，双关闭安全（第二次为 no-op）；
 *   open 中再 open：旧编辑器按 blur 语义先提交，场上恒只有一个编辑器。
 * - onCommit 的持久化（core setText + 撤销上限）由页面层接线（Task 11）。
 */

/** 编辑器基准字号（× scale 得实际 px；分级字号差异的视觉打磨后置，M1b 统一基准）。 */
export const EDITOR_BASE_FONT_SIZE = 14;
/** 文本长度上限（超限截断 + onTruncated 提示回调）。 */
export const EDITOR_MAX_TEXT_LENGTH = 500;
/** anchorRect 原点补偿（textarea 自身内边距，文本与节点文本大致对齐）。 */
const PAD_PX = 4;
/** 宽度下限（窄节点也保住可用输入区）。 */
const MIN_WIDTH_PX = 60;
/** 高度下限（单行行高）。 */
const MIN_HEIGHT_PX = Math.ceil(EDITOR_BASE_FONT_SIZE * 1.4);
/** 覆盖层层级（高于页面一切常规层）。 */
const EDITOR_Z_INDEX = 1000;

/** open() 参数：anchorRect 为节点盒的屏幕（页面）坐标矩形。 */
export interface TextEditorOptions {
  anchorRect: { x: number; y: number; w: number; h: number };
  /** 视口缩放倍率：fontSize 随之缩放。 */
  scale: number;
  /** 初始文本。 */
  value: string;
  /** 提交（Enter / blur / 外层 close(true)）；text 已保证 ≤500 字。 */
  onCommit(text: string): void;
  /** 取消（Esc）；不回写文本。 */
  onCancel(): void;
  /** 每次发生 500 字截断回调一次（页面提示「节点文本长度已达上限」）。 */
  onTruncated(): void;
}

export class TextEditorOverlay {
  private ta: HTMLTextAreaElement | null = null;
  private composing = false;
  private closing = false;
  private opts: TextEditorOptions | null = null;

  /** 当前是否有打开的编辑器。 */
  get isOpen(): boolean {
    return this.ta !== null;
  }

  /** 创建覆盖层编辑器并聚焦全选；若已有编辑器则按 blur 语义先提交旧的。 */
  open(opts: TextEditorOptions): HTMLTextAreaElement {
    if (this.ta) this.close(true); // 焦点被夺走 ≙ blur → commit
    this.opts = opts;
    this.composing = false;
    this.closing = false;

    const fontSize = Math.max(1, Math.round(EDITOR_BASE_FONT_SIZE * opts.scale));
    const ta = document.createElement('textarea');
    ta.className = 'gm-text-editor';
    ta.value = opts.value;
    ta.spellcheck = false;
    const style = ta.style;
    style.position = 'absolute';
    style.left = `${opts.anchorRect.x - PAD_PX}px`;
    style.top = `${opts.anchorRect.y - PAD_PX}px`;
    style.width = `${Math.max(opts.anchorRect.w, MIN_WIDTH_PX)}px`;
    style.height = `${Math.max(opts.anchorRect.h, MIN_HEIGHT_PX, Math.ceil(fontSize * 1.4))}px`;
    style.fontSize = `${fontSize}px`;
    style.border = '1px solid #4a90d9';
    style.padding = '2px';
    style.margin = '0';
    style.background = 'white';
    style.color = '#1f2328';
    style.zIndex = String(EDITOR_Z_INDEX);
    style.overflow = 'hidden';
    style.resize = 'none';
    style.outline = 'none';
    style.boxSizing = 'border-box';

    ta.addEventListener('input', this.onInput);
    ta.addEventListener('compositionstart', this.onCompositionStart);
    ta.addEventListener('compositionend', this.onCompositionEnd);
    ta.addEventListener('keydown', this.onKeyDown);
    ta.addEventListener('blur', this.onBlur);

    document.body.appendChild(ta);
    this.ta = ta;
    ta.focus();
    ta.select();
    return ta;
  }

  /**
   * 关闭编辑器：commit=true → onCommit（值兜底截断到 500），false → onCancel。
   * 双关闭安全；关闭后移除全部监听与元素。
   */
  close(commit: boolean): void {
    const ta = this.ta;
    const opts = this.opts;
    if (!ta || !opts || this.closing) return;
    this.closing = true;
    ta.removeEventListener('input', this.onInput);
    ta.removeEventListener('compositionstart', this.onCompositionStart);
    ta.removeEventListener('compositionend', this.onCompositionEnd);
    ta.removeEventListener('keydown', this.onKeyDown);
    ta.removeEventListener('blur', this.onBlur);
    ta.remove();
    this.ta = null;
    this.opts = null;
    this.composing = false;
    if (commit) {
      let text = ta.value;
      if (text.length > EDITOR_MAX_TEXT_LENGTH) {
        text = text.slice(0, EDITOR_MAX_TEXT_LENGTH);
        opts.onTruncated();
      }
      opts.onCommit(text);
    } else {
      opts.onCancel();
    }
  }

  // -------------------------------------------------------------------------

  /** 截断检查：超限即就地截断并回调（每个截断事件恰一次）。 */
  private enforceLimit(): void {
    const ta = this.ta;
    const opts = this.opts;
    if (!ta || !opts) return;
    if (ta.value.length > EDITOR_MAX_TEXT_LENGTH) {
      const pos = EDITOR_MAX_TEXT_LENGTH;
      ta.value = ta.value.slice(0, pos);
      ta.setSelectionRange(pos, pos); // 光标归位到截断点
      opts.onTruncated();
    }
  }

  private onInput = (): void => {
    if (this.composing) return; // IME 组字中：仅本地态
    this.enforceLimit();
  };

  private onCompositionStart = (): void => {
    this.composing = true;
  };

  private onCompositionEnd = (): void => {
    this.composing = false;
    this.enforceLimit(); // 组字落定后立即评估截断
  };

  private onKeyDown = (e: KeyboardEvent): void => {
    if (this.composing || e.isComposing) return; // 组字中的按键（含 Enter/Esc）归 IME
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      e.stopPropagation(); // 吞掉事件：页面 keydown 映射不得再次响应
      this.close(true);
      return;
    }
    if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      this.close(false);
    }
    // Shift+Enter：不拦截，textarea 原生换行
  };

  private onBlur = (): void => {
    if (this.closing) return;
    this.close(true);
  };
}
