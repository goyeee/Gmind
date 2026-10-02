import { useEffect, useMemo, useRef, useState } from 'react';
import type * as Y from 'yjs';
import {
  addChild,
  countAliveReachable,
  deleteNodes,
  getNode,
  moveNode,
  ORIGIN_SYSTEM,
  ORIGIN_USER,
  ROOT_NODE_ID,
  setCollapsed,
  setDescription,
  setNodeTask,
  setText,
  subtreeIds,
  toggleCollapse,
  withTransaction,
  type NodeSnapshot,
} from '@gmind/core';
import {
  childrenOf,
  effectiveProgress,
  isOverdue,
  sortValue,
  todayStr,
  type DeriveNode,
  type TaskPatch,
  type TaskStatus,
} from '@gmind/shared';
import { MARKER_ROW_ORDER, colorForUser, drawMarkerBadge, markerChipText, markerDefOf } from '@gmind/engine';
import { api } from '../api/client';
import { track } from '../api/events';
import type { PresenceMember } from './collab';
import {
  Avatar,
  chipActive,
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
 * effectiveProgress/isOverdue/sortValue）驱动行集/进度/逾期/排序。中心主题（root）不
 * 进表，直属子级 depth=0（flattenVisible(rootId) 同口径）；root 折叠时整树收起。
 *
 * 折叠互通：折叠态落在节点 doc 字段（collapsed，Yjs 同步；脑图折叠徽标与表格折叠钮
 * 读写同一字段，经 toggleCollapse/setCollapsed 写、system origin 不进撤销栈）——双视图
 * 折叠天然同源，无需共享 UI state。
 *
 * 写纪律：全部写走 gmind-core op（setNodeTask/setText/addChild/deleteNodes/moveNode/
 * toggleCollapse/setCollapsed）+ afterUserWrite（capUndoStack/lastEditor/编辑中广播），
 * 禁止直写 Yjs；校验异常经 showToast 两段式透出。
 *
 * 已知口径（速度优先形态版）：
 * - 「更新时间」列 = 会话内观察到的最后修改时刻（observeDeep 记录，含远端），未观察
 *   过的行显示「—」（Gmind 节点无持久 updatedAt 字段，M7d 变更日志轨再议）；
 * - 负责人存用户ID；候选 = GET /files/:id/collaborators（owner+协作者）∪ presence
 *   在线成员 ∪ 文档内已出现的 ID（昵称回退），成员色 = colorForUser(userId)。
 */

/** 状态元数据（企微浅色系）与子组件（Avatar/SmartDateInput/chipActive）已抽至
 *  TaskFields.tsx（M7c-C3/C4 抽公共）：TaskTable 改为共用，交互/类名/testid 零改动。 */

/** 列定义：与 <td> 顺序一一对应（右键菜单按命中列决定排序方式）；首列行号不参与排序。 */
type SortField =
  | 'title'
  | 'owners'
  | 'status'
  | 'progress'
  | 'startDate'
  | 'dueDate'
  | 'doneDate'
  | 'updatedAt';

const COL_FIELDS = ['#', 'title', 'owners', 'status', 'progress', 'startDate', 'dueDate', 'doneDate', 'updatedAt'];
const COL_LABELS = ['序号', '任务', '负责人', '状态', '进度', '开始日期', '预期日期', '完成日期', '更新时间'];

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
 *  + 描述（M7c-C1：双击标题的两行式行内编辑初值；不进派生规则）。 */
interface RowNode extends DeriveNode {
  icons: Record<string, string[]>;
  description: string;
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

function colLabel(field: string): string {
  return COL_LABELS[COL_FIELDS.indexOf(field)] ?? '任务';
}

/** 列键 → sortValue 键（owners 列在 shared 排序键里叫 owner）。 */
function sortKeyOf(field: SortField): string {
  return field === 'owners' ? 'owner' : field;
}

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
  const [sort, setSort] = useState<{ field: SortField; dir: 1 | -1 } | null>(null);
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
      });
    }
    return out;
  }, [doc, docVersion]);

  const rootCollapsed = useMemo(
    () => getNode(doc, ROOT_NODE_ID)?.collapsed === true,
    [doc, docVersion],
  );

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
      const va = sortValue(nodes, a, sortKeyOf(sort.field));
      const vb = sortValue(nodes, b, sortKeyOf(sort.field));
      const c =
        typeof va === 'number' && typeof vb === 'number'
          ? va - vb
          : String(va).localeCompare(String(vb), 'zh');
      return c * sort.dir;
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
  }, [nodes, filters, sort, filtering, rootCollapsed]);

  /** 三态排序：首击（日期升序/其余降序）→ 反向 → 关闭（mindgrid 语义）。 */
  const toggleSort = (field: SortField): void => {
    setSort((s) => {
      const first = field === 'dueDate' ? 1 : -1;
      if (!s || s.field !== field) return { field, dir: first };
      if (s.dir === first) return { field, dir: first === 1 ? -1 : 1 };
      return null;
    });
  };

  const sortMark = (field: SortField): string =>
    sort?.field === field ? (sort.dir === 1 ? ' ↑' : ' ↓') : '';

  // Esc 关闭全部浮层（菜单/弹层/筛选下拉）
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key !== 'Escape') return;
      setMenu(null);
      setOwnerCellOpen(null);
      setOwnerFilterOpen(false);
      setStatusFilterOpen(false);
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

  /** 按当前列排序直属子级：sortValue 比较 → moveNode 批量重排（单事务，可撤销）。 */
  const sortChildrenByField = (parentId: string, field: string, dir: 1 | -1): void => {
    const kids = childrenOf(nodes, parentId);
    if (kids.length < 2) return;
    const key = field === 'owners' ? 'owner' : field;
    const sorted = [...kids].sort((a, b) => {
      const va = sortValue(nodes, a, key);
      const vb = sortValue(nodes, b, key);
      const c =
        typeof va === 'number' && typeof vb === 'number'
          ? va - vb
          : String(va).localeCompare(String(vb), 'zh');
      return c * dir;
    });
    try {
      withTransaction(doc, ORIGIN_USER, () => {
        sorted.forEach((k, i) => moveNode(doc, k.id, parentId, i));
      });
      afterUserWrite();
    } catch (e) {
      showToast(e instanceof Error ? e.message : '排序失败，请刷新后重试');
    }
  };

  /** + 添加子任务：建空节点 → 立即进入标题行内编辑（空提交/Esc 回收，画布同款）。 */
  const addChildTo = (parentId: string): void => {
    if (readOnly) return;
    if (checkQuota()) return;
    try {
      if (getNode(doc, parentId)?.collapsed) setCollapsed(doc, parentId, false); // 折叠中新建先展开
      let createdId = '';
      withTransaction(doc, ORIGIN_USER, () => {
        createdId = addChild(doc, parentId);
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
        <span className="tt-spacer" />
        <span className="tt-count" data-testid="table-row-count">
          {rows.length} 行
        </span>
      </div>

      {/* 表体 */}
      <div className="tt-scroll">
        <table className="tt-table">
          <thead>
            <tr>
              <th className="tt-rownum" title="行号">
                #
              </th>
              <th style={{ width: '32%' }}>任务</th>
              {(
                [
                  ['owners', '负责人'],
                  ['status', '状态'],
                  ['progress', '进度'],
                  ['startDate', '开始日期'],
                  ['dueDate', '预期日期'],
                  ['doneDate', '完成日期'],
                  ['updatedAt', '更新时间'],
                ] as [SortField, string][]
              ).map(([field, label]) => (
                <th key={field} className="tt-sortable" onClick={() => toggleSort(field)}>
                  {label}
                  {sortMark(field)}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map(({ node, depth, hasChildren, dimmed }, rowIndex) => {
              const task = node.task;
              const owners = task?.owners ?? [];
              const status = task?.status ?? 'todo';
              const statusMeta = STATUS_META[status];
              const overdue = isOverdue(node, nodes);
              const eff = effectiveProgress(nodes, node.id);
              return (
                <tr
                  key={node.id}
                  data-depth={depth}
                  className={dimmed ? 'tt-dimmed' : undefined}
                  onDoubleClick={() => {
                    if (hasChildren) toggleRow(node.id);
                  }}
                  onContextMenu={(e) => {
                    e.preventDefault();
                    const td = (e.target as HTMLElement).closest('td');
                    const idx = td ? Array.from(td.parentElement?.children ?? []).indexOf(td) : 0;
                    setMenu({ x: e.clientX, y: e.clientY, nodeId: node.id, field: COL_FIELDS[idx] ?? 'title' });
                  }}
                >
                  <td className="tt-rownum">{rowIndex + 1}</td>
                  <td
                    data-testid={`table-cell-${node.id}-title`}
                    onDoubleClick={(e) => {
                      e.stopPropagation(); // 双击任务名 = 行内编辑，不触发行折叠
                      if (!readOnly) setCellEdit({ id: node.id, isNew: false });
                    }}
                  >
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
                  <td data-testid={`table-cell-${node.id}-owners`}>
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
                                        owners: on
                                          ? owners.filter((o) => o !== m.userId)
                                          : [...owners, m.userId],
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
                  <td data-testid={`table-cell-${node.id}-status`}>
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
                  <td
                    data-testid={`table-cell-${node.id}-progress`}
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
                  <td data-testid={`table-cell-${node.id}-startDate`}>
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
                  <td data-testid={`table-cell-${node.id}-dueDate`}>
                    {readOnly ? (
                      <span
                        className="tt-date-text"
                        style={overdue ? { color: '#f53f3f' } : undefined}
                      >
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
                  <td data-testid={`table-cell-${node.id}-doneDate`}>
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
                  <td className="tt-updated" data-testid={`table-cell-${node.id}-updatedAt`}>
                    {fmtUpdated(node.updatedAt ?? 0)}
                  </td>
                </tr>
              );
            })}
            {rows.length === 0 && (
              <tr>
                <td colSpan={9} className="tt-empty">
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
    </div>
  );
}

// ---------------------------------------------------------------------------
// 子组件（NodeMarkers/TitleCellEditor/ProgressEditor 本文件留置——表格专属；
// Avatar/SmartDateInput 等跨视图共用件已抽至 TaskFields.tsx，M7c-C3/C4 同源）
// ---------------------------------------------------------------------------

/** 八组标记展示（M7b-W1 多值数组；chip 目录与 MarkerPanel/engine 同源
 *  MARKER_CATALOG，固定组序 MARKER_ROW_ORDER，目录外值忽略）。 */
function NodeMarkers({ icons }: { icons: Record<string, string[]> }): React.ReactElement | null {
  const chips: React.ReactElement[] = [];
  for (const group of MARKER_ROW_ORDER) {
    for (const value of icons[group] ?? []) {
      const chip = markerChipText(group, value);
      if (!chip) continue; // 目录外值（未收敛窗口期）：确定性忽略
      if (chip.kind === 'pie' && chip.fraction !== undefined && chip.fraction < 1) {
        const deg = Math.round(chip.fraction * 360);
        chips.push(
          <span
            key={`${group}-${value}`}
            className="tt-icon-mark tt-mark-round"
            style={{
              background: `conic-gradient(${chip.color} 0deg ${deg}deg, #ffffff ${deg}deg 360deg)`,
              boxShadow: `inset 0 0 0 1.5px ${chip.color}`,
            }}
            title={value}
          />,
        );
        continue;
      }
      if (chip.kind === 'pie') {
        chips.push(
          <span key={`${group}-${value}`} className="tt-icon-mark tt-mark-round" style={{ background: chip.color, color: '#fff' }} title={value}>
            ✓
          </span>,
        );
        continue;
      }
      if (chip.kind === 'progressNone') {
        // 「未开始」绿环+播放三角（2026-10-01 需求方反馈任务 3）：字形只有 SVG 版
        // （引擎 drawMarkerBadge 单一来源，同 MarkerPanel chip 几何），表格侧经 ref
        // 挂载同一徽章，避免手写 CSS 副本漂移。
        chips.push(<ProgressNoneChip key={`${group}-${value}`} value={value} />);
        continue;
      }
      if (chip.kind === 'circleText' || chip.kind === 'squareText' || chip.kind === 'triangle') {
        chips.push(
          <span
            key={`${group}-${value}`}
            className="tt-icon-mark tt-mark-round"
            style={{ background: chip.color, color: '#fff', borderRadius: chip.kind === 'squareText' ? 3 : '50%' }}
            title={value}
          >
            {chip.text}
          </span>,
        );
        continue;
      }
      chips.push(
        <span
          key={`${group}-${value}`}
          className="tt-icon-mark"
          style={chip.fg === 'color' ? { color: chip.color } : undefined}
          title={value}
        >
          {chip.text}
        </span>,
      );
    }
  }
  if (chips.length === 0) return null;
  return <span className="tt-markers">{chips}</span>;
}

/**
 * 「未开始」进度徽章（2026-10-01 需求方反馈任务 3）：直接复用 engine drawMarkerBadge
 * 的 SVG 徽章（绿环+播放三角，MarkerChip 同款挂载方式）——面板/画布/表格三处单一
 * 来源；def 经 markerDefOf 取目录原件（悬停 title=中文 label 与面板同源）。
 */
function ProgressNoneChip({ value }: { value: string }): React.ReactElement {
  const def = markerDefOf('progress', value);
  return (
    <span
      className="tt-icon-mark"
      style={{ width: 14, height: 14, display: 'inline-block', flex: 'none' }}
      title={value}
      aria-hidden
      ref={(el) => {
        if (!el || el.firstElementChild || !def) return;
        const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
        svg.setAttribute('viewBox', '0 0 14 14');
        svg.setAttribute('width', '14');
        svg.setAttribute('height', '14');
        const badge = drawMarkerBadge(def);
        if (badge) {
          badge.removeAttribute('class');
          svg.appendChild(badge);
        }
        el.appendChild(svg);
      }}
    />
  );
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

