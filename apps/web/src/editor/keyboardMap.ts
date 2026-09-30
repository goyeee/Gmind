import type { Direction } from '@gmind/engine';

/**
 * 全局键盘映射 — M1b Task 11；M5 Task 2 提取帮助面板清单数据源。
 *
 * 绑定裁决（carry-in 5）：绑定 document 冒泡阶段（textarea 内 Enter/Esc 由
 * TextEditorOverlay stopPropagation 吞掉，只覆盖冒泡路径——本层监听必须走冒泡）；
 * 覆盖层打开时全部忽略（keydown 再兜底 document.activeElement / target 判定），
 * 焦点在 input/textarea/select 时也全部忽略（标题输入、下拉框原生行为优先）。
 *
 * 清单同源（M5 Task 2，FR-EDT-007）：SHORTCUT_LIST（帮助面板渲染的清单）与
 * 绑定行为共用一条 id 脊柱 SHORTCUT_ACTION_IDS——resolveShortcutAction 只产出
 * 脊柱 id，dispatchAction 的 switch 对脊柱穷尽（never 兜底编译期把关），
 * SHORTCUT_LIST.id 类型即脊柱 id（多列编译错，少列由单测集合比对兜住）。
 */

/** 动作 id 脊柱：绑定实际处理的动作全集（帮助面板清单同源守卫的锚点）。 */
export const SHORTCUT_ACTION_IDS = [
  'undo',
  'redo',
  'copy',
  'cut',
  'paste',
  'select-all',
  'open-help',
  'toggle-collapse',
  'enter',
  'edit-selected',
  'insert-child',
  'insert-parent',
  'delete-node',
  'navigate',
  'sibling-end',
] as const;

export type ShortcutActionId = (typeof SHORTCUT_ACTION_IDS)[number];

/** 帮助面板分组（PRD FR-EDT-007：节点编辑/视图/文件）。 */
export type ShortcutGroup = '节点编辑' | '视图' | '文件';

export interface ShortcutItem {
  id: ShortcutActionId;
  group: ShortcutGroup;
  label: string;
  /** Windows/Linux 键位（Ctrl 系修饰）。 */
  win: string;
  /** macOS 键位（⌘ 系修饰，面板按平台检测二选一展示）。 */
  mac: string;
}

/**
 * 快捷键清单（帮助面板单一数据源，M5 Task 2）。键位以本文件绑定为准——面板是
 * 「完整列出实际绑定」，PRD 3.1.2 表中未在 keyboardMap 落键的项（缩放/适应/
 * 全屏等画布按钮）不入列；分组按实际绑定归类。
 */
export const SHORTCUT_LIST: readonly ShortcutItem[] = [
  // —— 节点编辑（增删改/插入/撤销重做/复制粘贴/全选） ——
  { id: 'undo', group: '节点编辑', label: '撤销', win: 'Ctrl+Z', mac: '⌘Z' },
  { id: 'redo', group: '节点编辑', label: '重做', win: 'Ctrl+Shift+Z / Ctrl+Y', mac: '⌘⇧Z / ⌘Y' },
  { id: 'enter', group: '节点编辑', label: '新建同级节点', win: 'Enter', mac: 'Return' },
  // 空格进编辑由页面层「选中即可编辑」监听接管（EditorPage 键盘直入编辑监听，
  // 2026-09-30 需求方收回空格），与本层 F2 同一动作面，清单同列便于发现。
  { id: 'edit-selected', group: '节点编辑', label: '编辑选中节点（全选内容）', win: 'F2 / 空格', mac: 'F2 / 空格' },
  { id: 'insert-child', group: '节点编辑', label: '新建子级节点', win: 'Tab', mac: 'Tab' },
  {
    id: 'insert-parent',
    group: '节点编辑',
    label: '在选中与父节点间插入父级',
    win: 'Shift+Tab',
    mac: '⇧Tab',
  },
  { id: 'delete-node', group: '节点编辑', label: '删除选中节点', win: 'Delete / Backspace', mac: 'Delete / Backspace' },
  { id: 'select-all', group: '节点编辑', label: '全选节点', win: 'Ctrl+A', mac: '⌘A' },
  { id: 'copy', group: '节点编辑', label: '复制选中节点', win: 'Ctrl+C', mac: '⌘C' },
  { id: 'cut', group: '节点编辑', label: '剪切选中节点', win: 'Ctrl+X', mac: '⌘X' },
  { id: 'paste', group: '节点编辑', label: '粘贴为选中节点子级', win: 'Ctrl+V', mac: '⌘V' },
  // —— 视图（折叠/导航） ——
  { id: 'toggle-collapse', group: '视图', label: '折叠/展开选中节点', win: 'Ctrl+/', mac: '⌘/' },
  { id: 'navigate', group: '视图', label: '方向键导航', win: '↑ ↓ ← →', mac: '↑ ↓ ← →' },
  { id: 'sibling-end', group: '视图', label: '跳转同级首/末节点', win: 'Home / End', mac: 'Home / End' },
  // —— 文件（帮助入口；保存为自动保存，无键位） ——
  { id: 'open-help', group: '文件', label: '打开快捷键帮助面板', win: 'Ctrl+?', mac: '⌘?' },
];

/** 绑定实际处理的动作 id 全集（守卫单测与 SHORTCUT_LIST 集合比对，防清单漂移）。 */
export function handledActionIds(): Set<string> {
  return new Set<string>(SHORTCUT_ACTION_IDS);
}

export interface KeyboardMapDeps {
  /** 文本编辑覆盖层是否打开（打开则本层全部让路）。 */
  isEditorOpen(): boolean;
  /** 画布视图未激活（M7a-T4 表格视图）：Enter/Tab/Delete 等画布写键位让路——
   *  画布隐藏期间焦点在表体上时误触会不可见地增删画布选中节点；撤销/重做不受此闸。
   *  可选：缺省恒激活。 */
  isInactive?(): boolean;
  undo(): void;
  redo(): void;
  /** Enter（未编辑态）：新建同级节点（root 上新建子级）并进入编辑。 */
  onEnter(): void;
  /** F2（未编辑态，FR-EDT-005）：主选中节点进入编辑态。原 Space 绑定 2026-09-30
   *  起由页面层「选中即可编辑」监听收回（可打印字符直入编辑/空格进编辑并全选），
   *  「空格按住 + 左键拖拽 = 平移画布」手势随之退役（M7b-W3 曾把 Space 让位给该
   *  手势），画布平移只剩中键拖拽。 */
  onEditSelected(): void;
  /** Tab 新建子级 / Shift+Tab 在当前与父之间插新父级。 */
  onTab(shift: boolean): void;
  /** Delete/Backspace 删除选中（root 降级清空子级）。 */
  onDelete(): void;
  /** Ctrl/Cmd+A 全选存活节点。 */
  onSelectAll(): void;
  /** Ctrl+/ 折叠/展开选中节点。 */
  onToggleCollapse(): void;
  /** Ctrl/Cmd+?（M5 Task 2，FR-EDT-007）：打开快捷键帮助面板。 */
  onHelp(): void;
  /** 方向键几何导航。 */
  onNavigate(direction: Direction): void;
  /** Home/End 同级首/末。 */
  onSiblingEnd(which: 'first' | 'last'): void;
  onCopy(): void;
  onCut(): void;
  onPaste(): void;
}

/** 焦点在输入控件/内容可编辑元素上（输入、下拉、覆盖层编辑器等）：
 * 本键盘映射全部让路（原生输入行为优先）。画布 paste 监听（EditorPage 图片粘贴）
 * 复用同一判定。 */
export function isEditableTarget(target: EventTarget | null): boolean {
  return (
    target instanceof Element &&
    target.closest('input, textarea, select, [contenteditable="true"]') !== null
  );
}

/** 事件 → 动作判定所需的按键快照（纯函数口径：单测无需 DOM 事件）。 */
export interface ShortcutKeySnapshot {
  key: string;
  ctrlKey: boolean;
  metaKey: boolean;
  altKey: boolean;
  shiftKey: boolean;
}

/** 「选中即可编辑」的按键通道（2026-09-30 需求方：「鼠标选中某主题后应该可以
 *  直接编辑，或敲击空格全选主题内容」）。 */
export type DirectEditKeyKind = 'printable' | 'space';

/**
 * 按键快照 → 直入编辑通道（null = 非直入编辑键，让路）。「选中即可编辑」监听
 * （EditorPage 键盘直入编辑 effect）的唯一裁决点，纯函数口径便于单测钉住让路矩阵：
 * - printable：key.length === 1 的可打印字符（含 Shift 大写/符号/中文单字），**不含
 *   空格**——空格单列 space 通道（进编辑并全选、不落空格）；Ctrl/Cmd/Alt 组合一律
 *   null（剪贴板/帮助/折叠等修饰键族归属本文件 resolveShortcutAction）；
 * - space：空格键（含 Shift+Space）。
 * Enter/Tab/方向键/F2/Dead/Process（输入法死键/组字）等非可打印键不在通道内。
 * 两通道的 preventDefault 纪律不同：printable **不**拦截默认行为（字符要落进打开
 * 即全选的编辑框）、space 必须 preventDefault（不插空格）——由调用方按通道处置。
 */
export function resolveDirectEditKey(e: ShortcutKeySnapshot): DirectEditKeyKind | null {
  if (e.ctrlKey || e.metaKey || e.altKey) return null;
  if (e.key === ' ') return 'space';
  if (e.key.length === 1) return 'printable';
  return null;
}

/** 方向键 → 引擎导航方向。 */
const NAVIGATE_BY_KEY: Record<string, Direction> = {
  ArrowUp: 'up',
  ArrowDown: 'down',
  ArrowLeft: 'left',
  ArrowRight: 'right',
};

/**
 * 按键快照 → 动作 id（null = 无绑定，让路）。attachKeyboardMap 的唯一裁决点：
 * 修饰键族（Ctrl/Cmd）优先，单键族随后；带修饰/Alt 的裸键一律不落在单键表。
 *
 * 帮助 opener 的布局现实（PRD：Ctrl+? = 帮助、Ctrl+/ = 折叠，两者必须错开）：
 * US 布局 ? 即 Shift+/，Ctrl+Shift+/ 的事件可能报 key='?'（多数）也可能报
 * key='/' + shiftKey（部分布局/浏览器）——两种形态都收进 open-help；无 Shift
 * 的 mod+/ 保持折叠通道（editor.e2e 用例 6 依赖），原 '?' 无 Shift 归折叠的
 * 分支随之让位（'?' 必然伴随 Shift 产生，语义上就是 Ctrl+?）。
 */
export function resolveShortcutAction(e: ShortcutKeySnapshot): ShortcutActionId | null {
  const mod = e.ctrlKey || e.metaKey;
  const key = e.key;

  if (mod && !e.altKey) {
    if (key === 'z' || key === 'Z') return e.shiftKey ? 'redo' : 'undo';
    if (!e.shiftKey && (key === 'y' || key === 'Y')) return 'redo';
    if (!e.shiftKey && (key === 'c' || key === 'C')) return 'copy';
    if (!e.shiftKey && (key === 'x' || key === 'X')) return 'cut';
    if (!e.shiftKey && (key === 'v' || key === 'V')) return 'paste';
    if (!e.shiftKey && (key === 'a' || key === 'A')) return 'select-all';
    if (e.shiftKey && (key === '?' || key === '/')) return 'open-help';
    if (!e.shiftKey && key === '/') return 'toggle-collapse';
    return null;
  }
  if (mod || e.altKey) return null;

  switch (key) {
    case 'Enter':
      return 'enter';
    case 'F2': // M7b-W3 改绑 F2（原 Space）；2026-09-30 空格收回进编辑走页面层，本层不回绑
      return 'edit-selected';
    case 'Tab':
      return e.shiftKey ? 'insert-parent' : 'insert-child';
    case 'Delete':
    case 'Backspace':
      return 'delete-node';
    case 'ArrowUp':
    case 'ArrowDown':
    case 'ArrowLeft':
    case 'ArrowRight':
      return 'navigate';
    case 'Home':
    case 'End':
      return 'sibling-end';
    default:
      return null;
  }
}

/** 动作 id → deps 调用（对 ShortcutActionId 穷尽；never 兜底让漏 case 编译报错）。 */
function dispatchAction(deps: KeyboardMapDeps, action: ShortcutActionId, e: KeyboardEvent): void {
  switch (action) {
    case 'undo':
      deps.undo();
      return;
    case 'redo':
      deps.redo();
      return;
    case 'copy':
      deps.onCopy();
      return;
    case 'cut':
      deps.onCut();
      return;
    case 'paste':
      deps.onPaste();
      return;
    case 'select-all':
      deps.onSelectAll();
      return;
    case 'open-help':
      deps.onHelp();
      return;
    case 'toggle-collapse':
      deps.onToggleCollapse();
      return;
    case 'enter':
      deps.onEnter();
      return;
    case 'edit-selected':
      deps.onEditSelected();
      return;
    case 'insert-child':
      deps.onTab(false);
      return;
    case 'insert-parent':
      deps.onTab(true);
      return;
    case 'delete-node':
      deps.onDelete();
      return;
    case 'navigate':
      deps.onNavigate(NAVIGATE_BY_KEY[e.key] ?? 'up');
      return;
    case 'sibling-end':
      deps.onSiblingEnd(e.key === 'Home' ? 'first' : 'last');
      return;
    default: {
      const exhaustive: never = action; // 穷尽性编译守卫（新增 id 漏 case 即红）
      return exhaustive;
    }
  }
}

export function attachKeyboardMap(deps: KeyboardMapDeps): () => void {
  const onKeyDown = (e: KeyboardEvent): void => {
    if (deps.isEditorOpen()) return; // 覆盖层打开：按键归编辑器
    if (isEditableTarget(e.target)) return;

    const action = resolveShortcutAction(e);
    if (action === null) return;
    if (deps.isInactive?.() && action !== 'undo' && action !== 'redo') {
      // 画布视图未激活（M7a-T4 表格视图）：画布写/导航键位让路——画布隐藏期焦点在
      // 表体上误触会不可见地增删画布选中节点；撤销/重做保留（表格写同入撤销栈）。
      return;
    }
    // 命中即抑制默认行为（原 if 链各分支逐个 preventDefault 的口径不变）；
    // F2 抑制部分浏览器的重命名/查找语义、Tab 抑制焦点移动等均沿袭。
    // Space 不在本层绑定：2026-09-30 起由页面层「选中即可编辑」捕获监听接管
    // （进编辑并全选 + 空格平移手势退役），见 EditorPage 键盘直入编辑监听。
    e.preventDefault();
    dispatchAction(deps, action, e);
  };

  // 冒泡阶段绑定（绑定裁决，见文件头）
  document.addEventListener('keydown', onKeyDown, false);
  return () => document.removeEventListener('keydown', onKeyDown);
}
