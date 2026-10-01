import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  TextEditorOverlay,
  EDITOR_BASE_FONT_SIZE,
  EDITOR_MAX_DESCRIPTION_LENGTH,
} from './texteditor';

let onCommit: ReturnType<typeof vi.fn>;
let onCancel: ReturnType<typeof vi.fn>;
let onTruncated: ReturnType<typeof vi.fn>;
let onDescTruncated: ReturnType<typeof vi.fn>;
let overlay: TextEditorOverlay;

beforeEach(() => {
  document.body.innerHTML = '';
  overlay = new TextEditorOverlay();
  onCommit = vi.fn();
  onCancel = vi.fn();
  onTruncated = vi.fn();
  onDescTruncated = vi.fn();
});

interface OpenOpts {
  anchorRect?: { x: number; y: number; w: number; h: number };
  scale?: number;
  value?: string;
  /** 双框形态：传即渲染描述框（缺省单框=简洁模式/旧调用）。 */
  description?: { value?: string; maxLength?: number; placeholder?: string };
}

function open(opts: OpenOpts | string = {}): HTMLTextAreaElement {
  const o: OpenOpts = typeof opts === 'string' ? { value: opts } : opts;
  return overlay.open({
    anchorRect: o.anchorRect ?? { x: 100, y: 50, w: 120, h: 24 },
    scale: o.scale ?? 1,
    value: o.value ?? 'hello',
    description: o.description
      ? {
          value: o.description.value ?? '',
          maxLength: o.description.maxLength,
          placeholder: o.description.placeholder,
          onTruncated: () => onDescTruncated(),
        }
      : undefined,
    onCommit: (t, d) => onCommit(t, d),
    onCancel: () => onCancel(),
    onTruncated: () => onTruncated(),
  });
}

function key(type: string, init: KeyboardEventInit = {}): KeyboardEvent {
  return new KeyboardEvent(type, { bubbles: true, cancelable: true, ...init });
}

/** 双框形态下的描述框（class gm-desc-editor）。 */
function descBox(): HTMLTextAreaElement {
  return document.querySelector('.gm-desc-editor') as HTMLTextAreaElement;
}

describe('TextEditorOverlay open（FR-EDT-005 覆盖层）', () => {
  it('在 body 创建 textarea.gm-text-editor，聚焦全选，值预填', () => {
    const ta = open();
    expect(ta).toBeInstanceOf(HTMLTextAreaElement);
    expect(ta.classList.contains('gm-text-editor')).toBe(true);
    expect(ta.parentElement).toBe(document.body);
    expect(document.activeElement).toBe(ta);
    expect(ta.value).toBe('hello');
    expect(ta.selectionStart).toBe(0);
    expect(ta.selectionEnd).toBe('hello'.length);
  });

  it('单框形态（不传 description）不渲染描述框', () => {
    open();
    expect(document.querySelector('.gm-desc-editor')).toBeNull();
  });

  it('样式随 anchorRect/scale 同步：定位、宽高下限、fontSize = base × scale', () => {
    const ta = open({ anchorRect: { x: 100, y: 50, w: 40, h: 24 }, scale: 2 });
    expect(ta.style.position).toBe('absolute');
    expect(ta.style.left).toBe('96px'); // anchorRect.x - 4 内边距
    expect(ta.style.top).toBe('46px');
    expect(ta.style.width).toBe('60px'); // max(w, 60) 下限
    expect(ta.style.fontSize).toBe(`${EDITOR_BASE_FONT_SIZE * 2}px`);
    expect(Number(ta.style.zIndex)).toBeGreaterThan(0);
    expect(ta.style.borderWidth).toBe('1px');
  });

  it('input 事件只改本地值，不触发提交', () => {
    const ta = open();
    ta.value = 'abc';
    ta.dispatchEvent(new Event('input'));
    expect(onCommit).not.toHaveBeenCalled();
    expect(onCancel).not.toHaveBeenCalled();
    expect(ta.isConnected).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 双框形态（2026-10-01 需求方反馈：描述单独输入框，mindgrid QuickEditor 对齐）
// ---------------------------------------------------------------------------

describe('TextEditorOverlay 双框形态', () => {
  it('提供 description 即渲染描述框：class/prefill/placeholder/aria 齐备，标题框仍聚焦全选', () => {
    const ta = open({ value: '标题', description: { value: '旧描述', placeholder: '填写描述…' } });
    const desc = descBox();
    expect(desc).toBeInstanceOf(HTMLTextAreaElement);
    expect(desc.parentElement).toBe(document.body);
    expect(desc.value).toBe('旧描述'); // 预填现有描述
    expect(desc.placeholder).toBe('填写描述…'); // 空时占位由页面传入
    expect(desc.getAttribute('aria-label')).toBe('节点描述');
    expect(desc.classList.contains('gm-text-editor')).toBe(false); // e2e 选择器互斥：标题/描述各一套类
    expect(document.activeElement).toBe(ta); // 焦点仍在标题框（描述框不抢焦）
    expect(ta.selectionEnd).toBe('标题'.length);
  });

  it('描述框贴标题框下：top = 标题 top + 标题落高 + 4px 间距，同 left 同宽', () => {
    const ta = open({
      anchorRect: { x: 100, y: 50, w: 120, h: 24 },
      scale: 1,
      description: {},
    });
    const desc = descBox();
    expect(ta.style.top).toBe('46px'); // anchorRect.y - 4
    expect(ta.style.height).toBe('24px'); // 落高下限 = max(锚盒高, 行高)（jsdom scrollHeight=0 → 下限）
    expect(desc.style.top).toBe('74px'); // 46 + 24 + 4（DESC_GAP_PX）
    expect(desc.style.left).toBe(ta.style.left);
    expect(desc.style.width).toBe(ta.style.width);
    expect(desc.style.fontSize).toBe(ta.style.fontSize); // 同字号（视觉一套卡片）
  });

  it('标题框 Enter/Tab → 切描述框（打开即全选预填值），不提交', () => {
    open({ value: '标题', description: { value: '旧描述' } });
    const desc = descBox();
    for (const k of ['Enter', 'Tab']) {
      const e = key('keydown', { key: k });
      (document.querySelector('.gm-text-editor') as HTMLTextAreaElement).dispatchEvent(e);
      expect(e.defaultPrevented).toBe(true);
      expect(document.activeElement).toBe(desc);
      expect(desc.selectionStart).toBe(0); // 全选：续写/覆盖两便（旧「Tab 直填描述」同语义）
      expect(desc.selectionEnd).toBe('旧描述'.length);
      expect(onCommit).not.toHaveBeenCalled();
      // 切回标题框再试下一个键位
      const eBack = key('keydown', { key: 'Tab', shiftKey: true });
      desc.dispatchEvent(eBack);
      expect(document.activeElement).toBe(
        document.querySelector('.gm-text-editor'),
      );
    }
  });

  it('描述框 Enter → 提交两者（标题+描述现值）并关闭', () => {
    open({ value: '标题', description: { value: '一句话' } });
    const e = key('keydown', { key: 'Enter' });
    descBox().dispatchEvent(e);
    expect(e.defaultPrevented).toBe(true);
    expect(onCommit).toHaveBeenCalledTimes(1);
    expect(onCommit).toHaveBeenCalledWith('标题', '一句话');
    expect(document.querySelector('.gm-text-editor')).toBeNull();
    expect(document.querySelector('.gm-desc-editor')).toBeNull();
  });

  it('描述框 Tab → 提交两者（mindgrid「描述框 Tab=提交」同款）；Shift+Tab → 回标题框不提交', () => {
    open({ value: '标题', description: { value: '一句话' } });
    const tab = key('keydown', { key: 'Tab' });
    descBox().dispatchEvent(tab);
    expect(onCommit).toHaveBeenCalledWith('标题', '一句话');

    open({ value: '标题二', description: { value: '描述二' } });
    const shiftTab = key('keydown', { key: 'Tab', shiftKey: true });
    descBox().dispatchEvent(shiftTab);
    expect(onCommit).toHaveBeenCalledTimes(1); // 第二个编辑器未提交（仅首个 Tab 提交过一次）
    expect(onCommit).toHaveBeenCalledWith('标题', '一句话');
    expect(document.activeElement).toBe(document.querySelector('.gm-text-editor'));
  });

  it('描述框 Esc → 取消（不提交任何框的值）；Shift+Enter → 原生换行不拦截不提交', () => {
    open({ value: '标题', description: { value: '' } });
    const esc = key('keydown', { key: 'Escape' });
    descBox().dispatchEvent(esc);
    expect(onCancel).toHaveBeenCalledTimes(1);
    expect(onCommit).not.toHaveBeenCalled();

    open({ description: {} });
    const shiftEnter = key('keydown', { key: 'Enter', shiftKey: true });
    descBox().dispatchEvent(shiftEnter);
    expect(shiftEnter.defaultPrevented).toBe(false); // 不拦截：textarea 原生换行
    expect(onCommit).not.toHaveBeenCalled();
    expect(overlay.isOpen).toBe(true);
  });

  it('双框互切（blur relatedTarget=兄弟框）不提交；焦点真正离开（relatedTarget 空/他元素）→ 提交两者', () => {
    const ta = open({ value: '标题', description: { value: '描述' } });
    const desc = descBox();
    // 标题 blur → 描述（点击切框）：relatedTarget 指向兄弟框，不提交
    ta.dispatchEvent(new FocusEvent('blur', { relatedTarget: desc }));
    expect(onCommit).not.toHaveBeenCalled();
    expect(overlay.isOpen).toBe(true);
    // 描述 blur → 画布（relatedTarget 非兄弟框）：提交两者
    desc.value = '改成的新描述';
    desc.dispatchEvent(new FocusEvent('blur', { relatedTarget: document.body }));
    expect(onCommit).toHaveBeenCalledTimes(1);
    expect(onCommit).toHaveBeenCalledWith('标题', '改成的新描述');
  });

  it('双框数值在 blur/提交时实时读取（标题框后改的值一并提交）', () => {
    const ta = open({ value: '旧标题', description: { value: '' } });
    ta.value = '新标题';
    const desc = descBox();
    desc.focus();
    desc.dispatchEvent(new FocusEvent('blur', { relatedTarget: null })); // 描述失焦=离开编辑器
    expect(onCommit).toHaveBeenCalledWith('新标题', '');
  });

  it('单框形态：Tab 不拦截（原生焦点移动）；Enter 仍直接提交（既有语义）', () => {
    const ta = open('hello');
    const tab = key('keydown', { key: 'Tab' });
    ta.dispatchEvent(tab);
    expect(tab.defaultPrevented).toBe(false); // 简洁模式无双框流转
    expect(overlay.isOpen).toBe(true);
    const enter = key('keydown', { key: 'Enter' });
    ta.dispatchEvent(enter);
    expect(onCommit).toHaveBeenCalledWith('hello', ''); // 单框描述恒 ''
  });
});

describe('TextEditorOverlay 500 字截断（FR-EDT-005）', () => {
  it('非 IME 输入超 500 字 → 截断为 500 并回调 onTruncated（每次截断事件一次）', () => {
    const ta = open();
    ta.value = 'x'.repeat(501);
    ta.dispatchEvent(new Event('input'));
    expect(ta.value).toBe('x'.repeat(500));
    expect(onTruncated).toHaveBeenCalledTimes(1);
    // 之后再正常输入不再重复回调
    ta.value = 'y';
    ta.dispatchEvent(new Event('input'));
    expect(onTruncated).toHaveBeenCalledTimes(1);
  });

  it('composition 期间仅本地态不截断；compositionend 后截断并回调', () => {
    const ta = open();
    ta.dispatchEvent(new CompositionEvent('compositionstart'));
    ta.value = 'x'.repeat(501);
    ta.dispatchEvent(new Event('input'));
    expect(ta.value.length).toBe(501); // IME 组字中不动值
    expect(onTruncated).not.toHaveBeenCalled();
    ta.dispatchEvent(new CompositionEvent('compositionend'));
    expect(ta.value.length).toBe(500);
    expect(onTruncated).toHaveBeenCalledTimes(1);
  });

  it('close(true) 兜底截断：提交值恒 ≤500', () => {
    const ta = open();
    ta.value = 'z'.repeat(600); // 绕过 input（防御路径）
    overlay.close(true);
    expect(onCommit).toHaveBeenCalledWith('z'.repeat(500), '');
    expect(onTruncated).toHaveBeenCalledTimes(1);
  });
});

// ---------------------------------------------------------------------------
// 描述上限截断（maxLength；页面传 core MAX_DESCRIPTION_LENGTH，缺省 200 同值）
// ---------------------------------------------------------------------------

describe('TextEditorOverlay 描述截断', () => {
  it('缺省上限 200（与 core MAX_DESCRIPTION_LENGTH 同口径）：超限截断并回调 onDescTruncated', () => {
    open({ description: {} });
    const descTa = descBox();
    descTa.value = '描'.repeat(EDITOR_MAX_DESCRIPTION_LENGTH + 1);
    descTa.dispatchEvent(new Event('input'));
    expect(descTa.value.length).toBe(EDITOR_MAX_DESCRIPTION_LENGTH);
    expect(onDescTruncated).toHaveBeenCalledTimes(1);
    expect(onTruncated).not.toHaveBeenCalled(); // 标题回调不串台
  });

  it('自定义 maxLength 生效；IME 组字中不动值、compositionend 后截断', () => {
    open({ description: { maxLength: 10 } });
    const descTa = descBox();
    descTa.dispatchEvent(new CompositionEvent('compositionstart'));
    descTa.value = 'd'.repeat(11);
    descTa.dispatchEvent(new Event('input'));
    expect(descTa.value.length).toBe(11); // 组字中不截断
    expect(onDescTruncated).not.toHaveBeenCalled();
    descTa.dispatchEvent(new CompositionEvent('compositionend'));
    expect(descTa.value.length).toBe(10);
    expect(onDescTruncated).toHaveBeenCalledTimes(1);
  });

  it('close(true) 兜底：描述提交值恒 ≤maxLength，回调恰一次', () => {
    open({ description: { maxLength: 5 } });
    descBox().value = 'd'.repeat(9); // 绕过 input（防御路径）
    overlay.close(true);
    expect(onCommit).toHaveBeenCalledWith('hello', 'd'.repeat(5));
    expect(onDescTruncated).toHaveBeenCalledTimes(1);
  });

  it('标题/描述各自独立截断：标题超 500 只回调 onTruncated，描述不受影响', () => {
    open({ value: 'x'.repeat(501), description: { value: '短描述' } });
    const ta = document.querySelector('.gm-text-editor') as HTMLTextAreaElement;
    ta.dispatchEvent(new Event('input'));
    expect(ta.value.length).toBe(500);
    expect(onTruncated).toHaveBeenCalledTimes(1);
    expect(onDescTruncated).not.toHaveBeenCalled();
    expect(descBox().value).toBe('短描述');
  });
});

describe('TextEditorOverlay 键盘语义（FR-EDT-005，单框/标题框）', () => {
  it('Enter（无 Shift）→ 提交并关闭，事件被吞（defaultPrevented）', () => {
    const ta = open('hello');
    const e = key('keydown', { key: 'Enter' });
    ta.dispatchEvent(e);
    expect(e.defaultPrevented).toBe(true);
    expect(onCommit).toHaveBeenCalledTimes(1);
    expect(onCommit).toHaveBeenCalledWith('hello', '');
    expect(document.querySelector('.gm-text-editor')).toBeNull();
  });

  it('Shift+Enter → 换行不提交（textarea 原生行为，不拦截）', () => {
    const ta = open('a');
    const e = key('keydown', { key: 'Enter', shiftKey: true });
    ta.dispatchEvent(e);
    expect(e.defaultPrevented).toBe(false);
    expect(onCommit).not.toHaveBeenCalled();
    expect(ta.isConnected).toBe(true);
  });

  it('Esc → onCancel 并关闭，不触发 commit', () => {
    const ta = open();
    ta.dispatchEvent(key('keydown', { key: 'Escape' }));
    expect(onCancel).toHaveBeenCalledTimes(1);
    expect(onCommit).not.toHaveBeenCalled();
    expect(document.querySelector('.gm-text-editor')).toBeNull();
  });

  it('composition 期间 Esc 交给 IME（不取消、不关闭）', () => {
    const ta = open();
    ta.dispatchEvent(new CompositionEvent('compositionstart'));
    ta.dispatchEvent(key('keydown', { key: 'Escape' }));
    expect(onCancel).not.toHaveBeenCalled();
    expect(ta.isConnected).toBe(true);
  });

  it('blur → 提交', () => {
    const ta = open('world');
    ta.dispatchEvent(new Event('blur'));
    expect(onCommit).toHaveBeenCalledTimes(1);
    expect(onCommit).toHaveBeenCalledWith('world', '');
    expect(document.querySelector('.gm-text-editor')).toBeNull();
  });
});

describe('TextEditorOverlay 生命周期', () => {
  it('close 后再 close（双关闭）不重复回调', () => {
    open('v');
    overlay.close(true);
    expect(onCommit).toHaveBeenCalledTimes(1);
    overlay.close(true);
    overlay.close(false);
    expect(onCommit).toHaveBeenCalledTimes(1);
    expect(onCancel).not.toHaveBeenCalled();
  });

  it('Esc 关闭后 blur 不再提交（监听已随 close 移除）', () => {
    const ta = open('v');
    ta.dispatchEvent(key('keydown', { key: 'Escape' }));
    expect(onCancel).toHaveBeenCalledTimes(1);
    ta.dispatchEvent(new Event('blur'));
    expect(onCommit).not.toHaveBeenCalled();
    expect(onCancel).toHaveBeenCalledTimes(1);
  });

  it('open 中再 open：旧编辑器按 blur 语义先提交，场上仅一个编辑器（双框同清）', () => {
    open('first');
    open({ value: 'second', description: {} });
    expect(onCommit).toHaveBeenCalledWith('first', '');
    expect(document.querySelectorAll('.gm-text-editor').length).toBe(1);
    expect(document.querySelectorAll('.gm-desc-editor').length).toBe(1); // 旧描述框随关闭移除
  });
});

// ---------------------------------------------------------------------------
// padding 随视口缩放（400% 固定 2px 与节点文字错位）
// ---------------------------------------------------------------------------

describe('TextEditorOverlay padding 随缩放', () => {
  it('400% 缩放 → padding 8px（2 × scale）；left/top 的 4px 锚定补偿不变', () => {
    const ta = open({ anchorRect: { x: 100, y: 50, w: 40, h: 24 }, scale: 4 });
    expect(ta.style.padding).toBe('8px');
    expect(ta.style.left).toBe('96px'); // PAD_PX=4 盒原点对位，不随 scale
    expect(ta.style.top).toBe('46px');
  });

  it('100% 缩放 → padding 2px（与旧行为一致）', () => {
    expect(open({ scale: 1 }).style.padding).toBe('2px');
  });

  it('缩放 < 0.5 → padding 有 1px 下限', () => {
    expect(open({ scale: 0.4 }).style.padding).toBe('1px');
  });

  it('双框形态描述框 padding/字号随缩放同步，top 按放大后的标题落高下移', () => {
    open({ anchorRect: { x: 100, y: 50, w: 40, h: 24 }, scale: 4, description: {} });
    const desc = descBox();
    expect(desc.style.padding).toBe('8px');
    expect(desc.style.fontSize).toBe(`${EDITOR_BASE_FONT_SIZE * 4}px`);
    // 标题落高下限 = max(24, 20, ceil(56×1.4)=79) = 79 → desc top = 46 + 79 + 4
    expect(desc.style.top).toBe('129px');
  });
});

// ---------------------------------------------------------------------------
// 宽度随内容自适应（初始宽度 = max(锚盒宽, 60) 为硬下限）
// ---------------------------------------------------------------------------

describe('TextEditorOverlay 宽度随内容自适应', () => {
  const DEFAULT_INNER_WIDTH = 1024; // jsdom 默认视口宽

  afterEach(() => {
    Object.defineProperty(window, 'innerWidth', {
      value: DEFAULT_INNER_WIDTH,
      configurable: true,
    });
  });

  /** jsdom 无布局引擎（scrollWidth 恒 0）：按值打桩模拟内容宽度。 */
  function mockScrollWidth(ta: HTMLTextAreaElement, value: number): void {
    Object.defineProperty(ta, 'scrollWidth', { value, configurable: true });
  }

  function setViewportWidth(w: number): void {
    Object.defineProperty(window, 'innerWidth', { value: w, configurable: true });
  }

  function input(ta: HTMLTextAreaElement): void {
    ta.dispatchEvent(new Event('input'));
  }

  it('内容超初始宽 → 增宽为 scrollWidth + padding 和 + 2px 边框补偿', () => {
    setViewportWidth(2000);
    const ta = open({ anchorRect: { x: 100, y: 50, w: 120, h: 24 }, scale: 1 });
    expect(ta.style.width).toBe('120px'); // 初始 = max(锚盒宽, 60)
    mockScrollWidth(ta, 400);
    input(ta);
    // 400 + 2×2(padding) + 2(边框) = 406，未触上限
    expect(ta.style.width).toBe('406px');
  });

  it('删字后收窄，但不得窄于初始宽度（锚定盒宽是就地编辑的对位基准）', () => {
    setViewportWidth(2000);
    const ta = open({ anchorRect: { x: 100, y: 50, w: 120, h: 24 }, scale: 1 });
    mockScrollWidth(ta, 400);
    input(ta);
    expect(ta.style.width).toBe('406px');
    mockScrollWidth(ta, 30);
    input(ta);
    expect(ta.style.width).toBe('120px'); // 收窄回初始宽度为止
  });

  it('逐字删除：宽度单调回落至初始宽度，绝不反向膨胀（CSS scrollWidth≥clientWidth 语义钉定）', () => {
    setViewportWidth(2000);
    const ta = open({ anchorRect: { x: 100, y: 50, w: 120, h: 24 }, scale: 1 });
    // 真实浏览器语义：scrollWidth = max(内容宽, clientWidth)——内容变窄时钉在当前
    // clientWidth 上。jsdom 无布局引擎，clientWidth 按已落宽模拟（border-box：
    // 应用宽 − 2×1px 边框）。
    let contentW = 0;
    const clientWidthOf = (): number => Number.parseFloat(ta.style.width) - 2;
    Object.defineProperty(ta, 'clientWidth', { get: clientWidthOf, configurable: true });
    Object.defineProperty(ta, 'scrollWidth', {
      get: () => Math.max(contentW, clientWidthOf()),
      configurable: true,
    });
    // 逐字输入（内容 30→400px）：宽度随内容增长
    const grown: number[] = [];
    for (let n = 3; n <= 40; n += 1) {
      contentW = n * 10;
      input(ta);
      grown.push(Number.parseFloat(ta.style.width));
    }
    for (let i = 1; i < grown.length; i += 1) {
      expect(grown[i]).toBeGreaterThanOrEqual(grown[i - 1]);
    }
    expect(grown[grown.length - 1]).toBeGreaterThan(120); // 长内容确实撑宽过
    // 逐字删除（内容 390→0px）：宽度必须单调回落至初始宽。不先收回落宽就测量时
    // scrollWidth 钉在当前 clientWidth，desired 恒大于当前宽——每删一字反涨
    // pad×2+边框（Kimi 复验 225→231→…→261），旧实现下本断言必红。
    const shrunk: number[] = [];
    for (let n = 39; n >= 0; n -= 1) {
      contentW = n * 10;
      input(ta);
      shrunk.push(Number.parseFloat(ta.style.width));
    }
    for (let i = 1; i < shrunk.length; i += 1) {
      expect(shrunk[i]).toBeLessThanOrEqual(shrunk[i - 1]);
    }
    expect(shrunk[shrunk.length - 1]).toBe(120); // 清空后回到初始宽度
  });

  it('上限 = 视口宽 − 浮层 left − 16px 右边距：长文本不撑出视口', () => {
    setViewportWidth(1024);
    // left = 600 − 4 = 596；上限 = 1024 − 596 − 16 = 412
    const ta = open({ anchorRect: { x: 600, y: 50, w: 120, h: 24 }, scale: 1 });
    mockScrollWidth(ta, 5000);
    input(ta);
    expect(ta.style.width).toBe('412px');
  });

  it('新建空节点（锚盒 40px，初始 60px）：窄内容不收窄、保持初始宽度', () => {
    setViewportWidth(2000);
    const ta = open({ anchorRect: { x: 0, y: 0, w: 40, h: 24 }, scale: 1 });
    expect(ta.style.width).toBe('60px');
    mockScrollWidth(ta, 30);
    input(ta);
    expect(ta.style.width).toBe('60px');
  });

  it('IME 组字中宽度亦随动（纯视觉：不动值、不截断、不提交）', () => {
    setViewportWidth(2000);
    const ta = open({ anchorRect: { x: 100, y: 50, w: 120, h: 24 }, scale: 1 });
    ta.dispatchEvent(new CompositionEvent('compositionstart'));
    ta.value = 'x'.repeat(501); // 组字中不截断（既有语义）
    mockScrollWidth(ta, 400);
    input(ta);
    expect(ta.style.width).toBe('406px');
    expect(ta.value).toBe('x'.repeat(501));
    expect(onTruncated).not.toHaveBeenCalled();
    expect(onCommit).not.toHaveBeenCalled();
  });

  it('双框：描述框宽度跟随标题框现宽（同宽卡片，mindgrid QuickEditor 同构）', () => {
    setViewportWidth(2000);
    const ta = open({ anchorRect: { x: 100, y: 50, w: 120, h: 24 }, scale: 1, description: {} });
    const desc = descBox();
    mockScrollWidth(ta, 400);
    input(ta);
    expect(ta.style.width).toBe('406px');
    expect(desc.style.width).toBe('406px'); // 描述框同宽联动
  });
});

// ---------------------------------------------------------------------------
// 高度随内容自适应（2026-10-01 需求方「长文本被裁剪」根治）
// ---------------------------------------------------------------------------

describe('TextEditorOverlay 高度随内容自适应', () => {
  /** jsdom 无布局引擎（scrollHeight 恒 0）：按值打桩模拟内容高度（多行换行结果）。 */
  function mockScrollHeight(ta: HTMLTextAreaElement, value: number): void {
    Object.defineProperty(ta, 'scrollHeight', { value, configurable: true });
  }

  function input(ta: HTMLTextAreaElement): void {
    ta.dispatchEvent(new Event('input'));
  }

  it('打开即按预填内容校高：内容 100px → 落高 = scrollHeight + 4px 边框补偿', () => {
    const ta = open({ anchorRect: { x: 100, y: 50, w: 120, h: 24 }, scale: 1 });
    mockScrollHeight(ta, 100);
    input(ta);
    expect(ta.style.height).toBe('104px'); // scrollHeight 含 padding 不含边框，border-box 补 4px（editor.css 2px×2）
  });

  it('内容不足时落到下限：标题 = max(锚盒高, 行高)，单行内容不缩低于打开落高', () => {
    const ta = open({ anchorRect: { x: 100, y: 50, w: 120, h: 24 }, scale: 1 });
    expect(ta.style.height).toBe('24px'); // 打开落高 = max(锚盒 24, 行高 20)（jsdom scrollHeight=0）
    mockScrollHeight(ta, 8); // 内容比下限还矮：保持下限，不缩
    input(ta);
    expect(ta.style.height).toBe('24px');
  });

  it('长描述撑高描述框且描述框随标题实高下移（恒距 4px）', () => {
    const ta = open({ anchorRect: { x: 100, y: 50, w: 120, h: 24 }, scale: 1, description: {} });
    const desc = descBox();
    expect(desc.style.top).toBe('74px'); // 初始 = 46 + 24 + 4
    mockScrollHeight(ta, 100); // 标题撑高到 104
    input(ta);
    expect(ta.style.height).toBe('104px');
    mockScrollHeight(desc, 200); // 长描述多行
    input(desc);
    expect(desc.style.height).toBe('204px');
    expect(desc.style.top).toBe('154px'); // 46 + 104（标题实高）+ 4：标题长高不压描述框
  });

  it('回删内容框回缩：先落 auto 再量 scrollHeight 的测量序钉定（不收回则钉在当前高）', () => {
    const ta = open({ anchorRect: { x: 100, y: 50, w: 120, h: 24 }, scale: 1 });
    mockScrollHeight(ta, 100);
    input(ta);
    expect(ta.style.height).toBe('104px');
    mockScrollHeight(ta, 20); // 删到单行：回缩到下限（而非钉在 104）
    input(ta);
    expect(ta.style.height).toBe('24px');
  });
});
