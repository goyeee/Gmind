/**
 * 文本编辑覆盖层 — M1b Task 9（FR-EDT-005）；2026-10-01 双框改版（需求方反馈）。
 *
 * 绑定裁决（M1b 计划 Task 9 + 2026-10-01 双框/自适应需求）：
 * - open() 在 document.body 上创建绝对定位 <textarea class="gm-text-editor">，覆盖
 *   节点盒的屏幕矩形（anchorRect：页面用 viewport.toScreen 换算；anchorRect 为
 *   **页面坐标**（client + 滚动偏移），position:absolute 直接落位）：
 *   left/top = anchorRect 原点各减 4px 内边距补偿（盒原点对位，不随 scale），
 *   width = max(w, 60)，fontSize = EDITOR_BASE_FONT_SIZE × scale，1px 边框 + 白底
 *   + 高 zIndex。创建即聚焦并全选（覆盖式输入）。
 * - **双框形态**（opts.description 提供时，2026-10-01 需求方「描述单独输入框」）：
 *   标题框下贴描述框（class gm-desc-editor，top = 标题 top + 标题落高 + DESC_GAP_PX，
 *   同宽、同 fontSize，次要文字色 + placeholder「填写描述…」由页面传入）。焦点流转
 *   对齐 mindgrid QuickEditor：标题框内 Enter/Tab → 切描述框（打开即全选预填值）；
 *   描述框 Enter → 提交两者、Tab → 提交、Shift+Tab → 回标题框、Shift+Enter → 原生
 *   换行；任一框 Esc → 取消。简洁模式（页面不传 description）保持单框，标题框
 *   Enter 直接提交（既有语义）、Tab 不拦截（原生焦点移动 → blur 提交）。
 * - **高度随内容自适应**（需求方「长文本被裁剪」根治）：任一框 input 时先落
 *   height:auto 强制重排再读 scrollHeight（CSS 保证 scrollHeight ≥ 内容实际行数，
 *   不先收回则换行增长后回删时 scrollHeight 钉在当前高上），border-box 落高补回
 *   边框（scrollHeight 含 padding 不含边框）。下限 = 打开时落高（标题=max(锚盒高，
 *   行高下限)、描述=单行行高），只增不减回下限以下。宽度自适应（scrollWidth 估宽
 *   + 视口右缘钳制）整体保留：不可破词（URL 等）横向撑宽，可换行文本纵向撑高，
 *   两向合力保证长文本完整可见；400% 等高缩放的越界由页面 clampAnchorRect 钳锚点
 *   兜底（页面层职责，见 EditorPage 同名 helper）。
 * - padding 随缩放（400% 下固定 2px 与放大后的节点文字错位）：2px × scale 四舍五入、
 *   下限 1px；left/top 的 PAD_PX=4 补偿保持不变——那是盒原点对位，不是视觉内边距。
 * - 宽度自适应（既有语义，M7c 复验钉定）：input 时先把落宽收回**初始宽度**（锚盒宽
 *   或 60，就地编辑的对位基准）强制重排，再按 scrollWidth + 左右 padding 和 +
 *   边框补偿估宽——CSS 保证 scrollWidth ≥ clientWidth，不先收回则内容变窄时
 *   scrollWidth 钉在当前宽上，删字越删越宽（2026-09-28 Kimi 复验实测 225→261 单调
 *   +6）；收回后 scrollWidth 仍不高于 clientWidth（内容窄于初始宽 / 换行不横向
 *   溢出）→ 直接保持初始宽。上限 = 视口宽 − 浮层 left − 右边距 16px。
 * - IME 安全：compositionstart → composing=true，期间 input 只落本地值（不截断、
 *   不提交、Esc 不取消——组字中的按键归 IME）；compositionend → composing=false
 *   并立即按所在框上限做截断评估。keydown 同时看 e.isComposing。
 * - 长度上限（超限截断 + 回调提示）：标题 500（EDITOR_MAX_TEXT_LENGTH，与 core
 *   MAX_TEXT_LENGTH 同值）；描述 maxLength（页面传 core MAX_DESCRIPTION_LENGTH，
 *   缺省 200 同值）。非组字输入/组字结束/提交兜底三处检查，onTruncated（标题）/
 *   description.onTruncated（描述）每个截断事件恰一次；提示文案由页面层负责。
 * - blur 提交（双框）：焦点离开**整个编辑器**（点画布/其他控件）→ 提交两者；双框
 *   互切不提交——程序切换（Tab/Enter 切框）走 switchingFocus 标记，点击切换走
 *   blur 事件 relatedTarget=兄弟框判定。
 * - close(commit)：移除监听与元素，双关闭安全（第二次为 no-op）；open 中再 open：
 *   旧编辑器按 blur 语义先提交，场上恒只有一个编辑器（双框算一个编辑器的两框）。
 * - onCommit(text, description) 的持久化（core setText+setDescription 同事务、
 *   同值守卫、空标题回收）由页面层接线。
 */

/** 编辑器基准字号（× scale 得实际 px；分级字号差异的视觉打磨后置，M1b 统一基准）。 */
export const EDITOR_BASE_FONT_SIZE = 14;
/** 标题文本长度上限（超限截断 + onTruncated 提示回调；与 core MAX_TEXT_LENGTH 同值）。 */
export const EDITOR_MAX_TEXT_LENGTH = 500;
/** 描述长度上限缺省值（与 @gmind/core MAX_DESCRIPTION_LENGTH 同口径；页面显式传参为准）。 */
export const EDITOR_MAX_DESCRIPTION_LENGTH = 200;
/** anchorRect 原点补偿（textarea 自身内边距，文本与节点文本大致对齐）。 */
const PAD_PX = 4;
/** 宽度下限（窄节点也保住可用输入区）。 */
const MIN_WIDTH_PX = 60;
/** 高度下限（单行行高）。 */
const MIN_HEIGHT_PX = Math.ceil(EDITOR_BASE_FONT_SIZE * 1.4);
/** 覆盖层层级（高于页面一切常规层）。 */
const EDITOR_Z_INDEX = 1000;
/** 宽度自适应的边框补偿：scrollWidth 不含左右边框，border-box 定宽需补回（1px×2）。 */
const BORDER_COMP_PX = 2;
/**
 * 高度自适应的边框补偿：editor.css 以 !important 把浮层边框提到 2px（M7c-D2 对齐
 * 节点选中描边），scrollHeight 只含 padding 不含边框，border-box 落高按实渲染
 * 2px×2 补偿——按内联 1px 补会差 2px，末行降部字母被裁（正是本任务要根治的「裁剪」）。
 */
const HEIGHT_BORDER_COMP_PX = 4;
/** 宽度自适应的视口右边距（防长文本把浮层撑出视口右缘）。 */
const WIDTH_MARGIN_PX = 16;
/** 描述框与标题框的垂直间距（双框堆叠；mindgrid QuickEditor 的 gap-1 同值）。 */
const DESC_GAP_PX = 4;
/** 描述框类名（e2e/样式定位锚点；标题框沿用 gm-text-editor）。 */
const DESC_EDITOR_CLASS = 'gm-desc-editor';
/** 描述框文字色（次要文案弱化，与节点描述行的层级一致；标题保持主文字色）。 */
const DESC_TEXT_COLOR = '#5f6672';

/** 编辑器自身内边距：随视口缩放同步缩放（400% 固定 2px 会与放大后的节点文字错位），下限 1px 保可用。 */
function scaledPaddingPx(scale: number): number {
  return Math.max(1, Math.round(2 * scale));
}

/** 描述框配置（双框形态，2026-10-01 需求方反馈）：缺省 = 单框（简洁模式/旧调用）。 */
export interface TextEditorDescriptionOptions {
  /** 初始描述（预填现有描述；空串显示 placeholder 占位）。 */
  value: string;
  /** 描述长度上限（页面传 core MAX_DESCRIPTION_LENGTH；缺省 200 同值兜底）。 */
  maxLength?: number;
  /** 空描述占位文案（页面传「填写描述…」）。 */
  placeholder?: string;
  /** 描述截断回调（与标题 onTruncated 分开——页面提示文案不同）。 */
  onTruncated?(): void;
}

/** open() 参数：anchorRect 为节点盒的屏幕（页面）坐标矩形。 */
export interface TextEditorOptions {
  anchorRect: { x: number; y: number; w: number; h: number };
  /** 视口缩放倍率：fontSize 随之缩放。 */
  scale: number;
  /** 初始标题文本。 */
  value: string;
  /** 双框形态：提供即渲染描述框（贴标题框正下方、同宽联动）。缺省单框。 */
  description?: TextEditorDescriptionOptions;
  /**
   * 提交（描述框 Enter / 描述框 Tab / 任一框 blur / 外层 close(true)）。
   * 第一参标题已保证 ≤500；第二参描述已保证 ≤maxLength（单框形态恒 ''）。
   */
  onCommit(text: string, description: string): void;
  /** 取消（Esc）；不回写任何文本。 */
  onCancel(): void;
  /** 每次发生标题 500 字截断回调一次（页面提示「节点文本长度已达上限」）。 */
  onTruncated(): void;
}

export class TextEditorOverlay {
  /** 标题框（单框形态下即唯一编辑框）。 */
  private ta: HTMLTextAreaElement | null = null;
  /** 描述框（双框形态才有；单框恒 null）。 */
  private descTa: HTMLTextAreaElement | null = null;
  private composing = false;
  private closing = false;
  /**
   * 双框间程序切换焦点中（标题框 Tab/Enter 切描述框、描述框 Shift+Tab 回标题框）：
   * focus() 同步派发旧框 blur——切换期间 blur 不提交，切完复位（onFocus 兜底复位）。
   */
  private switchingFocus = false;
  private opts: TextEditorOptions | null = null;
  /** 打开时的初始宽度（max(锚盒宽, 60)）：宽度自适应的不可突破下限。 */
  private baseWidthPx = MIN_WIDTH_PX;
  /** 浮层 left（页面坐标）：宽度自适应的可用上限 = 视口宽 − left − 右边距。 */
  private layerLeftPx = 0;
  /** 标题框落高下限：max(锚盒高, 单行行高, fontSize×1.4)（打开时与节点盒对位）。 */
  private titleFloorHeightPx = MIN_HEIGHT_PX;
  /** 描述框落高下限：单行行高（描述锚在标题框下方，无锚盒高可对位）。 */
  private descFloorHeightPx = MIN_HEIGHT_PX;

  /** 当前是否有打开的编辑器。 */
  get isOpen(): boolean {
    return this.ta !== null;
  }

  /** 创建覆盖层编辑器并聚焦全选标题；若已有编辑器则按 blur 语义先提交旧的。 */
  open(opts: TextEditorOptions): HTMLTextAreaElement {
    if (this.ta) this.close(true); // 焦点被夺走 ≙ blur → commit
    this.opts = opts;
    this.composing = false;
    this.closing = false;
    this.switchingFocus = false;

    const fontSize = Math.max(1, Math.round(EDITOR_BASE_FONT_SIZE * opts.scale));
    const pad = scaledPaddingPx(opts.scale);
    // 记下初始宽度与 left：前者是宽度自适应的硬下限，后者是可用上限的锚点（syncSize）。
    this.baseWidthPx = Math.max(opts.anchorRect.w, MIN_WIDTH_PX);
    this.layerLeftPx = opts.anchorRect.x - PAD_PX;
    this.titleFloorHeightPx = Math.max(
      opts.anchorRect.h,
      MIN_HEIGHT_PX,
      Math.ceil(fontSize * 1.4),
    );
    this.descFloorHeightPx = Math.max(MIN_HEIGHT_PX, Math.ceil(fontSize * 1.4));

    const ta = this.createBox({
      className: 'gm-text-editor',
      value: opts.value,
      fontSize,
      pad,
      left: this.layerLeftPx,
      top: opts.anchorRect.y - PAD_PX,
      width: this.baseWidthPx,
      height: this.titleFloorHeightPx,
    });
    document.body.appendChild(ta);
    this.ta = ta;

    // 双框形态：描述框贴标题框正下方（top = 标题 top + 标题落高 + 间距），同宽同字号；
    // syncSize 会按标题实高复核 top（标题预填多行撑高时描述框随动下移，不压字）。
    if (opts.description) {
      const desc = this.createBox({
        className: DESC_EDITOR_CLASS,
        value: opts.description.value,
        fontSize,
        pad,
        left: this.layerLeftPx,
        top: opts.anchorRect.y - PAD_PX + this.titleFloorHeightPx + DESC_GAP_PX,
        width: this.baseWidthPx,
        height: this.descFloorHeightPx,
        color: DESC_TEXT_COLOR,
      });
      if (opts.description.placeholder) desc.placeholder = opts.description.placeholder;
      desc.setAttribute('aria-label', '节点描述');
      document.body.appendChild(desc);
      this.descTa = desc;
    }

    this.attachListeners(ta);
    if (this.descTa) this.attachListeners(this.descTa);
    this.syncSize(); // 打开即按预填内容校一次宽高（长标题/长描述不被裁，宽度对齐既有语义）
    ta.focus();
    ta.select();
    return ta;
  }

  /**
   * 关闭编辑器：commit=true → onCommit（标题兜底截断到 500、描述兜底截断到
   * maxLength），false → onCancel。双关闭安全；关闭后移除全部监听与元素。
   */
  close(commit: boolean): void {
    const ta = this.ta;
    const descTa = this.descTa;
    const opts = this.opts;
    if (!ta || !opts || this.closing) return;
    this.closing = true;
    for (const el of [ta, descTa]) {
      if (!el) continue;
      el.removeEventListener('input', this.onInput);
      el.removeEventListener('compositionstart', this.onCompositionStart);
      el.removeEventListener('compositionend', this.onCompositionEnd);
      el.removeEventListener('keydown', this.onKeyDown);
      el.removeEventListener('blur', this.onBlur);
      el.removeEventListener('focus', this.onFocus);
      el.remove();
    }
    this.ta = null;
    this.descTa = null;
    this.opts = null;
    this.composing = false;
    this.switchingFocus = false;
    if (commit) {
      let text = ta.value;
      if (text.length > EDITOR_MAX_TEXT_LENGTH) {
        text = text.slice(0, EDITOR_MAX_TEXT_LENGTH);
        opts.onTruncated();
      }
      let desc = descTa?.value ?? ''; // 单框形态恒 ''（页面 setDescription('') 走同值守卫零写入）
      const descMax = opts.description?.maxLength ?? EDITOR_MAX_DESCRIPTION_LENGTH;
      if (desc.length > descMax) {
        desc = desc.slice(0, descMax);
        opts.description?.onTruncated?.();
      }
      opts.onCommit(text, desc);
    } else {
      opts.onCancel();
    }
  }

  // -------------------------------------------------------------------------

  /** 创建一个覆盖层 textarea（标题/描述共用样式基底，差异以入参表达）。 */
  private createBox(init: {
    className: string;
    value: string;
    fontSize: number;
    pad: number;
    left: number;
    top: number;
    width: number;
    height: number;
    color?: string;
  }): HTMLTextAreaElement {
    const ta = document.createElement('textarea');
    ta.className = init.className;
    ta.value = init.value;
    ta.spellcheck = false;
    ta.rows = 1; // 高度自适应的测量基准：auto 态按单行起量（rows 缺省 2 会让单行内容虚高一倍）
    const style = ta.style;
    style.position = 'absolute';
    style.left = `${init.left}px`;
    style.top = `${init.top}px`;
    style.width = `${init.width}px`;
    style.height = `${init.height}px`;
    style.fontSize = `${init.fontSize}px`;
    style.border = '1px solid #4a90d9';
    style.padding = `${init.pad}px`;
    style.margin = '0';
    style.background = 'white';
    style.color = init.color ?? '#1f2328';
    style.zIndex = String(EDITOR_Z_INDEX);
    style.overflow = 'hidden';
    style.resize = 'none';
    style.outline = 'none';
    style.boxSizing = 'border-box';
    return ta;
  }

  private attachListeners(ta: HTMLTextAreaElement): void {
    ta.addEventListener('input', this.onInput);
    ta.addEventListener('compositionstart', this.onCompositionStart);
    ta.addEventListener('compositionend', this.onCompositionEnd);
    ta.addEventListener('keydown', this.onKeyDown);
    ta.addEventListener('blur', this.onBlur);
    ta.addEventListener('focus', this.onFocus);
  }

  /** 截断检查（按所在框上限：标题 500 / 描述 maxLength）：超限就地截断并回调恰一次。 */
  private enforceLimit(ta: HTMLTextAreaElement): void {
    const opts = this.opts;
    if (!opts) return;
    const isDesc = ta === this.descTa;
    const max = isDesc
      ? opts.description?.maxLength ?? EDITOR_MAX_DESCRIPTION_LENGTH
      : EDITOR_MAX_TEXT_LENGTH;
    if (ta.value.length > max) {
      ta.value = ta.value.slice(0, max);
      ta.setSelectionRange(max, max); // 光标归位到截断点
      if (isDesc) opts.description?.onTruncated?.();
      else opts.onTruncated();
    }
  }

  /**
   * 尺寸随内容自适应（纯视觉，不动值/提交/IME 语义），打开与每次 input 调用：
   * ① 标题宽：先收回下限宽强制重排，再读 scrollWidth 估宽（既有 syncWidth 语义，
   *   详见类头注——不收回则删字越删越宽）；上限 = 视口宽 − left − 右边距。
   * ② 描述框同宽：双框堆叠如一张卡片（mindgrid QuickEditor 同构），宽度取标题框现宽。
   * ③ 高度：先落 height:auto 强制重排再读 scrollHeight（同「先收回再测量」道理——
   *   不收回则 scrollHeight 钉在当前高上，回删内容框不回缩），border-box 落高补回
   *   实渲染边框（见 HEIGHT_BORDER_COMP_PX）；下限 = 打开时落高，只增不减。
   * ④ 描述框 top 跟随标题框实高：标题预填多行撑高后描述框下移，恒距 DESC_GAP_PX。
   */
  private syncSize(): void {
    const ta = this.ta;
    const opts = this.opts;
    if (!ta || !opts) return;
    const pad = scaledPaddingPx(opts.scale);
    ta.style.width = `${this.baseWidthPx}px`; // 收回下限宽强制重排：scrollWidth 摆脱当前宽钳制
    const desired =
      ta.scrollWidth > ta.clientWidth
        ? ta.scrollWidth + pad * 2 + BORDER_COMP_PX
        : this.baseWidthPx;
    const maxW = window.innerWidth - this.layerLeftPx - WIDTH_MARGIN_PX;
    const titleW = Math.max(this.baseWidthPx, Math.min(desired, maxW));
    ta.style.width = `${titleW}px`;

    const desc = this.descTa;
    if (desc) desc.style.width = `${titleW}px`;
    this.syncHeight(ta, this.titleFloorHeightPx);
    if (desc) {
      this.syncHeight(desc, this.descFloorHeightPx);
      desc.style.top = `${
        Number.parseFloat(ta.style.top) + Number.parseFloat(ta.style.height) + DESC_GAP_PX
      }px`;
    }
  }

  /** 单框高度自适应：auto 起量读 scrollHeight（jsdom 无布局恒 0 → 落到下限），border-box 补边框。 */
  private syncHeight(ta: HTMLTextAreaElement, floorPx: number): void {
    ta.style.height = 'auto'; // 收回落高强制重排：scrollHeight 反映内容实际行数
    ta.style.height = `${Math.max(ta.scrollHeight + HEIGHT_BORDER_COMP_PX, floorPx)}px`;
  }

  /** 焦点切到描述框（标题框 Tab/Enter）：程序切换期间标题框 blur 不提交；打开即全选（预填续写/覆盖两便，旧「Tab 直填描述」同语义）。 */
  private focusDescription(): void {
    const desc = this.descTa;
    if (!desc) return;
    this.switchingFocus = true;
    desc.focus();
    this.switchingFocus = false;
    desc.select();
  }

  /** 焦点切回标题框（描述框 Shift+Tab）：同上，blur 不提交。 */
  private focusTitle(): void {
    const ta = this.ta;
    if (!ta) return;
    this.switchingFocus = true;
    ta.focus();
    this.switchingFocus = false;
  }

  private onInput = (e: Event): void => {
    const el = e.target as HTMLTextAreaElement;
    if (!this.composing) this.enforceLimit(el); // IME 组字中：仅本地态，不截断
    this.syncSize(); // 宽高随内容：组字中也随动（视觉层调整，不动值）
  };

  private onCompositionStart = (): void => {
    this.composing = true;
  };

  private onCompositionEnd = (e: CompositionEvent): void => {
    this.composing = false;
    this.enforceLimit(e.target as HTMLTextAreaElement); // 组字落定后立即评估截断
    this.syncSize(); // 组字落定的文本尺寸可能变化，兜底随动一次（常规路径 input 已同步）
  };

  private onKeyDown = (e: KeyboardEvent): void => {
    if (this.composing || e.isComposing) return; // 组字中的按键（含 Enter/Esc）归 IME
    const fromDesc = this.descTa !== null && e.target === this.descTa;
    if (fromDesc) {
      // —— 描述框（双框形态，需求方口径）：Enter 提交两者、Esc 取消、Shift+Enter
      //    原生换行；Tab 提交（mindgrid QuickEditor 同款「描述框 Tab=提交」）、
      //    Shift+Tab 回标题框（可逆导航）。
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
        return;
      }
      if (e.key === 'Tab') {
        e.preventDefault();
        e.stopPropagation();
        if (e.shiftKey) this.focusTitle();
        else this.close(true);
      }
      return; // Shift+Enter 不拦截：textarea 原生换行
    }
    // —— 标题框：双框形态 Enter/Tab 切描述框（2026-10-01 需求方，替代旧「提交后
    //    Tab 直填描述」机制）；单框形态（简洁模式）保持 Enter 提交既有语义，Tab
    //    不拦截（原生焦点移动 → blur 提交）。
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      e.stopPropagation();
      if (this.descTa) this.focusDescription();
      else this.close(true);
      return;
    }
    if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      this.close(false);
      return;
    }
    if (e.key === 'Tab' && this.descTa) {
      e.preventDefault();
      e.stopPropagation();
      this.focusDescription();
      return;
    }
    // Shift+Enter：不拦截，textarea 原生换行（标题多行，500 字上限兜底）
  };

  private onFocus = (): void => {
    this.switchingFocus = false; // 切框落定（程序切换复位；点击切换本就无标记）
  };

  private onBlur = (e: FocusEvent): void => {
    if (this.closing || this.switchingFocus) return;
    // 双框互切（用户点击另一框：真浏览器 blur 事件带 relatedTarget=兄弟框）不提交
    const sibling = e.target === this.descTa ? this.ta : this.descTa;
    if (sibling && e.relatedTarget === sibling) return;
    this.close(true); // 焦点离开整个编辑器（点画布/其他控件）→ 提交两者
  };
}
