import { describe, expect, it } from 'vitest';
import {
  handledActionIds,
  resolveShortcutAction,
  SHORTCUT_ACTION_IDS,
  SHORTCUT_LIST,
  type ShortcutKeySnapshot,
} from './keyboardMap';

/**
 * 快捷键帮助面板清单同源守卫（M5 Task 2，NFR-USE-002 / FR-EDT-007）。
 *
 * 面板清单 SHORTCUT_LIST 必须与 attachKeyboardMap 实际处理的动作集合逐项一致
 * （PRD FR-EDT-007「完整列出全部」；多列一条 = 面板撒谎，少列一条 = 功能不可发现）。
 * 结构性保证链：SHORTCUT_LIST.id 的类型是 ShortcutActionId（多列 → 编译错）→
 * 分发 switch 对 ShortcutActionId 穷尽（少列 → 单测 set 比对红）。
 *
 * resolveShortcutAction 为纯函数（事件按键快照 → 动作 id），这里钉住
 * 「帮助 opener 与折叠错开」的 Shift 判定：PRD 里 Ctrl+/ = 折叠、Ctrl+? = 帮助，
 * 而 US 布局 ? 键即 Shift+/，两种事件形态（key='?' / key='/' + shiftKey）都必须
 * 落到帮助，不能吞掉无 Shift 的折叠通道。
 */

const keys = (patch: Partial<ShortcutKeySnapshot>): ShortcutKeySnapshot => ({
  key: '',
  ctrlKey: false,
  metaKey: false,
  altKey: false,
  shiftKey: false,
  ...patch,
});

describe('SHORTCUT_LIST（面板清单完整性）', () => {
  it('存在且非空；每条 id/label 唯一，win/mac 均为非空字符串', () => {
    expect(SHORTCUT_LIST.length).toBeGreaterThan(0);
    const ids = new Set(SHORTCUT_LIST.map((s) => s.id));
    expect(ids.size).toBe(SHORTCUT_LIST.length); // id 无重复（React key/守卫集合口径）
    for (const item of SHORTCUT_LIST) {
      expect(item.label.trim(), `${item.id} label`).not.toBe('');
      expect(item.win.trim(), `${item.id} win`).not.toBe('');
      expect(item.mac.trim(), `${item.id} mac`).not.toBe('');
    }
  });

  it('三个分组（节点编辑/视图/文件）均非空', () => {
    for (const group of ['节点编辑', '视图', '文件'] as const) {
      const rows = SHORTCUT_LIST.filter((s) => s.group === group);
      expect(rows.length, `分组 ${group}`).toBeGreaterThan(0);
    }
  });

  it('id 集合 === 绑定实际处理的动作集合（防漂移守卫）', () => {
    const listIds = new Set<string>(SHORTCUT_LIST.map((s) => s.id));
    const handled = handledActionIds();
    expect([...handled].filter((id) => !listIds.has(id)), '已绑定但清单未列').toEqual([]);
    expect([...listIds].filter((id) => !handled.has(id)), '清单列出但未绑定').toEqual([]);
    expect(listIds.size).toBe(SHORTCUT_ACTION_IDS.length);
  });
});

describe('resolveShortcutAction（绑定行为快照）', () => {
  it('Ctrl+/（无 Shift）→ 折叠；Ctrl+? 的两种事件形态（key=? 或 Shift+/）→ 帮助面板', () => {
    expect(resolveShortcutAction(keys({ key: '/', ctrlKey: true }))).toBe('toggle-collapse');
    expect(resolveShortcutAction(keys({ key: '/', metaKey: true }))).toBe('toggle-collapse');
    expect(resolveShortcutAction(keys({ key: '?', ctrlKey: true, shiftKey: true }))).toBe(
      'open-help',
    );
    // 布局现实：? 即 Shift+/ 的键盘上，浏览器可能报 key='/' + shiftKey
    expect(resolveShortcutAction(keys({ key: '/', ctrlKey: true, shiftKey: true }))).toBe(
      'open-help',
    );
    expect(resolveShortcutAction(keys({ key: '?', metaKey: true, shiftKey: true }))).toBe(
      'open-help',
    );
  });

  it('编辑族：撤销/重做双通道、剪贴板、全选', () => {
    expect(resolveShortcutAction(keys({ key: 'z', ctrlKey: true }))).toBe('undo');
    expect(resolveShortcutAction(keys({ key: 'Z', metaKey: true }))).toBe('undo');
    expect(resolveShortcutAction(keys({ key: 'z', ctrlKey: true, shiftKey: true }))).toBe('redo');
    expect(resolveShortcutAction(keys({ key: 'y', ctrlKey: true }))).toBe('redo');
    expect(resolveShortcutAction(keys({ key: 'c', ctrlKey: true }))).toBe('copy');
    expect(resolveShortcutAction(keys({ key: 'x', ctrlKey: true }))).toBe('cut');
    expect(resolveShortcutAction(keys({ key: 'v', ctrlKey: true }))).toBe('paste');
    expect(resolveShortcutAction(keys({ key: 'a', ctrlKey: true }))).toBe('select-all');
  });

  it('单键族：Enter/Space/Tab 两态/删除/方向键/Home/End；修饰键一律不触发', () => {
    expect(resolveShortcutAction(keys({ key: 'Enter' }))).toBe('enter');
    expect(resolveShortcutAction(keys({ key: ' ' }))).toBe('edit-selected');
    expect(resolveShortcutAction(keys({ key: 'Tab' }))).toBe('insert-child');
    expect(resolveShortcutAction(keys({ key: 'Tab', shiftKey: true }))).toBe('insert-parent');
    expect(resolveShortcutAction(keys({ key: 'Delete' }))).toBe('delete-node');
    expect(resolveShortcutAction(keys({ key: 'Backspace' }))).toBe('delete-node');
    expect(resolveShortcutAction(keys({ key: 'ArrowUp' }))).toBe('navigate');
    expect(resolveShortcutAction(keys({ key: 'Home' }))).toBe('sibling-end');
    expect(resolveShortcutAction(keys({ key: 'End' }))).toBe('sibling-end');
    // 修饰/Alt 组合不在单键表内：让路（与原 if 链同口径）
    expect(resolveShortcutAction(keys({ key: 'Enter', ctrlKey: true }))).toBeNull();
    expect(resolveShortcutAction(keys({ key: 'Enter', altKey: true }))).toBeNull();
    expect(resolveShortcutAction(keys({ key: 'q', ctrlKey: true }))).toBeNull();
  });
});
