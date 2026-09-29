import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { TextEditorOverlay, EDITOR_BASE_FONT_SIZE } from './texteditor';

let onCommit: ReturnType<typeof vi.fn>;
let onCancel: ReturnType<typeof vi.fn>;
let onTruncated: ReturnType<typeof vi.fn>;
let overlay: TextEditorOverlay;

beforeEach(() => {
  document.body.innerHTML = '';
  overlay = new TextEditorOverlay();
  onCommit = vi.fn();
  onCancel = vi.fn();
  onTruncated = vi.fn();
});

interface OpenOpts {
  anchorRect?: { x: number; y: number; w: number; h: number };
  scale?: number;
  value?: string;
}

function open(opts: OpenOpts | string = {}): HTMLTextAreaElement {
  const o: OpenOpts = typeof opts === 'string' ? { value: opts } : opts;
  return overlay.open({
    anchorRect: o.anchorRect ?? { x: 100, y: 50, w: 120, h: 24 },
    scale: o.scale ?? 1,
    value: o.value ?? 'hello',
    onCommit: (t) => onCommit(t),
    onCancel: () => onCancel(),
    onTruncated: () => onTruncated(),
  });
}

function key(type: string, init: KeyboardEventInit = {}): KeyboardEvent {
  return new KeyboardEvent(type, { bubbles: true, cancelable: true, ...init });
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
    expect(onCommit).toHaveBeenCalledWith('z'.repeat(500));
    expect(onTruncated).toHaveBeenCalledTimes(1);
  });
});

describe('TextEditorOverlay 键盘语义（FR-EDT-005）', () => {
  it('Enter（无 Shift）→ 提交并关闭，事件被吞（defaultPrevented）', () => {
    const ta = open('hello');
    const e = key('keydown', { key: 'Enter' });
    ta.dispatchEvent(e);
    expect(e.defaultPrevented).toBe(true);
    expect(onCommit).toHaveBeenCalledTimes(1);
    expect(onCommit).toHaveBeenCalledWith('hello');
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
    expect(onCommit).toHaveBeenCalledWith('world');
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

  it('open 中再 open：旧编辑器按 blur 语义先提交，场上仅一个编辑器', () => {
    open('first');
    open('second');
    expect(onCommit).toHaveBeenCalledWith('first');
    expect(document.querySelectorAll('.gm-text-editor').length).toBe(1);
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
});
