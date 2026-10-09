import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type * as Y from 'yjs';
import {
  addChild,
  countAliveReachable,
  CUSTOM_COLUMN_LIMIT,
  CUSTOM_COLUMN_NAME_MAX,
  CUSTOM_COLUMN_TYPES,
  CUSTOM_TEXT_MAX_LENGTH,
  deleteNodes,
  getMeta,
  getNode,
  moveNode,
  ORIGIN_SYSTEM,
  ORIGIN_USER,
  ROOT_NODE_ID,
  setCollapsed,
  setCustomColumns,
  setCustomField,
  setDescription,
  setNodeTask,
  setTableView,
  setText,
  subtreeIds,
  TABLE_BUILTIN_COLUMN_KEYS,
  toggleCollapse,
  withTransaction,
  type CustomColumnDef,
  type CustomColumnType,
  type NodeSnapshot,
  type TableViewMeta,
  type TableViewSort,
} from '@gmind/core';
import {
  childrenOf,
  effectiveProgress,
  isOverdue,
  todayStr,
  type DeriveNode,
  type TaskPatch,
  type TaskStatus,
} from '@gmind/shared';
import { MARKER_ROW_ORDER, colorForUser, markerDefOf } from '@gmind/engine';
import { nextChildText } from './defaultNodeText';
import { api } from '../api/client';
import { track } from '../api/events';
import type { PresenceMember } from './collab';
import { MarkerChip } from './MarkerPanel';
import {
  Avatar,
  chipActive,
  MemberMultiSelect,
  SmartDateInput,
  STATUS_KEYS,
  STATUS_META,
  type MemberOption,
} from './TaskFields';
import './task-table.css';

/**
 * 任务表格视图（M7a-T4，移植自 mindgrid `TreeTable.tsx`，形态待需求方确认后补全量 e2e）。
 *
 * 数据链路：订阅既有 doc 快照通道（docVersion = EditorPage tick，本地/远端任何 doc
 * 更新都推进）→ subtreeIds+getNode 建 RowNode[] → @gmind/shared 派生规则（childrenOf/
 * effectiveProgress/isOverdue）驱动行集/进度/逾期。中心主题（root）不进表，直属子级
 * depth=0（flattenVisible(rootId) 同口径）；root 折叠时整树收起。
 *
 * 折叠互通：折叠态落在节点 doc 字段（collapsed，Yjs 同步；脑图折叠徽标与表格折叠钮
 * 读写同一字段，经 toggleCollapse/setCollapsed 写、system origin 不进撤销栈）——双视图
 * 折叠天然同源，无需共享 UI state。
 *
 * 写纪律：全部写走 gmind-core op（setNodeTask/setText/addChild/deleteNodes/moveNode/
 * toggleCollapse/setCollapsed/setCustomColumns/setCustomField/setTableView）
 * + afterUserWrite（capUndoStack/lastEditor/编辑中广播），禁止直写 Yjs；校验异常经
 * showToast 两段式透出。视图态写（tableView：列序/隐藏/固定/排序）与 collapsed 同
 * 裁定——system origin 不进撤销栈、不标 lastEditor。
 *
 * 统一列模型（需求方 2026-10-01 列体系升级）：内置列（TABLE_BUILTIN_COLUMN_KEYS
 * 固定 key）与自定义列（colId）合成一个有序清单，meta.tableView（core 防御读取 +
 * setTableView 唯一写入口）持久化 order/hidden/pinned/sort——自定义列可挪进内置列
 * 中间、任意列可隐藏（任务名除外，core 层不可隐藏裁定）/固定左侧（sticky，偏移=
 * 前序固定列累计宽，ResizeObserver 实测列宽）/点击表头三态排序（升→降→取消，
 * 显示层不动树结构：同父分组内排序，空值恒排尾，取消恢复树序）。列头 ⋯ 菜单对
 * 内置/自定义列同款（左移/右移/隐藏/固定 + 自定义列独有重命名/删除）；筛选条
 * 「列设置」浮层勾选显隐。查看者（readOnly）：排序为本地态（不落盘），列序/隐藏/
 * 固定按文档既值渲染、不可改。
 *
 * 已知口径（速度优先形态版）：
 * - 「更新时间」列 = 会话内观察到的最后修改时刻（observeDeep 记录，含远端），未观察
 *   过的行显示「—」（Gmind 节点无持久 updatedAt 字段，M7d 变更日志轨再议）；
 * - 负责人存用户ID；候选 = GET /files/:id/collaborators（owner+协作者）∪ presence
 *   在线成员 ∪ 文档内已出现的 ID（昵称回退），成员色 = colorForUser(userId)。
 */

/** 状态元数据（企微浅色系）与子组件（Avatar/SmartDateInput/chipActive）已抽至
 *  TaskFields.tsx（M7c-C3/C4 抽公共）：TaskTable 改为共用，交互/类名/testid 零改动。 */

/** 统一列模型的列定义：内置列与自定义列同构（key = 内置固定 key 或 colId）；
 *  自定义列 extra 携带 schema（类型分派单元格编辑器 + 类型小标记）。 */
interface ColumnDef {
  key: string;
  label: string;
  builtin: boolean;
  custom?: CustomColumnDef;
}

/** 内置列目录：key 与 TABLE_BUILTIN_COLUMN_KEYS（core 单源）一一同序；'owner' 与
 *  shared sortValue 排序键同名（单元格 testid 沿用 -owners 后缀，历史契约不动）。 */
const BUILTIN_COLUMNS: ColumnDef[] = [
  { key: 'title', label: '任务', builtin: true },
  { key: 'owner', label: '负责人', builtin: true },
  { key: 'status', label: '状态', builtin: true },
  { key: 'progress', label: '进度', builtin: true },
  { key: 'startDate', label: '开始日期', builtin: true },
  { key: 'dueDate', label: '预期日期', builtin: true },
  { key: 'doneDate', label: '完成日期', builtin: true },
  { key: 'updatedAt', label: '更新时间', builtin: true },
];

/** 状态显示层排序序（需求方 2026-10-01 列体系升级口径：todo<doing<done<blocked，
 *  与状态选择器 UI 序一致；行菜单结构排序沿 shared sortValue 的 todo<doing<blocked<
 *  done 旧序——shared 包不在本次改动面，两序差异已在交付报告登记）。 */
const STATUS_SORT_ORDER: Record<TaskStatus, number> = { todo: 0, doing: 1, done: 2, blocked: 3 };

/** 排序取值形状：empty=空值（恒排尾，与方向无关）；numeric 决定 num/text 比较。 */
interface ColumnSortValue {
  empty: boolean;
  numeric: boolean;
  num: number;
  text: string;
}

/** 自定义列类型 → 展示标记/标签（列头小图标 + 添加浮层四选；目录单源 core）。 */
const CUSTOM_TYPE_META: Record<CustomColumnType, { mark: string; label: string }> = {
  text: { mark: 'T', label: '文本' },
  person: { mark: '人', label: '人员' },
  progress: { mark: '%', label: '进度' },
  date: { mark: '日', label: '日期' },
};

/** 新自定义列 id：crypto.randomUUID()（core 只约束非空唯一；web 未依赖 ulid 包
 *  ——与 api/events.ts 的 sid 同款裁定，不为此引入新依赖）。 */
function newColumnId(): string {
  return crypto.randomUUID();
}

interface Filters {
  keyword: string;
  owners: Set<string>;
  statuses: Set<TaskStatus>;
  overdueOnly: boolean;
  unassignedOnly: boolean;
}

const EMPTY_FILTERS: Filters = {
  keyword: '',
  owners: new Set(),
  statuses: new Set(),
  overdueOnly: false,
  unassignedOnly: false,
};

/** 表格行节点：DeriveNode（shared 派生规则输入）+ 标记（标题列展示，M7b-W1 多值数组）
 *  + 描述（M7c-C1：双击标题的两行式行内编辑初值；不进派生规则）+ 自定义列值
 *  （custom 透传消费：colId → plain 值，不进派生规则）。 */
interface RowNode extends DeriveNode {
  icons: Record<string, string[]>;
  description: string;
  custom: Record<string, unknown>;
}

interface Row {
  node: RowNode;
  depth: number;
  hasChildren: boolean;
  dimmed: boolean;
}

function toggleInSet<T>(set: Set<T>, v: T): Set<T> {
  const next = new Set(set);
  if (next.has(v)) next.delete(v);
  else next.add(v);
  return next;
}

function fmtUpdated(ts: number): string {
  if (ts <= 0) return '—';
  const d = new Date(ts);
  const pad = (n: number): string => String(n).padStart(2, '0');
  return `${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/** 内置列 key → label（colLabel 的模块级半边；自定义列由组件内按 schema 查）。 */
const BUILTIN_LABELS = new Map(BUILTIN_COLUMNS.map((c) => [c.key, c.label]));

export interface TaskTableProps {
  doc: Y.Doc;
  fileId: string;
  /** 文档版本（EditorPage tick）：任何 doc 更新推进，驱动快照重建。 */
  docVersion: number;
  /** 只读降级（查看者）：全列文本化、右键菜单仅折叠项；折叠/筛选仍可用（视图级操作）。 */
  readOnly: boolean;
  /** 在线成员（awareness）：负责人昵称回退与筛选候选补充。 */
  presence: PresenceMember[];
  /** 统一用户写后处理（capUndoStack / lastEditor / 编辑中广播）。 */
  afterUserWrite: () => void;
  showToast: (message: string) => void;
  /** 新增节点配额闸：返回 true = 已拦截并提示。 */
  checkQuota: () => boolean;
  /** 点击标题联动画布选中（双视图同源；切回脑图不丢上下文）。 */
  onSelectNode: (id: string) => void;
}

export function TaskTable(props: TaskTableProps): React.ReactElement {
  const { doc, fileId, docVersion, readOnly, presence, afterUserWrite, showToast, checkQuota, onSelectNode } = props;
  const [filters, setFilters] = useState<Filters>(EMPTY_FILTERS);
  /** 查看者本地排序态（不落盘）：编辑者的排序持久化在 meta.tableView.sort，此处
   *  仅 readOnly 分支的会话内覆盖（初始 null = 按文档既值）。 */
  const [localSort, setLocalSort] = useState<TableViewSort | null>(null);
  /** 负责人单元格弹层锚点行。 */
  const [ownerCellOpen, setOwnerCellOpen] = useState<string | null>(null);
  /** 筛选条下拉（负责人/状态）。 */
  const [ownerFilterOpen, setOwnerFilterOpen] = useState(false);
  const [statusFilterOpen, setStatusFilterOpen] = useState(false);
  /** 右键行菜单。 */
  const [menu, setMenu] = useState<{ x: number; y: number; nodeId: string; field: string } | null>(null);
  /** 任务名行内编辑（isNew = 表格内新建后首编，空提交/Esc 回收节点）。 */
  const [cellEdit, setCellEdit] = useState<{ id: string; isNew: boolean } | null>(null);
  /** 进度列行内编辑（仅叶子）。 */
  const [progressEditId, setProgressEditId] = useState<string | null>(null);

  // —— 自定义列（doc 级 schema meta.customColumns；编辑入口仅非只读）——
  /** 加列浮层开合 + 草稿（名称/类型四选）。 */
  const [colAddOpen, setColAddOpen] = useState(false);
  const [addName, setAddName] = useState('');
  const [addType, setAddType] = useState<CustomColumnType>('text');
  /** 列头管理菜单（右键/悬停 ⋯ 钮；colKey 命中列——内置/自定义同款菜单）。 */
  const [colMenu, setColMenu] = useState<{ x: number; y: number; colKey: string } | null>(null);
  /** 列头行内重命名（th 变输入框；Enter/失焦提交、Esc 取消）。 */
  const [renameCol, setRenameCol] = useState<string | null>(null);
  /** 自定义 text/progress 单元格行内编辑（点击/双击进入）。 */
  const [customEdit, setCustomEdit] = useState<{ nodeId: string; colId: string } | null>(null);
  /** 自定义 person 单元格弹层锚点（nodeId+colId）。 */
  const [customPersonOpen, setCustomPersonOpen] = useState<{ nodeId: string; colId: string } | null>(null);
  /** 列设置浮层（全列显隐勾选清单；非只读入口）。 */
  const [colSettingsOpen, setColSettingsOpen] = useState(false);

  // —— 会话内节点最后修改时刻（「更新时间」列；见文件头已知口径） ——
  const updatedRef = useRef<Map<string, number>>(new Map());
  useEffect(() => {
    const nodesMap = doc.getMap('nodes');
    const onDeep: Parameters<Y.Map<unknown>['observeDeep']>[0] = (events) => {
      for (const ev of events) {
        if (ev.path.length === 0) {
          // nodes map 本体的键变更（节点增删）：keys 即节点 id
          for (const key of (ev as Y.YMapEvent<unknown>).keys.keys()) {
            updatedRef.current.set(key, Date.now());
          }
        } else if (typeof ev.path[0] === 'string') {
          // 节点内部字段变更（文本/任务字段/折叠…）：path 首段即节点 id
          updatedRef.current.set(ev.path[0], Date.now());
        }
      }
    };
    nodesMap.observeDeep(onDeep);
    return () => nodesMap.unobserveDeep(onDeep);
  }, [doc]);

  // —— 文档成员候选（owner + 协作者；失败静默回退 presence/文档内既有 ID） ——
  const [collaborators, setCollaborators] = useState<MemberOption[]>([]);
  useEffect(() => {
    let alive = true;
    api<Array<{ userId: string; nickname: string }>>(`/files/${fileId}/collaborators`)
      .then((list) => {
        if (alive) setCollaborators(list);
      })
      .catch(() => undefined);
    return () => {
      alive = false;
    };
  }, [fileId]);

  // —— 快照 → RowNode[]（root 不进表；order = 父 childIds 下标） ——
  const nodes = useMemo<RowNode[]>(() => {
    const updated = updatedRef.current;
    const snaps = new Map<string, NodeSnapshot>();
    for (const id of subtreeIds(doc, ROOT_NODE_ID)) {
      const snap = getNode(doc, id);
      if (!snap || snap.deleted) continue;
      snaps.set(id, snap);
    }
    const root = snaps.get(ROOT_NODE_ID);
    const out: RowNode[] = [];
    for (const [id, snap] of snaps) {
      if (id === ROOT_NODE_ID) continue;
      const parent = snap.parentId === '' ? root : snaps.get(snap.parentId);
      out.push({
        id,
        parentId: snap.parentId === '' ? null : snap.parentId,
        title: snap.text,
        collapsed: snap.collapsed,
        order: parent ? Math.max(0, parent.childIds.indexOf(id)) : 0,
        updatedAt: updated.get(id) ?? 0,
        task: { ...snap.task, owners: [...snap.task.owners] },
        icons: { ...snap.icons },
        description: snap.description,
        custom: { ...(snap.custom ?? {}) },
      });
    }
    return out;
  }, [doc, docVersion]);

  const rootCollapsed = useMemo(
    () => getNode(doc, ROOT_NODE_ID)?.collapsed === true,
    [doc, docVersion],
  );

  /** 自定义列 schema（meta.customColumns；恒数组，旧文档 []——无列时零 UI 噪音，只剩「+」钮）。 */
  const customColumns = useMemo(() => getMeta(doc).customColumns, [doc, docVersion]);

  /** userId → 展示信息（collaborators ∪ presence ∪ 文档内既有 ID）。 */
  const memberIndex = useMemo(() => {
    const map = new Map<string, MemberOption>();
    for (const c of collaborators) map.set(c.userId, c);
    for (const p of presence) {
      if (!map.has(p.userId)) map.set(p.userId, { userId: p.userId, nickname: p.nickname });
    }
    for (const n of nodes) {
      for (const o of n.task?.owners ?? []) {
        if (!map.has(o)) map.set(o, { userId: o, nickname: o.slice(0, 8) });
      }
    }
    return map;
  }, [collaborators, presence, nodes]);

  const nicknameOf = (userId: string): string => memberIndex.get(userId)?.nickname ?? userId.slice(0, 8);

  // —— 统一列模型（需求方 2026-10-01 列体系升级）——
  // meta.tableView（core 防御读取）：order 恒为 内置∪自定义 的完整排列（canonical
  // 补全），缺省（无键文档）= 内置序 + 自定义列尾；hidden 恒不含 'title'（core 裁定）。

  /** 表格视图持久态：**每次渲染直读 doc、不走 memo**——setTableView 同步落本地
   *  doc，而 docVersion（EditorPage tick）经 rAF 推进晚一帧：若按 memo 缓存，点击
   *  复选框后的任意先行重渲染（presence/成员候选等）会以旧值重绘受控复选框，产生
   *  「已勾选→回弹」一帧闪烁（e2e check 振荡根因）。直读开销可忽略（meta 小对象
   *  canonical），重头派生（rows）的 memo 改以标量排序键为依赖不受身份churn影响。 */
  const tableView = getMeta(doc).tableView;

  /** 生效排序态：编辑者 = meta.tableView.sort（持久化）；查看者 = 本地覆盖。 */
  const sort: TableViewSort | null = readOnly ? localSort : (tableView?.sort ?? null);
  const sortKey = sort?.key;
  const sortDir = sort?.dir;

  /** 全列有序清单：按 tableView.order（缺省序兜底）解 key → 列定义（每渲染直算，
   *  ≤ 内置8+自定义20 项的小数组；列集真值变化即时反映，不依赖 docVersion）。 */
  const allColumns: ColumnDef[] = (() => {
    const byKey = new Map<string, ColumnDef>();
    for (const b of BUILTIN_COLUMNS) byKey.set(b.key, b);
    for (const c of customColumns) byKey.set(c.id, { key: c.id, label: c.name, builtin: false, custom: c });
    const order = tableView?.order ?? [...TABLE_BUILTIN_COLUMN_KEYS, ...customColumns.map((c) => c.id)];
    return order.map((k) => byKey.get(k)).filter((c): c is ColumnDef => c !== undefined);
  })();

  const hiddenSet = new Set(tableView?.hidden ?? []);
  const pinnedSet = new Set(tableView?.pinned ?? []);

  /** 可见列（过滤 hidden）→ 渲染序：固定列分区前置（各自内部保持 order 相对序），
   *  未固定列依序跟随——sticky 左侧冻结的 Excel/企微表格同款形态。 */
  const renderColumns: ColumnDef[] = (() => {
    const vis = allColumns.filter((c) => !hiddenSet.has(c.key));
    return [...vis.filter((c) => pinnedSet.has(c.key)), ...vis.filter((c) => !pinnedSet.has(c.key))];
  })();

  /** 列 key → label（内置查表 + 自定义查 schema）。 */
  const colLabel = (key: string): string => BUILTIN_LABELS.get(key) ?? customColumns.find((c) => c.id === key)?.name ?? '任务';

  /** 列排序取值（统一实现：内置列 + 自定义列；空值判定供「空值恒排尾」）。
   *  语义：文本 localeCompare('zh')；人员按首人昵称（回退 userId 前 8 位）；进度
   *  数值（内置=有效进度 Σ 汇总，自定义=自身值）；日期 YYYY-MM-DD 字典序=时间序；
   *  状态按 UI 序 todo<doing<done<blocked。 */
  const columnSortValue = (key: string, n: RowNode): ColumnSortValue => {
    const customType = customColumns.find((c) => c.id === key)?.type;
    if (customType !== undefined) {
      const v = n.custom?.[key];
      if (customType === 'text') {
        return { empty: !(typeof v === 'string' && v !== ''), numeric: false, num: 0, text: typeof v === 'string' ? v : '' };
      }
      if (customType === 'person') {
        const first = Array.isArray(v) && typeof v[0] === 'string' ? v[0] : '';
        return { empty: first === '', numeric: false, num: 0, text: first !== '' ? nicknameOf(first) : '' };
      }
      if (customType === 'progress') {
        return { empty: typeof v !== 'number', numeric: true, num: typeof v === 'number' ? v : 0, text: '' };
      }
      return { empty: !(typeof v === 'string' && v !== ''), numeric: false, num: 0, text: typeof v === 'string' ? v : '' };
    }
    const t = n.task;
    switch (key) {
      case 'title':
        return { empty: false, numeric: false, num: 0, text: n.title };
      case 'owner': {
        const first = t?.owners[0] ?? '';
        return { empty: first === '', numeric: false, num: 0, text: first !== '' ? nicknameOf(first) : '' };
      }
      case 'status':
        return { empty: false, numeric: true, num: STATUS_SORT_ORDER[t?.status ?? 'todo'], text: '' };
      case 'progress':
        return { empty: false, numeric: true, num: effectiveProgress(nodes, n.id), text: '' };
      case 'startDate':
      case 'dueDate':
      case 'doneDate':
        return { empty: (t?.[key] ?? null) === null, numeric: false, num: 0, text: t?.[key] ?? '' };
      case 'updatedAt':
        return { empty: (n.updatedAt ?? 0) <= 0, numeric: true, num: n.updatedAt ?? 0, text: '' };
      default:
        return { empty: false, numeric: false, num: 0, text: n.title };
    }
  };

  /** 统一列比较器（显示层排序 + 行菜单结构排序共用）：空值恒排尾（与方向无关），
   *  其余按值比较后乘 dir。 */
  const compareByColumn = (key: string, dir: 1 | -1, a: RowNode, b: RowNode): number => {
    const va = columnSortValue(key, a);
    const vb = columnSortValue(key, b);
    if (va.empty && vb.empty) return 0;
    if (va.empty) return 1; // 空值恒排尾
    if (vb.empty) return -1;
    const c = va.numeric ? va.num - vb.num : va.text.localeCompare(vb.text, 'zh');
    return c * dir;
  };

  // —— 固定列 sticky 偏移（实测算：th 实测宽 → 前序固定列累计宽）——
  // 列宽是 auto 布局（title 32% 流式），静态 CSS 无法给出确定偏移；挂表级
  // ResizeObserver 在列集/固定集/文档内容变化后重测（th[data-col-key] 定位）。
  const tableRef = useRef<HTMLTableElement | null>(null);
  /** colKey → sticky left 偏移（px）；仅固定列有条目。 */
  const [pinOffsets, setPinOffsets] = useState<Map<string, number>>(() => new Map());
  const pinnedKeys = [...pinnedSet].sort((a, b) => renderColumns.findIndex((c) => c.key === a) - renderColumns.findIndex((c) => c.key === b));
  const renderKeys = renderColumns.map((c) => c.key).join('\u0000');
  useLayoutEffect(() => {
    const measure = (): void => {
      const table = tableRef.current;
      if (!table) return;
      const widths = new Map<string, number>();
      for (const th of table.querySelectorAll<HTMLTableCellElement>('thead th[data-col-key]')) {
        const key = th.dataset.colKey;
        if (key) widths.set(key, th.getBoundingClientRect().width);
      }
      let acc = 0;
      const next = new Map<string, number>();
      for (const col of renderColumns) {
        if (!pinnedSet.has(col.key)) continue;
        next.set(col.key, acc);
        acc += widths.get(col.key) ?? 0;
      }
      setPinOffsets((prev) => {
        const same =
          prev.size === next.size && [...next.entries()].every(([k, v]) => prev.get(k) === v);
        return same ? prev : next;
      });
    };
    measure();
    const table = tableRef.current;
    if (!table) return;
    const ro = new ResizeObserver(measure);
    ro.observe(table);
    return () => ro.disconnect();
    // deps 为渲染列集与固定集的稳定串化（避免每渲染重挂 observer）；内容宽度变化
    // 由 ResizeObserver 兜底，文档更新（docVersion）后主动复测
  }, [renderKeys, pinnedKeys.join('\u0000'), docVersion]);
  /** 固定列单元格样式（sticky left = 前序固定列累计宽；末位固定列加分隔线类）。 */
  const pinStyle = (colKey: string): { left: number } | undefined => {
    const left = pinOffsets.get(colKey);
    return left === undefined ? undefined : { left };
  };
  const lastPinnedKey = [...renderColumns].reverse().find((c) => pinnedSet.has(c.key))?.key;

  // —— 筛选 + 排序行集（语义照搬 mindgrid：命中保祖先、未命中淡化；排序=各同级组内） ——

  const filtering =
    filters.keyword.trim() !== '' ||
    filters.owners.size > 0 ||
    filters.statuses.size > 0 ||
    filters.overdueOnly ||
    filters.unassignedOnly;

  /** childrenOf 的本地类型收窄：shared 签名返回 DeriveNode[]，但输入即本数组（零变换），
   *  元素实为 RowNode——断言安全。 */
  const kidsOf = (parentId: string | null): RowNode[] => childrenOf(nodes, parentId) as RowNode[];

  const matchNode = (n: RowNode): boolean => {
    const t = n.task;
    const kw = filters.keyword.trim().toLowerCase();
    if (kw !== '' && !n.title.toLowerCase().includes(kw)) return false;
    const owners = t?.owners ?? [];
    if (filters.owners.size > 0 && !owners.some((o) => filters.owners.has(o))) return false;
    if (filters.statuses.size > 0 && !filters.statuses.has(t?.status ?? 'todo')) return false;
    if (filters.overdueOnly && !isOverdue(n, nodes)) return false;
    if (filters.unassignedOnly && owners.length > 0) return false;
    return true;
  };

  const rows = useMemo<Row[]>(() => {
    const keep = new Set<string>();
    if (filtering) {
      const mark = (n: RowNode): boolean => {
        const kidHit = kidsOf(n.id)
          .map(mark)
          .some(Boolean);
        if (matchNode(n) || kidHit) {
          keep.add(n.id);
          return true;
        }
        return false;
      };
      kidsOf(ROOT_NODE_ID).forEach(mark);
    }
    const cmp = (a: RowNode, b: RowNode): number => {
      if (!sort) return (a.order ?? 0) - (b.order ?? 0);
      return compareByColumn(sort.key, sort.dir, a, b);
    };
    const out: Row[] = [];
    const walk = (parentId: string, depth: number): void => {
      let list = kidsOf(parentId);
      if (filtering) list = list.filter((n) => keep.has(n.id));
      if (sort) list = [...list].sort(cmp);
      for (const n of list) {
        const kids = kidsOf(n.id);
        out.push({ node: n, depth, hasChildren: kids.length > 0, dimmed: filtering && !matchNode(n) });
        if (!n.collapsed || filtering) walk(n.id, depth + 1);
      }
    };
    if (!rootCollapsed) walk(ROOT_NODE_ID, 0);
    return out;
    // memberIndex 入 deps：人员列按昵称排序，成员候选异步到达后需重算；sort 以
    // 标量键入 deps（tableView 每渲染直读、对象身份每渲染变化，不作为依赖）
  }, [nodes, filters, sortKey, sortDir, filtering, rootCollapsed, memberIndex, customColumns]);

  /** 三态排序（升→降→取消；显示层不动树结构）：编辑者持久化到 tableView.sort，
   *  查看者仅本地态；取消恢复树序。 */
  const toggleSort = (key: string): void => {
    const next: TableViewSort | null =
      !sort || sort.key !== key ? { key, dir: 1 } : sort.dir === 1 ? { key, dir: -1 } : null;
    if (readOnly) {
      setLocalSort(next);
      return;
    }
    commitTableView({ sort: next });
  };

  const sortMark = (key: string): string =>
    sort?.key === key ? (sort.dir === 1 ? ' ↑' : ' ↓') : '';

  // Esc 关闭全部浮层（菜单/弹层/筛选下拉/列管理浮层）
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key !== 'Escape') return;
      setMenu(null);
      setOwnerCellOpen(null);
      setOwnerFilterOpen(false);
      setStatusFilterOpen(false);
      setColAddOpen(false);
      setColMenu(null);
      setCustomPersonOpen(null);
      setColSettingsOpen(false);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  // —— 写动作（全部 core op + afterUserWrite；异常两段式透出） ——

  const commitTask = (id: string, patch: TaskPatch): void => {
    try {
      setNodeTask(doc, id, patch);
      afterUserWrite();
    } catch (e) {
      showToast(e instanceof Error ? e.message : '任务字段保存失败，请调整后重试');
    }
  };

  // —— 自定义列写动作（schema 整表替换 / 单字段写；core 校验两段式文案 toast 透出）——

  /** 列 schema 提交：增/删/改名/重排在页面侧组好新数组后一次替换（删列孤儿清理由
   *  core 同事务完成，撤销一体回滚）。 */
  const commitColumns = (next: CustomColumnDef[]): void => {
    try {
      setCustomColumns(doc, next);
      afterUserWrite();
    } catch (e) {
      showToast(e instanceof Error ? e.message : '自定义列保存失败，请调整后重试');
    }
  };

  /** 单元格自定义值写入（null=清空；即改即存 + afterUserWrite）。 */
  const commitCustomField = (
    id: string,
    colId: string,
    value: string | string[] | number | null,
  ): void => {
    try {
      setCustomField(doc, id, colId, value);
      afterUserWrite();
    } catch (e) {
      showToast(e instanceof Error ? e.message : '自定义列保存失败，请调整后重试');
    }
  };

  /** 加列：追加到末尾（名称/类型经 core 校验，空名/超限由 toast 透出）。 */
  const addColumn = (): void => {
    const name = addName.trim();
    if (name === '') return;
    commitColumns([...customColumns, { id: newColumnId(), name, type: addType }]);
    setAddName('');
    setColAddOpen(false);
  };

  /** 删列：confirm 二次确认（文案说明将清除该列所有节点的值），孤儿值清理由 core
   *  在同一事务完成（可用 Ctrl+Z 整体撤销）。 */
  const removeColumn = (col: CustomColumnDef): void => {
    if (!window.confirm(`确定删除自定义列「${col.name}」？该列所有节点的值将被一并清除（可用 Ctrl+Z 撤销）`)) {
      return;
    }
    commitColumns(customColumns.filter((c) => c.id !== col.id));
  };

  // —— 表格视图持久态写动作（统一列模型；core setTableView 唯一写入口，system
  //     origin 视图态裁定：不进撤销栈、不标 lastEditor，异常两段式 toast 透出）——

  /** 视图写入的同步重渲染钩子：值本身不用（tableView 每渲染直读 doc，写入后必为
   *  新值），只借 setState 驱动「与用户操作同一事件批次」的 React 提交——否则受控
   *  复选框（列设置勾选）在事件尾被 React 恢复成旧 props，一帧后才被 rAF 推进的
   *  docVersion 重渲染纠正（可感知回弹 / e2e check 振荡）。 */
  const [, bumpViewRev] = useState(0);

  /** tableView 局部变更提交：与当前值合并成完整形状一次写入（core canonical 归一 +
   *  同值守卫兜底；缺省字段按文档现值/缺省序补齐）。 */
  const commitTableView = (change: Partial<TableViewMeta>): void => {
    const cur: TableViewMeta =
      tableView ?? {
        order: [...TABLE_BUILTIN_COLUMN_KEYS, ...customColumns.map((c) => c.id)],
        hidden: [],
        pinned: [],
        sort: null,
      };
    try {
      setTableView(doc, { ...cur, ...change });
      bumpViewRev((v) => v + 1);
    } catch (e) {
      showToast(e instanceof Error ? e.message : '表格视图配置保存失败，请刷新后重试');
    }
  };

  /** 列显隐切换（列设置浮层复选 + 列头菜单「隐藏此列」同入口）：key 进出 hidden；
   *  'title' 由 core 层不可隐藏裁定兜底（UI 侧本就不给入口）。 */
  const setColumnHidden = (key: string, hidden: boolean): void => {
    const cur = tableView?.hidden ?? [];
    const next = hidden ? [...cur, key] : cur.filter((k) => k !== key);
    if (JSON.stringify(cur) === JSON.stringify(next)) return; // 未变更零写入
    commitTableView({ hidden: next });
  };

  /** 列固定切换：key 进出 pinned（固定列渲染分区前置，sticky 左侧冻结）。 */
  const toggleColumnPinned = (key: string): void => {
    const cur = tableView?.pinned ?? [];
    const next = cur.includes(key) ? cur.filter((k) => k !== key) : [...cur, key];
    commitTableView({ pinned: next });
  };

  /** 统一列序移动：与可见方向的相邻列交换 order 位（跳过隐藏列——WYSIWYG：菜单
   *  点了就要看得见动；隐藏列夹在中间时不参与交换目标）。越界静默忽略。 */
  const moveColumn = (key: string, delta: -1 | 1): void => {
    const order = allColumns.map((c) => c.key);
    const visibleSeq = order.filter((k) => !hiddenSet.has(k));
    const idx = visibleSeq.indexOf(key);
    const to = idx + delta;
    if (idx < 0 || to < 0 || to >= visibleSeq.length) return;
    const neighbor = visibleSeq[to];
    const a = order.indexOf(key);
    const b = order.indexOf(neighbor);
    const next = [...order];
    [next[a], next[b]] = [next[b], next[a]];
    commitTableView({ order: next });
  };

  const toggleRow = (id: string): void => {
    try {
      toggleCollapse(doc, id);
    } catch (e) {
      showToast(e instanceof Error ? e.message : '操作失败，请刷新后重试');
    }
  };

  /** 展开该行的所有子级 / 折叠该行的所有子级：整子树置位（含自身）。 */
  const setCollapsedDeep = (id: string, collapsed: boolean): void => {
    try {
      withTransaction(doc, ORIGIN_SYSTEM, () => {
        for (const nid of subtreeIds(doc, id)) {
          const snap = getNode(doc, nid);
          if (!snap || snap.deleted || snap.childIds.length === 0) continue;
          if (snap.collapsed !== collapsed) setCollapsed(doc, nid, collapsed);
        }
      });
    } catch (e) {
      showToast(e instanceof Error ? e.message : '操作失败，请刷新后重试');
    }
  };

  /** 展开全部/折叠全部：root 保持展开（折叠 root 会清空整表，留一级任务可见）。 */
  const setAllCollapsed = (collapsed: boolean): void => {
    try {
      withTransaction(doc, ORIGIN_SYSTEM, () => {
        for (const nid of subtreeIds(doc, ROOT_NODE_ID)) {
          if (nid === ROOT_NODE_ID) continue;
          const snap = getNode(doc, nid);
          if (!snap || snap.deleted || snap.childIds.length === 0) continue;
          if (snap.collapsed !== collapsed) setCollapsed(doc, nid, collapsed);
        }
      });
    } catch (e) {
      showToast(e instanceof Error ? e.message : '操作失败，请刷新后重试');
    }
  };

  /** 按当前列排序直属子级：统一比较器（compareByColumn，自定义列同支持）→ moveNode
   *  批量重排（单事务，可撤销）。显示层排序（表头点击）不动结构，本入口是显式的
   *  结构化重排。 */
  const sortChildrenByField = (parentId: string, key: string, dir: 1 | -1): void => {
    const kids = childrenOf(nodes, parentId);
    if (kids.length < 2) return;
    const sorted = [...kids].sort((a, b) => compareByColumn(key, dir, a as RowNode, b as RowNode));
    try {
      withTransaction(doc, ORIGIN_USER, () => {
        sorted.forEach((k, i) => moveNode(doc, k.id, parentId, i));
      });
      afterUserWrite();
    } catch (e) {
      showToast(e instanceof Error ? e.message : '排序失败，请刷新后重试');
    }
  };

  /** + 添加子任务：建节点并预填默认名（分支主题 N/子主题 N，与画布统一——
   *  2026-10-09 裁定）→ 立即进入标题行内编辑（输入 onFocus 全选，敲字即覆盖；
   *  清空提交/Esc 回收，画布同款）。 */
  const addChildTo = (parentId: string): void => {
    if (readOnly) return;
    if (checkQuota()) return;
    try {
      if (getNode(doc, parentId)?.collapsed) setCollapsed(doc, parentId, false); // 折叠中新建先展开
      // 序号计算在事务外（校验先于事务纪律）。
      const defaultText = nextChildText(doc, parentId);
      let createdId = '';
      withTransaction(doc, ORIGIN_USER, () => {
        createdId = addChild(doc, parentId, { text: defaultText });
      });
      afterUserWrite();
      // node_add 埋点：表格无独立 via 枚举值，并入 context（创建即上报，取消不回滚）
      track('node_add', { via: 'context', nodeCount: countAliveReachable(doc) }, fileId);
      if (createdId !== '') setCellEdit({ id: createdId, isNew: true });
    } catch (e) {
      showToast(e instanceof Error ? e.message : '新建失败，请重试');
    }
  };

  /** 标题提交：新建空提交 = 回收节点；既有节点空提交 = 不写（防误清空）。 */
  const commitTitle = (id: string, text: string, isNew: boolean): void => {
    const next = text.trim();
    if (isNew && next === '') {
      try {
        withTransaction(doc, ORIGIN_USER, () => {
          deleteNodes(doc, [id]);
        });
        afterUserWrite();
      } catch {
        // 尽力而为：回收失败仅残留一个空节点，可手动删除
      }
      return;
    }
    if (next === '') return;
    if (getNode(doc, id)?.text === next) return; // 未变更零写入
    try {
      setText(doc, id, next, ORIGIN_USER);
      afterUserWrite();
    } catch (e) {
      showToast(e instanceof Error ? e.message : '保存失败，请重试');
    }
  };

  /** 描述提交（M7c-C1）：空串=清除；未变更零写入；超长由输入 maxLength=200 前置约束，
   *  兜底走 core DESCRIPTION_TOO_LONG 两段式 toast。 */
  const commitDescription = (id: string, description: string): void => {
    const next = description.trim();
    if ((getNode(doc, id)?.description ?? '') === next) return; // 未变更零写入
    try {
      setDescription(doc, id, next, ORIGIN_USER);
      afterUserWrite();
    } catch (e) {
      showToast(e instanceof Error ? e.message : '描述保存失败，请精简后重试');
    }
  };

  /** 固定列单元格类名（sticky 主体 + 末位右缘分隔线）。 */
  const pinCls = (colKey: string): string => {
    if (!pinnedSet.has(colKey)) return '';
    return colKey === lastPinnedKey ? 'tt-pinned-cell tt-pinned-edge' : 'tt-pinned-cell';
  };

  /** 统一列单元格渲染（内置/自定义同分派，随 renderColumns 顺序输出；固定列附
   *  sticky 类与偏移——任务名列 pin 时行内编辑/折叠钮等交互全部保留）。
   *  各列 testid 契约保持历史后缀（title/owners/status/progress/startDate/dueDate/
   *  doneDate/updatedAt/table-custom-cell），不因列序可变而改。 */
  const renderBodyCell = (
    col: ColumnDef,
    node: RowNode,
    depth: number,
    hasChildren: boolean,
  ): React.ReactElement => {
    const pinned = pinCls(col.key);
    const pinSt = pinStyle(col.key);
    const task = node.task;
    const owners = task?.owners ?? [];
    const status = task?.status ?? 'todo';
    const statusMeta = STATUS_META[status];
    const overdue = isOverdue(node, nodes);
    const eff = effectiveProgress(nodes, node.id);
    switch (col.key) {
      case 'title':
        return (
          <td
            key={col.key}
            data-testid={`table-cell-${node.id}-title`}
            data-col-key={col.key}
            className={pinned || undefined}
            style={pinSt}
          >
            {/* 双击编辑入口仅挂标题文字 span（2026-10-01 需求方反馈任务 5）：标题格
                空白/状态点/标记区域与行其他区域双击一律无操作——此前 handler 挂整个
                td，双击格内任意位置都会进编辑，误触频发。 */}
            {cellEdit?.id === node.id ? (
              <TitleCellEditor
                initial={node.title}
                initialDescription={node.description}
                onCommit={(text, description) => {
                  setCellEdit(null);
                  if (cellEdit.isNew && text.trim() === '') {
                    if (description.trim() === '') {
                      commitTitle(node.id, '', true); // 新建且全空：回收节点，不写描述
                      return;
                    }
                    // 新建但已填描述：节点保留（标题空=显示「未命名」），只落盘描述
                    commitDescription(node.id, description);
                    return;
                  }
                  commitTitle(node.id, text, cellEdit.isNew);
                  commitDescription(node.id, description);
                }}
                onCancel={() => {
                  setCellEdit(null);
                  if (cellEdit.isNew) commitTitle(node.id, '', true);
                }}
              />
            ) : (
              <>
                <div className="tt-title-line" style={{ paddingLeft: depth * 22 }}>
                  {hasChildren ? (
                    <button
                      type="button"
                      className="tt-caret"
                      aria-label={node.collapsed ? '展开' : '折叠'}
                      onClick={() => toggleRow(node.id)}
                    >
                      {node.collapsed ? '▸' : '▾'}
                    </button>
                  ) : (
                    <span className="tt-caret-space" />
                  )}
                  <span className="tt-dot" style={{ background: statusMeta.color }} />
                  <NodeMarkers icons={node.icons} />
                  <span
                    className="tt-title-text"
                    title={node.title}
                    onClick={() => onSelectNode(node.id)}
                    onDoubleClick={(e) => {
                      // 双击标题文字 = 行内编辑（2026-10-01 需求方反馈任务 5 收窄口径：
                      // 仅此处触发；「（未命名）」占位文本也在 span 内，仍可双击进编辑）。
                      e.stopPropagation();
                      if (!readOnly) setCellEdit({ id: node.id, isNew: false });
                    }}
                  >
                    {node.title || '（未命名）'}
                  </span>
                  {overdue && (
                    <span className="tt-overdue-badge" title={`预期 ${task?.dueDate} 已逾期`}>
                      逾
                    </span>
                  )}
                  {!readOnly && (
                    <button
                      type="button"
                      className="tt-add-child"
                      title="添加子任务"
                      aria-label="添加子任务"
                      onClick={() => addChildTo(node.id)}
                    >
                      +
                    </button>
                  )}
                </div>
                {/* 描述第二行（2026-10-01 需求方反馈任务 2，对齐 mindgrid
                    TreeTable：标题行下方 12px 灰字、单行省略、title 悬停看
                    全文；有描述才渲染，无独立描述列）。缩进 35px = 折叠钮
                    18 + gap 5 + 状态点 7 + gap 5，对齐标题文本起点。 */}
                {node.description !== '' && (
                  <div className="tt-title-desc" style={{ paddingLeft: depth * 22 + 35 }} title={node.description}>
                    {node.description}
                  </div>
                )}
              </>
            )}
          </td>
        );
      case 'owner':
        return (
          <td key={col.key} data-testid={`table-cell-${node.id}-owners`} data-col-key={col.key} className={pinned || undefined} style={pinSt}>
            {readOnly ? (
              <span className="tt-date-text">
                {owners.length > 0 ? owners.map(nicknameOf).join('、') : '未分配'}
              </span>
            ) : (
              <span className="tt-pop-anchor">
                <button
                  type="button"
                  className="tt-owners-btn"
                  title="点击指派负责人（可多选）"
                  onClick={() => setOwnerCellOpen(ownerCellOpen === node.id ? null : node.id)}
                >
                  {owners.length === 0 ? (
                    <span className="tt-owners-empty">未分配</span>
                  ) : (
                    <>
                      <span className="tt-avatars">
                        {owners.slice(0, 3).map((o) => (
                          <Avatar key={o} userId={o} nickname={nicknameOf(o)} />
                        ))}
                      </span>
                      <span className="tt-owner-names">
                        {owners.slice(0, 2).map(nicknameOf).join('、')}
                        {owners.length > 2 && <span style={{ color: '#86909c' }}> +{owners.length - 2}</span>}
                      </span>
                    </>
                  )}
                </button>
                {ownerCellOpen === node.id && (
                  <>
                    <div
                      className="tt-overlay"
                      onClick={() => setOwnerCellOpen(null)}
                      onContextMenu={(e) => {
                        e.preventDefault();
                        setOwnerCellOpen(null);
                      }}
                    />
                    <div className="tt-popover">
                      {[...memberIndex.values()].map((m) => {
                        const on = owners.includes(m.userId);
                        const color = colorForUser(m.userId);
                        return (
                          <button
                            key={m.userId}
                            type="button"
                            className="tt-chip"
                            style={on ? chipActive(color) : undefined}
                            onClick={() =>
                              commitTask(node.id, {
                                owners: on ? owners.filter((o) => o !== m.userId) : [...owners, m.userId],
                              })
                            }
                          >
                            <Avatar userId={m.userId} nickname={m.nickname} size={14} />
                            {m.nickname}
                          </button>
                        );
                      })}
                      {memberIndex.size === 0 && (
                        <span className="tt-pop-empty">暂无文档成员，邀请协作者后可指派</span>
                      )}
                    </div>
                  </>
                )}
              </span>
            )}
          </td>
        );
      case 'status':
        return (
          <td key={col.key} data-testid={`table-cell-${node.id}-status`} data-col-key={col.key} className={pinned || undefined} style={pinSt}>
            {readOnly ? (
              <span className="tt-status-label" style={{ color: statusMeta.color, background: statusMeta.bg }}>
                <span className="tt-dot" style={{ background: statusMeta.color }} />
                {statusMeta.label}
              </span>
            ) : (
              <select
                className="tt-status"
                style={{ color: statusMeta.color }}
                aria-label="任务状态"
                value={status}
                onChange={(e) => commitTask(node.id, { status: e.target.value as TaskStatus })}
              >
                {STATUS_KEYS.map((s) => (
                  <option key={s} value={s}>
                    {STATUS_META[s].label}
                  </option>
                ))}
              </select>
            )}
          </td>
        );
      case 'progress':
        return (
          <td
            key={col.key}
            data-testid={`table-cell-${node.id}-progress`}
            data-col-key={col.key}
            className={pinned || undefined}
            style={pinSt}
            onDoubleClick={(e) => {
              if (readOnly || hasChildren) return; // 父级只读（Σ 自动值）；叶子进入编辑
              e.stopPropagation();
              setProgressEditId(node.id);
            }}
          >
            {hasChildren ? (
              <MiniBar value={eff} danger={overdue} auto />
            ) : progressEditId === node.id && !readOnly ? (
              <ProgressEditor
                value={task?.progress ?? 0}
                onCommit={(v) => {
                  setProgressEditId(null);
                  if (v !== (task?.progress ?? 0)) commitTask(node.id, { progress: v });
                }}
                onClose={() => setProgressEditId(null)}
              />
            ) : (
              <MiniBar value={task?.progress ?? 0} danger={overdue} />
            )}
          </td>
        );
      case 'startDate':
        return (
          <td key={col.key} data-testid={`table-cell-${node.id}-startDate`} data-col-key={col.key} className={pinned || undefined} style={pinSt}>
            {readOnly ? (
              <span className="tt-date-text">{task?.startDate ?? '—'}</span>
            ) : (
              <SmartDateInput
                value={task?.startDate ?? null}
                onCommit={(v) => {
                  if (v !== (task?.startDate ?? null)) commitTask(node.id, { startDate: v });
                }}
              />
            )}
          </td>
        );
      case 'dueDate':
        return (
          <td key={col.key} data-testid={`table-cell-${node.id}-dueDate`} data-col-key={col.key} className={pinned || undefined} style={pinSt}>
            {readOnly ? (
              <span className="tt-date-text" style={overdue ? { color: '#f53f3f' } : undefined}>
                {task?.dueDate ?? '—'}
              </span>
            ) : (
              <SmartDateInput
                value={task?.dueDate ?? null}
                overdue={overdue}
                today={task?.dueDate === today}
                onCommit={(v) => {
                  if (v !== (task?.dueDate ?? null)) commitTask(node.id, { dueDate: v });
                }}
              />
            )}
          </td>
        );
      case 'doneDate':
        return (
          <td key={col.key} data-testid={`table-cell-${node.id}-doneDate`} data-col-key={col.key} className={pinned || undefined} style={pinSt}>
            {readOnly ? (
              <span className="tt-date-text">{task?.doneDate ?? '—'}</span>
            ) : (
              <SmartDateInput
                value={task?.doneDate ?? null}
                done={task?.doneDate != null}
                onCommit={(v) => {
                  if (v !== (task?.doneDate ?? null)) commitTask(node.id, { doneDate: v });
                }}
              />
            )}
          </td>
        );
      case 'updatedAt':
        return (
          <td
            key={col.key}
            className={[pinned, 'tt-updated'].filter(Boolean).join(' ') || undefined}
            data-testid={`table-cell-${node.id}-updatedAt`}
            data-col-key={col.key}
            style={pinSt}
          >
            {fmtUpdated(node.updatedAt ?? 0)}
          </td>
        );
      default: {
        // 自定义列单元格：按类型分派编辑器（text=点击变输入框 blur 提交、person=弹层
        // 复用 MemberMultiSelect、progress=双击 ProgressEditor、date=SmartDateInput）；
        // custom 值不参与派生（父级无 Σ，全部可编）。远端删列竞态（schema 无此列但
        // canonical 尚未收敛的渲染帧）渲染空格占位。
        const c = col.custom;
        if (!c) return <td key={col.key} data-col-key={col.key} />;
        const value = node.custom[c.id];
        const editing = customEdit?.nodeId === node.id && customEdit.colId === c.id;
        const personOpen = customPersonOpen?.nodeId === node.id && customPersonOpen.colId === c.id;
        return (
          <td
            key={col.key}
            className={[pinned, 'tt-custom-cell'].filter(Boolean).join(' ') || undefined}
            data-testid="table-custom-cell"
            data-col-id={c.id}
            data-col-key={col.key}
            title={c.name}
            style={pinSt}
            onDoubleClick={(e) => {
              // 进度列双击进入编辑；其余自定义格双击只拦行折叠（不打扰编辑）
              e.stopPropagation();
              if (!readOnly && c.type === 'progress') {
                setCustomEdit({ nodeId: node.id, colId: c.id });
              }
            }}
          >
            {c.type === 'text' &&
              (readOnly ? (
                <span className="tt-date-text">
                  {typeof value === 'string' && value !== '' ? value : '—'}
                </span>
              ) : editing ? (
                <input
                  className="tt-custom-text-input"
                  data-testid="table-custom-text-input"
                  defaultValue={typeof value === 'string' ? value : ''}
                  maxLength={CUSTOM_TEXT_MAX_LENGTH}
                  placeholder="填写…"
                  aria-label={`填写 ${c.name}`}
                  autoFocus
                  onFocus={(e) => e.target.select()}
                  onClick={(e) => e.stopPropagation()}
                  onBlur={(e) => {
                    setCustomEdit(null);
                    const next = e.target.value.trim();
                    if (next === (typeof value === 'string' ? value : '')) return; // 未变更零写入
                    commitCustomField(node.id, c.id, next === '' ? null : next); // 空 = 清空
                  }}
                  onKeyDown={(e) => {
                    e.stopPropagation();
                    if (e.key === 'Enter') {
                      e.preventDefault();
                      (e.target as HTMLInputElement).blur();
                    } else if (e.key === 'Escape') {
                      e.preventDefault();
                      setCustomEdit(null); // 取消：不提交
                    }
                  }}
                />
              ) : (
                <button
                  type="button"
                  className="tt-custom-text"
                  data-testid="table-custom-text"
                  title="点击填写"
                  onClick={() => setCustomEdit({ nodeId: node.id, colId: c.id })}
                >
                  {typeof value === 'string' && value !== '' ? (
                    value
                  ) : (
                    <span className="tt-custom-empty">填写…</span>
                  )}
                </button>
              ))}
            {c.type === 'person' &&
              (() => {
                const selected =
                  Array.isArray(value) && value.every((v) => typeof v === 'string')
                    ? (value as string[])
                    : [];
                return readOnly ? (
                  <span className="tt-date-text">
                    {selected.length > 0 ? selected.map(nicknameOf).join('、') : '—'}
                  </span>
                ) : (
                  <span className="tt-pop-anchor">
                    <button
                      type="button"
                      className="tt-owners-btn"
                      title="点击选择成员（可多选）"
                      onClick={() =>
                        setCustomPersonOpen(personOpen ? null : { nodeId: node.id, colId: c.id })
                      }
                    >
                      {selected.length === 0 ? (
                        <span className="tt-custom-empty">选择成员</span>
                      ) : (
                        <>
                          <span className="tt-avatars">
                            {selected.slice(0, 3).map((o) => (
                              <Avatar key={o} userId={o} nickname={nicknameOf(o)} />
                            ))}
                          </span>
                          <span className="tt-owner-names">
                            {selected.slice(0, 2).map(nicknameOf).join('、')}
                            {selected.length > 2 && <span style={{ color: '#86909c' }}> +{selected.length - 2}</span>}
                          </span>
                        </>
                      )}
                    </button>
                    {personOpen && (
                      <>
                        <div
                          className="tt-overlay"
                          onClick={() => setCustomPersonOpen(null)}
                          onContextMenu={(e) => {
                            e.preventDefault();
                            setCustomPersonOpen(null);
                          }}
                        />
                        <div className="tt-popover">
                          <MemberMultiSelect
                            memberIndex={memberIndex}
                            selected={selected}
                            onToggle={(userId) => {
                              const next = selected.includes(userId)
                                ? selected.filter((o) => o !== userId)
                                : [...selected, userId];
                              commitCustomField(node.id, c.id, next.length > 0 ? next : null); // 清空到 0 人 = 删键
                            }}
                            testIdPrefix="table-custom-member"
                          />
                        </div>
                      </>
                    )}
                  </span>
                );
              })()}
            {c.type === 'progress' &&
              (readOnly ? (
                <span className="tt-date-text">
                  {typeof value === 'number' ? `${value}%` : '—'}
                </span>
              ) : editing ? (
                <ProgressEditor
                  value={typeof value === 'number' ? value : 0}
                  onCommit={(v) => {
                    setCustomEdit(null);
                    if (v !== (typeof value === 'number' ? value : -1)) {
                      commitCustomField(node.id, c.id, v);
                    }
                  }}
                  onClose={() => setCustomEdit(null)}
                />
              ) : typeof value === 'number' ? (
                <MiniBar value={value} />
              ) : (
                <span className="tt-custom-empty" title="双击设置进度">
                  双击填写
                </span>
              ))}
            {c.type === 'date' &&
              (readOnly ? (
                <span className="tt-date-text">{typeof value === 'string' ? value : '—'}</span>
              ) : (
                <SmartDateInput
                  value={typeof value === 'string' ? value : null}
                  onCommit={(v) => {
                    if (v !== (typeof value === 'string' ? value : null)) {
                      commitCustomField(node.id, c.id, v);
                    }
                  }}
                />
              ))}
          </td>
        );
      }
    }
  };

  const today = todayStr();

  return (
    <div className="task-table-root" role="region" aria-label="任务表格">
      {/* 筛选条 */}
      <div className="tt-filterbar">
        <input
          className="tt-keyword"
          data-testid="table-filter-keyword"
          placeholder="搜索任务名…"
          aria-label="搜索任务名"
          value={filters.keyword}
          onChange={(e) => setFilters({ ...filters, keyword: e.target.value })}
        />
        <span className="tt-pop-anchor">
          <button
            type="button"
            className="tt-chip"
            data-testid="table-filter-owner"
            aria-haspopup="true"
            aria-expanded={ownerFilterOpen}
            style={filters.owners.size > 0 ? chipActive('#3370ff') : undefined}
            onClick={() => {
              setOwnerFilterOpen((v) => !v);
              setStatusFilterOpen(false);
            }}
          >
            负责人{filters.owners.size > 0 ? ` ·${filters.owners.size}` : ''}
          </button>
          {ownerFilterOpen && (
            <>
              <div
                className="tt-overlay"
                onClick={() => setOwnerFilterOpen(false)}
                onContextMenu={(e) => {
                  e.preventDefault();
                  setOwnerFilterOpen(false);
                }}
              />
              <div className="tt-popover">
                {[...memberIndex.values()].map((m) => {
                  const on = filters.owners.has(m.userId);
                  const color = colorForUser(m.userId);
                  return (
                    <button
                      key={m.userId}
                      type="button"
                      className="tt-chip"
                      style={on ? chipActive(color) : undefined}
                      onClick={() => setFilters({ ...filters, owners: toggleInSet(filters.owners, m.userId) })}
                    >
                      <Avatar userId={m.userId} nickname={m.nickname} size={14} />
                      {m.nickname}
                    </button>
                  );
                })}
                {memberIndex.size === 0 && (
                  <span className="tt-pop-empty">暂无文档成员，邀请协作者后可按人筛选</span>
                )}
              </div>
            </>
          )}
        </span>
        <span className="tt-pop-anchor">
          <button
            type="button"
            className="tt-chip"
            data-testid="table-filter-status"
            aria-haspopup="true"
            aria-expanded={statusFilterOpen}
            style={filters.statuses.size > 0 ? chipActive('#3370ff') : undefined}
            onClick={() => {
              setStatusFilterOpen((v) => !v);
              setOwnerFilterOpen(false);
            }}
          >
            状态{filters.statuses.size > 0 ? ` ·${filters.statuses.size}` : ''}
          </button>
          {statusFilterOpen && (
            <>
              <div
                className="tt-overlay"
                onClick={() => setStatusFilterOpen(false)}
                onContextMenu={(e) => {
                  e.preventDefault();
                  setStatusFilterOpen(false);
                }}
              />
              <div className="tt-popover">
                {STATUS_KEYS.map((s) => {
                  const on = filters.statuses.has(s);
                  return (
                    <button
                      key={s}
                      type="button"
                      className="tt-chip"
                      style={on ? chipActive(STATUS_META[s].color) : undefined}
                      onClick={() => setFilters({ ...filters, statuses: toggleInSet(filters.statuses, s) })}
                    >
                      <span className="tt-dot" style={{ background: STATUS_META[s].color }} />
                      {STATUS_META[s].label}
                    </button>
                  );
                })}
              </div>
            </>
          )}
        </span>
        <button
          type="button"
          className="tt-chip"
          data-testid="table-filter-overdue"
          style={filters.overdueOnly ? chipActive('#f53f3f') : undefined}
          aria-pressed={filters.overdueOnly}
          onClick={() => setFilters({ ...filters, overdueOnly: !filters.overdueOnly })}
        >
          仅逾期
        </button>
        <button
          type="button"
          className="tt-chip"
          data-testid="table-filter-unassigned"
          style={filters.unassignedOnly ? chipActive('#ff8800') : undefined}
          aria-pressed={filters.unassignedOnly}
          onClick={() => setFilters({ ...filters, unassignedOnly: !filters.unassignedOnly })}
        >
          仅未分配
        </button>
        {filtering && (
          <button type="button" className="tt-clear" onClick={() => setFilters(EMPTY_FILTERS)}>
            清空
          </button>
        )}
        {/* 列设置入口（需求方 2026-10-01 列体系升级）：全列显隐勾选清单浮层；
            非只读专属（显隐是持久化视图态，查看者不可改）。 */}
        {!readOnly && (
          <span className="tt-pop-anchor">
            <button
              type="button"
              className="tt-chip"
              data-testid="table-col-settings"
              aria-haspopup="true"
              aria-expanded={colSettingsOpen}
              title="列设置（显示/隐藏列）"
              onClick={() => setColSettingsOpen((v) => !v)}
            >
              列设置
            </button>
            {colSettingsOpen && (
              <>
                <div
                  className="tt-overlay"
                  onClick={() => setColSettingsOpen(false)}
                  onContextMenu={(e) => {
                    e.preventDefault();
                    setColSettingsOpen(false);
                  }}
                />
                <div className="tt-popover tt-col-settings-pop" role="group" aria-label="列显示设置">
                  <div className="tt-col-settings-title">列显示</div>
                  {allColumns.map((col) => {
                    const shown = !hiddenSet.has(col.key);
                    const locked = col.key === 'title'; // 任务名不可隐藏（core 裁定）
                    return (
                      <label
                        key={col.key}
                        className="tt-col-setting-row"
                        data-testid={`table-col-toggle-${col.key}`}
                        title={locked ? '任务列为行锚点，不可隐藏' : undefined}
                      >
                        <input
                          type="checkbox"
                          checked={shown}
                          disabled={locked}
                          onChange={(e) => setColumnHidden(col.key, e.target.checked ? false : true)}
                        />
                        <span className="tt-col-setting-name" title={col.label}>
                          {col.label}
                        </span>
                        {pinnedSet.has(col.key) && <span className="tt-col-setting-pin" title="已固定在左侧">固</span>}
                      </label>
                    );
                  })}
                </div>
              </>
            )}
          </span>
        )}
        <span className="tt-spacer" />
        <span className="tt-count" data-testid="table-row-count">
          {rows.length} 行
        </span>
      </div>

      {/* 表体（自定义列按可见列数扩 min-width，避免挤压内置列） */}
      <div className="tt-scroll">
        <table
          className="tt-table"
          ref={tableRef}
          style={
            renderColumns.some((c) => !c.builtin)
              ? { minWidth: 1120 + renderColumns.filter((c) => !c.builtin).length * 130 }
              : undefined
          }
        >
          <thead>
            <tr>
              <th className="tt-rownum" title="行号">
                #
              </th>
              {/* 统一列头（内置/自定义同款）：点击=三态排序；悬停 ⋯/右键=列管理菜单
                  （左移/右移/隐藏/固定 + 自定义列独有重命名/删除）；固定列 sticky 左置。 */}
              {renderColumns.map((col) => {
                const pinned = pinnedSet.has(col.key);
                const isLastPinned = pinned && col.key === lastPinnedKey;
                const cls = [
                  col.builtin ? 'tt-sortable' : 'tt-custom-col tt-sortable',
                  pinned ? 'tt-pinned-cell' : '',
                  isLastPinned ? 'tt-pinned-edge' : '',
                ]
                  .filter(Boolean)
                  .join(' ');
                return (
                  <th
                    key={col.key}
                    className={cls}
                    data-col-key={col.key}
                    data-testid={col.builtin ? 'table-builtin-col-header' : 'table-custom-col-header'}
                    data-col-id={col.custom ? col.key : undefined}
                    style={{ ...(col.key === 'title' ? { width: '32%' } : null), ...pinStyle(col.key) }}
                    onClick={() => toggleSort(col.key)}
                    onContextMenu={(e) => {
                      e.preventDefault();
                      if (!readOnly) setColMenu({ x: e.clientX, y: e.clientY, colKey: col.key });
                    }}
                  >
                    {col.custom && renameCol === col.key && !readOnly ? (
                      <input
                        className="tt-col-rename-input"
                        data-testid="table-col-rename-input"
                        defaultValue={col.custom.name}
                        maxLength={CUSTOM_COLUMN_NAME_MAX}
                        aria-label="重命名自定义列"
                        autoFocus
                        onFocus={(e) => e.target.select()}
                        onClick={(e) => e.stopPropagation()}
                        onBlur={(e) => {
                          setRenameCol(null);
                          const next = e.target.value.trim();
                          if (next !== '' && next !== col.custom!.name) {
                            commitColumns(customColumns.map((c) => (c.id === col.key ? { ...c, name: next } : c)));
                          } // 空名/未变更零写入（core 校验兜底由提交侧透出）
                        }}
                        onKeyDown={(e) => {
                          e.stopPropagation();
                          if (e.key === 'Enter') {
                            e.preventDefault();
                            (e.target as HTMLInputElement).blur();
                          } else if (e.key === 'Escape') {
                            e.preventDefault();
                            setRenameCol(null); // 取消：不提交
                          }
                        }}
                      />
                    ) : (
                      <>
                        {col.custom && (
                          <span className="tt-col-type-mark" title={CUSTOM_TYPE_META[col.custom.type].label}>
                            {CUSTOM_TYPE_META[col.custom.type].mark}
                          </span>
                        )}
                        <span className="tt-col-name" title={col.label}>
                          {col.label}
                        </span>
                        {sortMark(col.key)}
                        {!readOnly && (
                          <button
                            type="button"
                            className="tt-col-menu-btn"
                            data-testid="table-col-menu-btn"
                            data-col-key={col.key}
                            title="列管理（移动/隐藏/固定/重命名/删除）"
                            aria-label={`管理列 ${col.label}`}
                            onClick={(e) => {
                              e.stopPropagation(); // ⋯ 只开菜单，不触发表头排序
                              const r = e.currentTarget.getBoundingClientRect();
                              setColMenu({ x: r.left, y: r.bottom + 2, colKey: col.key });
                            }}
                          >
                            ⋯
                          </button>
                        )}
                      </>
                    )}
                  </th>
                );
              })}
              {/* 加列入口：无自定义列的文档也只此一处 UI（零额外噪音）；上限 20 列置灰 */}
              {!readOnly && (
                <th className="tt-col-add-th">
                  <span className="tt-pop-anchor">
                    <button
                      type="button"
                      className="tt-col-add"
                      data-testid="table-col-add"
                      title={
                        customColumns.length >= CUSTOM_COLUMN_LIMIT
                          ? `自定义列最多 ${CUSTOM_COLUMN_LIMIT} 列，请先删除不需要的列`
                          : '添加自定义列（文本/人员/进度/日期）'
                      }
                      aria-label="添加自定义列"
                      disabled={customColumns.length >= CUSTOM_COLUMN_LIMIT}
                      onClick={() => setColAddOpen((v) => !v)}
                    >
                      +
                    </button>
                    {colAddOpen && (
                      <>
                        <div
                          className="tt-overlay"
                          onClick={() => setColAddOpen(false)}
                          onContextMenu={(e) => {
                            e.preventDefault();
                            setColAddOpen(false);
                          }}
                        />
                        <div className="tt-popover tt-col-add-pop">
                          <input
                            className="tt-col-add-name"
                            data-testid="table-col-add-name"
                            placeholder={`列名称（最多 ${CUSTOM_COLUMN_NAME_MAX} 字）`}
                            aria-label="自定义列名称"
                            value={addName}
                            maxLength={CUSTOM_COLUMN_NAME_MAX}
                            autoFocus
                            onChange={(e) => setAddName(e.target.value)}
                            onKeyDown={(e) => {
                              if (e.key === 'Enter') {
                                e.preventDefault();
                                addColumn();
                              } else if (e.key === 'Escape') {
                                e.preventDefault();
                                setColAddOpen(false);
                              }
                            }}
                          />
                          <div className="tt-col-add-types" role="radiogroup" aria-label="自定义列类型">
                            {CUSTOM_COLUMN_TYPES.map((t) => (
                              <label
                                key={t}
                                className={addType === t ? 'tt-col-type active' : 'tt-col-type'}
                                data-testid={`table-col-add-type-${t}`}
                              >
                                <input
                                  type="radio"
                                  name="tt-col-add-type"
                                  checked={addType === t}
                                  onChange={() => setAddType(t)}
                                />
                                {CUSTOM_TYPE_META[t].label}
                              </label>
                            ))}
                          </div>
                          <button
                            type="button"
                            className="tt-col-add-submit"
                            data-testid="table-col-add-submit"
                            disabled={addName.trim() === ''}
                            onClick={addColumn}
                          >
                            添加
                          </button>
                        </div>
                      </>
                    )}
                  </span>
                </th>
              )}
            </tr>
          </thead>
          <tbody>
            {rows.map(({ node, depth, hasChildren, dimmed }, rowIndex) => {
              return (
                // 行级双击折叠已移除（2026-10-01 需求方反馈任务 5）：行其他区域双击
                // 一律无操作（折叠走 ▸/▾ 折叠钮或右键菜单），避免抢「双击标题文字
                // 进编辑」的事件；右键菜单/单击选中等其余行交互不变。
                <tr
                  key={node.id}
                  data-depth={depth}
                  className={dimmed ? 'tt-dimmed' : undefined}
                  onContextMenu={(e) => {
                    e.preventDefault();
                    // 列 key 直读 data-col-key（统一列模型下列序/显隐可变，位置映射不再
                    // 可靠）；行号格无 col-key，按类名识别为 '#'
                    const td = (e.target as HTMLElement).closest('td');
                    const field =
                      td?.dataset.colKey ?? (td?.classList.contains('tt-rownum') ? '#' : 'title');
                    setMenu({ x: e.clientX, y: e.clientY, nodeId: node.id, field });
                  }}
                >
                  <td className="tt-rownum">{rowIndex + 1}</td>
                  {renderColumns.map((col) => renderBodyCell(col, node, depth, hasChildren))}
                </tr>
              );
            })}
            {rows.length === 0 && (
              <tr>
                <td colSpan={1 + renderColumns.length + (readOnly ? 0 : 1)} className="tt-empty">
                  {rootCollapsed ? (
                    '中心主题已折叠，展开后显示任务'
                  ) : filtering ? (
                    '没有匹配的任务 —— 调整筛选条件试试'
                  ) : (
                    <>
                      {/* 空文档（无筛选、0 任务）：不再误报「调整筛选条件」，给首个任务的
                          直接入口——复用行菜单/悬浮「+」同款 addChildTo(root)（含配额闸与
                          toast 错误处理，M7a-K1 #2）；新建后立即进入行内标题编辑。 */}
                      <div>暂无任务 —— 点击下方按钮或切到脑图按 Tab 创建</div>
                      {!readOnly && (
                        <button
                          type="button"
                          className="tt-empty-add"
                          data-testid="table-empty-add"
                          onClick={() => addChildTo(ROOT_NODE_ID)}
                        >
                          + 添加子任务
                        </button>
                      )}
                    </>
                  )}
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      {/* 右键行菜单（查看者只留展开/折叠项） */}
      {menu && (
        <>
          <div
            className="tt-overlay"
            onClick={() => setMenu(null)}
            onContextMenu={(e) => {
              e.preventDefault();
              setMenu(null);
            }}
          />
          <div
            className="context-menu"
            data-testid="table-row-menu"
            role="menu"
            aria-label="行菜单"
            style={{
              left: Math.min(menu.x, window.innerWidth - 200),
              top: Math.min(menu.y, window.innerHeight - 280),
            }}
          >
            <button
              data-testid="table-menu-expand-subtree"
              onClick={() => {
                setCollapsedDeep(menu.nodeId, false);
                setMenu(null);
              }}
            >
              展开该行的所有子级
            </button>
            <button
              data-testid="table-menu-collapse-subtree"
              onClick={() => {
                setCollapsedDeep(menu.nodeId, true);
                setMenu(null);
              }}
            >
              折叠该行的所有子级
            </button>
            <div className="tt-menu-sep" />
            <button
              data-testid="table-menu-expand-all"
              onClick={() => {
                setAllCollapsed(false);
                setMenu(null);
              }}
            >
              展开全部
            </button>
            <button
              data-testid="table-menu-collapse-all"
              onClick={() => {
                setAllCollapsed(true);
                setMenu(null);
              }}
            >
              折叠全部
            </button>
            {!readOnly && childrenOf(nodes, menu.nodeId).length >= 2 && menu.field !== '#' && (
              <>
                <div className="tt-menu-sep" />
                <button
                  data-testid="table-menu-sort-asc"
                  onClick={() => {
                    sortChildrenByField(menu.nodeId, menu.field, 1);
                    setMenu(null);
                  }}
                >
                  按「{colLabel(menu.field)}」升序排列子级 ↑
                </button>
                <button
                  data-testid="table-menu-sort-desc"
                  onClick={() => {
                    sortChildrenByField(menu.nodeId, menu.field, -1);
                    setMenu(null);
                  }}
                >
                  按「{colLabel(menu.field)}」降序排列子级 ↓
                </button>
              </>
            )}
            {!readOnly && (
              <>
                <div className="tt-menu-sep" />
                <button
                  data-testid="table-menu-add-child"
                  onClick={() => {
                    addChildTo(menu.nodeId);
                    setMenu(null);
                  }}
                >
                  + 添加子任务
                </button>
              </>
            )}
          </div>
        </>
      )}

      {/* 统一列头管理菜单（右键列头 / 悬停 ⋯ 钮；内置/自定义同款）：左移/右移（统一
          列序，跳过隐藏列）、隐藏此列（任务名除外——不可隐藏裁定）、固定到左侧/取消
          固定；自定义列独有重命名（行内输入）与删除（confirm，孤儿清理 core 同事务做） */}
      {colMenu && (() => {
        const col = allColumns.find((c) => c.key === colMenu.colKey);
        if (!col) return null; // 列已被删（远端并发）：菜单无目标即收
        // 可见序边界（移动跳过隐藏列的 WYSIWYG 口径，与 moveColumn 同源）
        const visibleKeys = allColumns.map((c) => c.key).filter((k) => !hiddenSet.has(k));
        const visIdx = visibleKeys.indexOf(col.key);
        const atFirst = visIdx <= 0;
        const atLast = visIdx < 0 || visIdx >= visibleKeys.length - 1;
        const pinnedNow = pinnedSet.has(col.key);
        return (
          <>
            <div
              className="tt-overlay"
              onClick={() => setColMenu(null)}
              onContextMenu={(e) => {
                e.preventDefault();
                setColMenu(null);
              }}
            />
            <div
              className="context-menu"
              data-testid="table-col-menu"
              role="menu"
              aria-label="列管理"
              style={{
                left: Math.min(colMenu.x, window.innerWidth - 210),
                top: Math.min(colMenu.y, window.innerHeight - 300),
              }}
            >
              <button
                data-testid="table-col-menu-left"
                disabled={atFirst}
                title={atFirst ? '已是最左列' : undefined}
                onClick={() => {
                  moveColumn(col.key, -1);
                  setColMenu(null);
                }}
              >
                左移
              </button>
              <button
                data-testid="table-col-menu-right"
                disabled={atLast}
                title={atLast ? '已是最右列' : undefined}
                onClick={() => {
                  moveColumn(col.key, 1);
                  setColMenu(null);
                }}
              >
                右移
              </button>
              <div className="tt-menu-sep" />
              <button
                data-testid="table-col-menu-pin"
                onClick={() => {
                  toggleColumnPinned(col.key);
                  setColMenu(null);
                }}
              >
                {pinnedNow ? `取消固定「${col.label}」` : `固定「${col.label}」到左侧`}
              </button>
              {col.key !== 'title' && (
                <button
                  data-testid="table-col-menu-hide"
                  onClick={() => {
                    setColumnHidden(col.key, true);
                    setColMenu(null);
                  }}
                >
                  隐藏「{col.label}」
                </button>
              )}
              {col.custom && (
                <>
                  <div className="tt-menu-sep" />
                  <button
                    data-testid="table-col-menu-rename"
                    onClick={() => {
                      setRenameCol(col.key);
                      setColMenu(null);
                    }}
                  >
                    重命名「{col.label}」
                  </button>
                  <button
                    data-testid="table-col-menu-delete"
                    onClick={() => {
                      setColMenu(null);
                      removeColumn(col.custom!);
                    }}
                  >
                    删除列「{col.label}」…
                  </button>
                </>
              )}
            </div>
          </>
        );
      })()}
    </div>
  );
}

// ---------------------------------------------------------------------------
// 子组件（NodeMarkers/TitleCellEditor/ProgressEditor 本文件留置——表格专属；
// Avatar/SmartDateInput 等跨视图共用件已抽至 TaskFields.tsx，M7c-C3/C4 同源）
// ---------------------------------------------------------------------------

/** 八组标记展示（M7b-W1 多值数组；组序 MARKER_ROW_ORDER，目录外值忽略）。
 *  chip 几何 2026-10-01 需求方反馈任务 1 起单源化：全部经 MarkerPanel 的
 *  MarkerChip（engine drawMarkerBadge SVG 徽章，<svg viewBox="0 0 14 14"> 包裹
 *  + 定宽高 14 + flex:none 防压缩）渲染，与画布/面板同一字形来源。此前表格手写
 *  CSS chip（tt-icon-mark 文本 + conic-gradient 圆）与 M7b-R1 面板同病：无自定义
 *  kind 分支（star/heart/bulb/mood 等回落纯文本字符）、无定宽高（tt-mark-round
 *  类在 CSS 中不存在，圆徽靠 11px 文本撑高被压扁）。外层经 markerGroup/
 *  markerValue 透传 data-marker-* 属性（与画布 g.gm-marker-badge 同名，e2e 同口径
 *  定位）；悬停 title=目录中文 label（与徽章 SVG <title> 同文案）。 */
function NodeMarkers({ icons }: { icons: Record<string, string[]> }): React.ReactElement | null {
  const chips: React.ReactElement[] = [];
  for (const group of MARKER_ROW_ORDER) {
    for (const value of icons[group] ?? []) {
      const def = markerDefOf(group, value);
      if (!def) continue; // 目录外值（未收敛窗口期）：确定性忽略
      chips.push(
        <MarkerChip
          key={`${group}-${value}`}
          def={def}
          size={14}
          title={def.label}
          markerGroup={group}
          markerValue={value}
        />,
      );
    }
  }
  if (chips.length === 0) return null;
  return <span className="tt-markers">{chips}</span>;
}

/** 进度迷你条（danger=逾期红；auto=父级 Σ 自动值）。 */
function MiniBar({ value, danger, auto }: { value: number; danger?: boolean; auto?: boolean }) {
  const fill = danger ? '#f53f3f' : value >= 100 ? '#34c724' : '#3370ff';
  return (
    <span className="tt-bar-wrap">
      <span className="tt-bar">
        <span className="tt-bar-fill" style={{ width: `${value}%`, background: fill }} />
      </span>
      <span className="tt-bar-num" style={danger ? { color: '#f53f3f' } : undefined}>
        {value}%
      </span>
      {auto && (
        <span className="tt-bar-sigma" title="由子任务自动汇总">
          Σ
        </span>
      )}
    </span>
  );
}

/**
 * 任务名+描述两行式行内编辑（M7c-C1，升级自单行 TitleCellEditor，对齐 mindgrid
 * QuickEditor：https://语义同源——标题框 Tab 切到描述框、描述框 Tab=提交）；
 * Enter 提交、Esc 取消、容器失焦提交（焦点在两框间移动不触发）。
 * 描述经 setDescription 落盘（≤200 由输入 maxLength 前置约束）；不冒泡行折叠/双击。
 */
function TitleCellEditor({
  initial,
  initialDescription,
  onCommit,
  onCancel,
}: {
  initial: string;
  initialDescription: string;
  onCommit: (text: string, description: string) => void;
  onCancel: () => void;
}) {
  const [value, setValue] = useState(initial);
  const [desc, setDesc] = useState(initialDescription);
  const titleRef = useRef<HTMLInputElement>(null);
  const descRef = useRef<HTMLInputElement>(null);
  const doneRef = useRef(false);
  // 提交读草稿走 ref：finish 由 onBlur 等闭包调用时取最新输入值（与 state 解耦）。
  const valueRef = useRef(value);
  const descValueRef = useRef(desc);
  valueRef.current = value;
  descValueRef.current = desc;
  useEffect(() => {
    titleRef.current?.focus();
    titleRef.current?.select();
  }, []);
  const finish = (commit: boolean): void => {
    if (doneRef.current) return;
    doneRef.current = true;
    if (commit) onCommit(valueRef.current, descValueRef.current);
    else onCancel();
  };
  return (
    <div
      className="tt-quick-editor"
      onClick={(e) => e.stopPropagation()}
      onDoubleClick={(e) => e.stopPropagation()}
      onBlur={(e) => {
        // 焦点在标题/描述两框间移动（relatedTarget 仍在容器内）不提交；离开容器才提交。
        if (!e.currentTarget.contains(e.relatedTarget as Node)) finish(true);
      }}
    >
      <input
        ref={titleRef}
        className="tt-title-input"
        data-testid="table-title-input"
        value={value}
        aria-label="任务标题"
        placeholder="任务标题…"
        onChange={(e) => setValue(e.target.value)}
        onKeyDown={(e) => {
          e.stopPropagation();
          if (e.key === 'Enter') {
            e.preventDefault();
            finish(true);
          } else if (e.key === 'Escape') {
            e.preventDefault();
            finish(false);
          } else if (e.key === 'Tab') {
            e.preventDefault();
            descRef.current?.focus();
          }
        }}
      />
      <input
        ref={descRef}
        className="tt-desc-input"
        data-testid="table-desc-input"
        value={desc}
        maxLength={200}
        aria-label="任务描述"
        placeholder="描述（Tab 切换，可留空）"
        onChange={(e) => setDesc(e.target.value)}
        onKeyDown={(e) => {
          e.stopPropagation();
          if (e.key === 'Enter' || (e.key === 'Tab' && !e.shiftKey)) {
            e.preventDefault();
            finish(true);
          } else if (e.key === 'Escape') {
            e.preventDefault();
            finish(false);
          } else if (e.key === 'Tab') {
            e.preventDefault(); // Shift+Tab 回标题框
            titleRef.current?.focus();
          }
        }}
      />
    </div>
  );
}

/** 进度就地编辑：Enter/失焦提交（钳 0-100 取整），Esc 取消；不冒泡行折叠。 */
function ProgressEditor({
  value,
  onCommit,
  onClose,
}: {
  value: number;
  onCommit: (v: number) => void;
  onClose: () => void;
}) {
  const ref = useRef<HTMLInputElement>(null);
  const doneRef = useRef(false);
  useEffect(() => {
    ref.current?.focus();
    ref.current?.select();
  }, []);
  const finish = (commit: boolean): void => {
    if (doneRef.current) return;
    doneRef.current = true;
    if (commit) {
      const n = Math.max(0, Math.min(100, Math.round(Number(ref.current?.value) || 0)));
      onCommit(n);
    }
    onClose();
  };
  return (
    <input
      ref={ref}
      type="number"
      min={0}
      max={100}
      defaultValue={value}
      className="tt-progress-input"
      aria-label="任务进度"
      onClick={(e) => e.stopPropagation()}
      onDoubleClick={(e) => e.stopPropagation()}
      onKeyDown={(e) => {
        e.stopPropagation();
        if (e.key === 'Enter') {
          e.preventDefault();
          finish(true);
        } else if (e.key === 'Escape') {
          e.preventDefault();
          finish(false);
        }
      }}
      onBlur={() => finish(true)}
    />
  );
}

