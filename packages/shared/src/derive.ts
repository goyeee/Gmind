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
  /** 唯一总负责人（2026-11-20 任务模型）：null=未指派。 */
  ownerId: string | null;
  /** 总负责人的可选执行子进度；独立于任务总进度。 */
  ownerProgress: number | null;
  startDate: string | null;
  dueDate: string | null;
  doneDate: string | null;
  /** 旧多负责人兼容读取（迁移后恒空数组——新写入只存 ownerId）。 */
  owners: string[];
  /**
   * 父级进度是否按子级自动汇总（2026-10-20 需求方裁定：父级默认手动，可单节点
   * 开启自动）。缺省时按兼容口径处理——有子节点视为 true（存量文档保持原自动
   * 汇总行为），无子节点视为 false；新增父节点由 core addChild/moveNode 显式写
   * false，从而新父级默认手动。
   */
  autoProgress?: boolean;
}

/** 人员进度列拉平条目（需求方 2026-10-11 裁定的自定义列类型 assignee；
 *  多列由调用方拉平传入——derive 不读 schema/custom 结构，保持结构化输入自治；
 *  weight=合成比重（2026-10-12 裁定：调用方按列 weighted 开关解析——平分模式恒 1） */
export interface CustomAssigneeEntry {
  user: string;
  progress: number;
  weight?: number;
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
  /** 是否作为真正任务参与自动父级汇总；core 按显式任务信息或人员条目填充。
   *  缺省按 true 兼容旧调用方，普通说明节点由 core 显式写 false。 */
  taskActive?: boolean;
  /** 人员进度列条目（调用方从 core 快照映射、跨列拉平）；仅供旧 effectiveProgress
   *  迁移兼容逻辑使用，新 taskProgressOf 不读取。缺省无 */
  customAssignees?: CustomAssigneeEntry[];
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
      ownerId: null,
      ownerProgress: null,
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

/** 「今日待办」统一口径（2026-10-28 P1）：今日到期或已逾期——dueDate<=今天。
 *  三处消费同源：我的待办页签（TodosPage）、统计面板 range=today（todos.service
 *  SQL 条件）、其他「今日」语义一律以本函数为准（原「今日有更新」口径退役）。 */
export function isDueTodayOrOverdue(dueDate: string | null, today: string = todayStr()): boolean {
  return dueDate !== null && dueDate <= today;
}

/* ---------- 树结构（源自 mindgrid derive.ts，平铺数组版） ---------- */

/** 直属子级，按 order 升序（缺省 order 视为 0；ES2019+ sort 稳定保同序兜底） */
export function childrenOf(nodes: DeriveNode[], parentId: string | null): DeriveNode[] {
  const target = normalizeParentId(parentId);
  return nodes.filter((n) => normalizeParentId(n.parentId) === target).sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
}

/**
 * 有效进度：
 * - 父节点且 task.autoProgress=true：直属子级有效进度的平均（递归）。
 * - 父节点手动（autoProgress=false 或未显式设置）：直接取 task.progress，不汇总子级。
 *   2026-10-20 需求方裁定「父级默认不自动计算」，因此缺省按手动处理。
 * - 叶子节点：所有「带进度的人」的**加权**平均（需求方 2026-10-12 比重裁定）——
 *   标准负责人（owners 非空时 task.progress 一项，权重恒 1）+ customAssignees 每人
 *   一项（weight 缺省 1；调用方按列 weighted 开关解析）；无任何参与项时回落
 *   task.progress（无 task 视为 0；节点不存在亦为 0）。
 * 「全 100% 才能标完成」是 setNodeTask 门禁职责，不在本聚合函数内。
 */
export function effectiveProgress(nodes: DeriveNode[], id: string): number {
  const kids = childrenOf(nodes, id);
  const node = nodes.find((n) => n.id === id);
  const auto = node?.task?.autoProgress ?? false;
  if (kids.length > 0 && auto) {
    const sum = kids.reduce((acc, k) => acc + effectiveProgress(nodes, k.id), 0);
    return Math.round(sum / kids.length);
  }
  // 叶子节点，或手动父节点：按人员进度加权平均，无人员则取 task.progress。
  const entries = node?.customAssignees ?? [];
  const hasOwners = (node?.task?.owners?.length ?? 0) > 0;
  let weightSum = 0;
  let weighted = 0;
  for (const e of entries) {
    const w = e.weight ?? 1;
    weightSum += w;
    weighted += e.progress * w;
  }
  if (hasOwners) {
    weightSum += 1;
    weighted += node!.task!.progress;
  }
  if (weightSum === 0) return node?.task?.progress ?? 0;
  return Math.round(weighted / weightSum);
}

/** 自动父级参与汇总的直属任务子级。旧调用方未填 taskActive 时按任务兼容纳入；
 *  core 读出的普通说明节点显式为 false，不参与。 */
function taskChildrenOf(nodes: DeriveNode[], id: string): DeriveNode[] {
  return childrenOf(nodes, id).filter((child) => child.taskActive !== false);
}

/**
 * 任务总进度唯一新口径：手动节点直接读 task.progress；自动父只递归平均直属
 * 真正任务的总进度，没有任务子级时回退自身 progress。人员子进度与旧 weight
 * 一律不参与。旧 effectiveProgress 保留给迁移期兼容旧显示值，不再承载新消费。
 */
export function taskProgressOf(nodes: DeriveNode[], id: string): number {
  const node = nodes.find((n) => n.id === id);
  if (!node) return 0;
  if (node.task?.autoProgress === true) {
    const kids = taskChildrenOf(nodes, id);
    if (kids.length > 0) {
      const sum = kids.reduce((acc, child) => acc + taskProgressOf(nodes, child.id), 0);
      return Math.round(sum / kids.length);
    }
  }
  return node.task?.progress ?? 0;
}

/** 总状态与总进度同源：100=done、0=todo、其余=doing；手动任务 blocked 保留
 *  阻塞态与当前进度，到 100 仍为 done。自动父完全随汇总进度，不继承阻塞。 */
export function taskStatusOf(nodes: DeriveNode[], id: string): TaskStatus {
  const node = nodes.find((n) => n.id === id);
  if (!node) return 'todo';
  const progress = taskProgressOf(nodes, id);
  if (progress === 100) return 'done';
  if (node.task?.autoProgress !== true && node.task?.status === 'blocked') return 'blocked';
  return progress === 0 ? 'todo' : 'doing';
}

/** 手动任务读自身完成日期；自动父仅在总进度 100 时取最晚直属子任务的有效
 *  完成日期（递归读取自动子任务），没有历史日期时返回 null，不伪造今天。 */
export function taskDoneDateOf(nodes: DeriveNode[], id: string): string | null {
  const node = nodes.find((n) => n.id === id);
  if (!node) return null;
  if (node.task?.autoProgress !== true) return node.task?.doneDate ?? null;
  if (taskProgressOf(nodes, id) !== 100) return null;
  let latest: string | null = null;
  for (const child of taskChildrenOf(nodes, id)) {
    const doneDate = taskDoneDateOf(nodes, child.id);
    if (doneDate !== null && (latest === null || doneDate > latest)) latest = doneDate;
  }
  return latest;
}

/** 逾期判定只使用任务总进度与派生总状态；人员子进度不影响逾期。 */
export function isOverdue(node: DeriveNode, nodes: DeriveNode[], today: string = todayStr()): boolean {
  const task = node.task;
  if (!task?.dueDate) return false;
  if (taskStatusOf(nodes, node.id) === 'done') return false;
  return task.dueDate < today && taskProgressOf(nodes, node.id) < 100;
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
      return taskProgressOf(nodes, n.id);
    case 'owner':
      return t.ownerId ?? t.owners[0] ?? OWNER_SENTINEL;
    case 'status':
      return STATUS_ORDER.indexOf(taskStatusOf(nodes, n.id));
    case 'startDate':
      return t.startDate ?? DATE_SENTINEL;
    case 'dueDate':
      return t.dueDate ?? DATE_SENTINEL;
    case 'doneDate':
      return taskDoneDateOf(nodes, n.id) ?? DATE_SENTINEL;
    case 'updatedAt':
      return n.updatedAt ?? 0;
    default:
      return n.title;
  }
}

/* ---------- 状态联动（源自 mindgrid derive.ts applyStatusRules，规则唯一实现，core op 与 web 共用） ---------- */

/** 任务字段补丁：负责人与其子进度分别只能经 setTaskOwner/setOwnerProgress 写入。 */
export type TaskPatch = Partial<Omit<DeriveTask, 'ownerId' | 'ownerProgress'>>;

/**
 * 状态/进度联动（2026-11-20 任务模型裁定）：
 * - 100% 与 done 是同一完成动作：总进度 100、状态 done，首次完成写今天；恢复全字段
 *   patch 显式携带 doneDate（含 null）时完全按快照原值，不触发联动。
 * - 0%=todo、1～99%=doing；blocked 保留当前进度，阻塞中到 100 仍完成。
 * - 已完成重开必须显式携带 0～99 的新进度（core 在事务前校验），清除完成日期；
 *   本纯函数不抛错，也不自动把重开进度改成 0。
 */
export function applyStatusRules(before: DeriveNode, patch: TaskPatch): TaskPatch {
  if (patch.doneDate !== undefined) return { ...patch };
  const finalPatch: TaskPatch = { ...patch };
  const beforeStatus = before.task?.status ?? 'todo';
  const beforeProgress = before.task?.progress ?? 0;
  const beforeDoneDate = before.task?.doneDate ?? null;

  if (patch.status === 'done' || patch.progress === 100) {
    finalPatch.status = 'done';
    finalPatch.progress = 100;
    finalPatch.doneDate = beforeDoneDate ?? todayStr();
    return finalPatch;
  }

  const reopening = beforeStatus === 'done' || beforeProgress === 100;
  if (reopening && (patch.status !== undefined || patch.progress !== undefined)) {
    finalPatch.doneDate = null;
  }

  if (patch.progress !== undefined) {
    if (patch.status === 'blocked' || (patch.status === undefined && beforeStatus === 'blocked' && !reopening)) {
      finalPatch.status = 'blocked';
    } else {
      finalPatch.status = patch.progress === 0 ? 'todo' : 'doing';
    }
    return finalPatch;
  }

  if (patch.status === beforeStatus && patch.progress === undefined) return finalPatch;

  if (patch.status === 'todo' && !reopening) {
    finalPatch.progress = 0;
  } else if (patch.status === 'blocked') {
    finalPatch.status = 'blocked';
  }
  return finalPatch;
}
