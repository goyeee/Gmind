import { beforeEach, describe, expect, it, vi } from 'vitest';
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
