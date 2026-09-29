/**
 * 任务派生规则（M7a-T2，移植自 mindgrid `shared/derive.ts` + `shared/types.ts` 的日期工具）。
 *
 * 输入模型：**平铺数组**（`DeriveNode.parentId` 建树，同级顺序由 `order` 决定，
 * `childrenOf` 负责取直属子级）。不消费嵌套 `children` 字段——二选一中取平铺版，
 * 与 mindgrid 原版及 gmind-core 快照（parentId 建树）一致，调用方（web 表格视图）
 * 只需做一次字段映射（text→title、空串 parentId→null 等），不必先组树。
 *
 * React 无关、零外部依赖：本文件被 server / web / gmind-core（applyStatusRules 唯一实现）
 * 共用，业务口径（进度汇总、逾期、排序、完成联动）只有这一份，避免规则漂移。
 * 语义逐条照搬 mindgrid 原版；与原版的差异点仅在注释中标注「Gmind 适配」。
 */

export type TaskStatus = 'todo' | 'doing' | 'done' | 'blocked';

/** 任务字段（对应 gmind-core 快照节点的 task 子对象；缺省 todo/0/[]/null×3） */
export interface DeriveTask {
  status: TaskStatus;
  progress: number;
  startDate: string | null;
  dueDate: string | null;
  doneDate: string | null;
  owners: string[];
}

/** 结构化输入节点：自持结构类型，不 import gmind-core/engine（避免反向依赖） */
export interface DeriveNode {
  id: string;
  /** 根节点为 null（gmind-core 快照的空串 parentId 由调用方映射为 null；本模块对 '' 与 null 同等处理，见 normalizeParentId） */
  parentId: string | null;
  title: string;
  collapsed?: boolean;
  task?: DeriveTask;
  /** 同级排序键；缺省视为 0（mindgrid TaskNode.order 为必填，此处放宽为可选） */
  order?: number;
  /** 毫秒时间戳，表格「更新」列排序用 */
  updatedAt?: number;
}

/** 状态列排序序：todo < doing < blocked < done（源自 mindgrid sortValue 'status' 分支，照搬） */
const STATUS_ORDER: TaskStatus[] = ['todo', 'doing', 'blocked', 'done'];

/** 无负责人时排最后（'\uffff' 为 UTF-16 最大码位，源自 mindgrid） */
const OWNER_SENTINEL = '\uffff';

/** 未填日期排最后（'9999' 字典序大于任何 YYYY-MM-DD，源自 mindgrid） */
const DATE_SENTINEL = '9999';

/** 平铺数组里的空串 parentId 与 null 同为根（Gmind 适配：gmind-core 快照 root 的 parentId 是 ''） */
function normalizeParentId(id: string | null | undefined): string | null {
  return id ? id : null;
}

/** 归一化后的节点视图：补 task/order 缺省值（不改输入对象） */
function withDefaults(node: DeriveNode): DeriveNode & { task: DeriveTask; order: number } {
  return {
    ...node,
    order: node.order ?? 0,
    task: node.task ?? {
      status: 'todo',
      progress: 0,
      startDate: null,
      dueDate: null,
      doneDate: null,
      owners: [],
    },
  };
}

/* ---------- 日期工具（移植自 mindgrid `shared/types.ts`，本地时区） ---------- */

/** ts → 本地时区 YYYY-MM-DD */
export function dayKey(ts: number): string {
  const d = new Date(ts);
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

/** 今天的 YYYY-MM-DD（本地时区） */
export function todayStr(): string {
  return dayKey(Date.now());
}

/* ---------- 树结构（源自 mindgrid derive.ts，平铺数组版） ---------- */

/** 直属子级，按 order 升序（缺省 order 视为 0；ES2019+ sort 稳定保同序兜底） */
export function childrenOf(nodes: DeriveNode[], parentId: string | null): DeriveNode[] {
  const target = normalizeParentId(parentId);
  return nodes.filter((n) => normalizeParentId(n.parentId) === target).sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
}

/** 有子节点时进度 = 直属子级有效进度的平均，否则为自身进度（无 task 视为 0；节点不存在亦为 0） */
export function effectiveProgress(nodes: DeriveNode[], id: string): number {
  const kids = childrenOf(nodes, id);
  if (kids.length === 0) return nodes.find((n) => n.id === id)?.task?.progress ?? 0;
  const sum = kids.reduce((acc, k) => acc + effectiveProgress(nodes, k.id), 0);
  return Math.round(sum / kids.length);
}

/** 逾期判定：dueDate < today 且 有效进度 < 100 且 status !== 'done'（today 缺省取本地今天；当天到期不算逾期） */
export function isOverdue(node: DeriveNode, nodes: DeriveNode[], today: string = todayStr()): boolean {
  const task = node.task;
  if (!task?.dueDate) return false;
  if (task.status === 'done') return false;
  return task.dueDate < today && effectiveProgress(nodes, node.id) < 100;
}

export interface VisibleRow {
  node: DeriveNode;
  depth: number;
  hasChildren: boolean;
}

/**
 * 展开状态下可见的扁平树（表格视图用），深度优先、尊重 collapsed。
 * 不传 rootId 时从全部根节点开始（mindgrid 原版行为，根进表、depth=0）；
 * 传 rootId 时以该节点为树根、**根自身不进表**，其直属子级 depth=0（Gmind 适配：
 * 脑图画布根节点不占用表格行）。树根折叠时不输出任何行（折叠隐藏整个子树，口径与后代节点一致）。
 */
export function flattenVisible(nodes: DeriveNode[], rootId?: string): VisibleRow[] {
  const out: VisibleRow[] = [];
  const walk = (parentId: string | null, depth: number) => {
    for (const n of childrenOf(nodes, parentId)) {
      const kids = childrenOf(nodes, n.id);
      out.push({ node: n, depth, hasChildren: kids.length > 0 });
      if (!n.collapsed) walk(n.id, depth + 1);
    }
  };
  if (rootId === undefined) {
    walk(null, 0);
    return out;
  }
  const root = nodes.find((n) => n.id === rootId);
  if (!root || root.collapsed) return out;
  walk(root.id, 0);
  return out;
}

/** 表格「按此列排序」取的值；未填日期排最后。列键沿用 mindgrid：progress/owner/status/
 *  startDate/dueDate/doneDate/updatedAt，其余（含 'title'）返回标题原文，本地化比较由调用方 localeCompare 完成。 */
export function sortValue(nodes: DeriveNode[], n: DeriveNode, key: string): string | number {
  const t = withDefaults(n).task;
  switch (key) {
    case 'progress':
      return effectiveProgress(nodes, n.id);
    case 'owner':
      return t.owners[0] || OWNER_SENTINEL;
    case 'status':
      return STATUS_ORDER.indexOf(t.status);
    case 'startDate':
      return t.startDate ?? DATE_SENTINEL;
    case 'dueDate':
      return t.dueDate ?? DATE_SENTINEL;
    case 'doneDate':
      return t.doneDate ?? DATE_SENTINEL;
    case 'updatedAt':
      return n.updatedAt ?? 0;
    default:
      return n.title;
  }
}

/* ---------- 状态联动（源自 mindgrid derive.ts applyStatusRules，规则唯一实现，core op 与 web 共用） ---------- */

/** 任务字段补丁（对应 gmind-core setNodeTask 的 patch 入参） */
export type TaskPatch = Partial<DeriveTask>;

/**
 * 状态联动（M7a-T2 移植 + M7b-W1 进度回退修订，需求方 2026-09-29 裁定）：
 * - 进入 done：自动写完成日期并把进度拉满（联动分支 progress 恒置 100，patch 显式
 *   给的 progress 也被覆盖）；手动传入 doneDate 时不覆盖用户的显式选择。
 * - 离开 done（uniform，适用于 done→任意目标；只以 before 状态为门）：清空完成日期
 *   **且进度回退为 0**（「改回待开始进度改为 0%」，显式给的 progress 同样被回退覆盖；
 *   显式给 doneDate 的恢复全字段 patch 不触发本分支——restore 口径）。手改 doneDate
 *   不反写 status。
 * before 无 task 时按缺省（todo/无完成日期）处理。
 */
export function applyStatusRules(before: DeriveNode, patch: TaskPatch): TaskPatch {
  const finalPatch: TaskPatch = { ...patch };
  const beforeStatus = before.task?.status ?? 'todo';
  const beforeDoneDate = before.task?.doneDate ?? null;
  if (patch.status !== undefined && patch.status !== beforeStatus) {
    if (patch.status === 'done' && !beforeDoneDate && patch.doneDate === undefined) {
      finalPatch.doneDate = todayStr();
      finalPatch.progress = 100;
    } else if (patch.status !== 'done' && beforeStatus === 'done' && patch.doneDate === undefined) {
      finalPatch.doneDate = null;
      finalPatch.progress = 0;
    }
  }
  return finalPatch;
}
