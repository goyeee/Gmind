/**
 * 节点卡片任务视觉（M7c-C2，原 M7b 计划项；spec 2026-09-29-m7c §R4）——
 * 任务语义与几何常量的引擎内单源。
 *
 * 语义源（只读对标）：mindgrid `app/src/components/MindMap.tsx` 节点卡
 * （状态色左边条 / 负责人头像首点+n / 进度 / MM-DD 日期徽标）与
 * `@gmind/shared` derive（effectiveProgress/isOverdue 业务口径唯一实现，
 * engine 直接复用不内联）；状态四色取企微底色（2026-09-29 裁定色值）。
 *
 * 只增不改纪律：
 * - 无任务信息（hasTaskInfo=false）的节点不产生任何槽位与元素——布局几何、
 *   渲染 DOM 与现状逐字节一致（金样锁定）。
 * - engine 不 import core：NodeTaskVisual 为 core NodeSnapshot.task 的结构
 *   兼容子集，由宿主（apps/web 适配层）自 getNode(id).task 透传。
 */
import { effectiveProgress, isOverdue, type DeriveNode, type TaskStatus } from '@gmind/shared';

/** 任务字段渲染子集（core NodeSnapshot.task 结构兼容；字段缺省 = 未设置）。 */
export interface NodeTaskVisual {
  status?: TaskStatus;
  owners?: string[];
  progress?: number;
  dueDate?: string | null;
}

/** 企微底色状态四色（todo 灰 / doing 蓝 / done 绿 / blocked 橙）。 */
export const TASK_STATUS_COLORS: Record<TaskStatus, string> = {
  todo: '#86909c',
  doing: '#3370ff',
  done: '#34c724',
  blocked: '#ff8800',
};

/** 状态 → 左边条色（未知/缺省 status 按 todo 灰兜底，确定性）。 */
export function taskStatusColor(status: string | undefined): string {
  return TASK_STATUS_COLORS[(status ?? 'todo') as TaskStatus] ?? TASK_STATUS_COLORS.todo;
}

/**
 * 有无任务信息：status=todo 且无负责人/进度/日期 → 纯脑图节点
 * （零任务视觉零槽位，卡片保持现状）。
 */
export function hasTaskInfo(task: NodeTaskVisual | undefined): boolean {
  if (!task) return false;
  return (
    (task.status !== undefined && task.status !== 'todo') ||
    (task.owners?.length ?? 0) > 0 ||
    (task.progress ?? 0) > 0 ||
    (task.dueDate ?? '') !== ''
  );
}

// —— 任务视觉几何常量（measure 量槽与 render 绘制同源，确定性输出）——

/** 状态色左边条宽（节点左缘竖条，全盒高）。 */
export const TASK_BAR_W = 3;
/** 任务信息行（卡片第二行，与 R1 description 行同槽位区域）高度。 */
export const TASK_ROW_H = 20;
/** 负责人色点直径。 */
export const TASK_AVATAR_D = 10;
/** 「+n」槽宽（owners>1 时跟在首点后，右对齐）。 */
export const TASK_AVATAR_PLUS_W = 18;
/** 进度百分比文本槽宽。 */
export const TASK_PROGRESS_W = 30;
/** MM-DD 日期徽标槽宽。 */
export const TASK_DUE_W = 38;
/** 日期徽标高（胶囊）。 */
export const TASK_DUE_H = 14;
/** 任务行内相邻信息项间距。 */
export const TASK_GAP = 6;
/** 任务行右内边距（行内容自盒右缘向左排）。 */
export const TASK_ROW_PAD = 6;
/** 日期徽标逾期红底（企微 danger）。 */
export const TASK_DUE_OVERDUE_BG = '#f53f3f';
/** 日期徽标常态灰底/灰字。 */
export const TASK_DUE_BG = '#f2f3f5';
export const TASK_DUE_FG = '#86909c';
/** 进度/「+n」小字色与字号。 */
export const TASK_META_FG = '#86909c';
export const TASK_META_FONT_SIZE = 11;
/** 日期徽标字号。 */
export const TASK_DUE_FONT_SIZE = 10;

/** 任务行槽位（layout→measure 透传；render 绘制判定同源）。 */
export interface TaskRowSlots {
  /** 负责人数。 */
  owners: number;
  /** 是否显示进度（父节点恒显示 Σ 汇总；叶子仅 progress>0）。 */
  showProgress: boolean;
  /** 是否有预期日期。 */
  hasDue: boolean;
}

/**
 * 由节点任务字段算任务行槽位（无任务信息 → undefined，零槽位）。
 * isParent = 有无存活子节点（父节点恒显示 Σ 汇总，含 0%）。
 */
export function taskRowSlotsOf(
  task: NodeTaskVisual | undefined,
  isParent: boolean,
): TaskRowSlots | undefined {
  if (!task || !hasTaskInfo(task)) return undefined;
  return {
    owners: task.owners?.length ?? 0,
    showProgress: isParent || (task.progress ?? 0) > 0,
    hasDue: (task.dueDate ?? '') !== '',
  };
}

/** 任务行内容总宽（确定性估算：render 绘制槽位与此同源；用作盒宽下限）。 */
export function taskRowContentWidth(s: TaskRowSlots): number {
  let w = 0;
  if (s.owners > 0) w += TASK_AVATAR_D + (s.owners > 1 ? TASK_GAP + TASK_AVATAR_PLUS_W : 0);
  if (s.showProgress) w += (w > 0 ? TASK_GAP : 0) + TASK_PROGRESS_W;
  if (s.hasDue) w += (w > 0 ? TASK_GAP : 0) + TASK_DUE_W;
  return w > 0 ? w + TASK_ROW_PAD * 2 : 0;
}

/** 渲染输入的最小节点形状（NodeVisual 结构子集，避免与 render 相互依赖）。 */
export interface TaskProgressSource {
  task?: NodeTaskVisual;
}

/** 平铺 DeriveNode（@gmind/shared derive 输入口径）：树由 layout.nodes 的
 *  parentId 回建；无 task 数据的节点按缺省（progress 0）。 */
function buildDeriveNodes(
  nodeData: Map<string, TaskProgressSource>,
  layoutNodes: Array<{ id: string; parentId?: string }>,
): DeriveNode[] {
  const parentById = new Map(layoutNodes.map((b) => [b.id, b.parentId ?? null]));
  const deriveNodes: DeriveNode[] = [];
  for (const [id, v] of nodeData) {
    const t = v.task;
    deriveNodes.push({
      id,
      parentId: parentById.get(id) ?? null,
      title: '', // 进度/逾期聚合不消费标题
      task: t
        ? {
            status: t.status ?? 'todo',
            progress: t.progress ?? 0,
            startDate: null,
            dueDate: t.dueDate ?? null,
            doneDate: null,
            owners: t.owners ?? [],
          }
        : undefined,
    });
  }
  return deriveNodes;
}

/**
 * 各节点有效进度（口径 = @gmind/shared effectiveProgress：叶=自身 progress，
 * 父=直属子级有效进度均值四舍五入）。折叠节点按叶子口径：被隐藏后代不在
 * 渲染集（layout 把折叠节点按叶子输出），childrenOf 取空 → 自身 progress。
 */
export function taskProgressMap(
  nodeData: Map<string, TaskProgressSource>,
  layoutNodes: Array<{ id: string; parentId?: string }>,
): Map<string, number> {
  const deriveNodes = buildDeriveNodes(nodeData, layoutNodes);
  const out = new Map<string, number>();
  for (const n of deriveNodes) out.set(n.id, effectiveProgress(deriveNodes, n.id));
  return out;
}

/**
 * 逾期节点 id 集（口径 = @gmind/shared isOverdue：dueDate<today 且有效进度<100
 * 且 status≠done；today 显式传入保确定性——当天到期不算逾期）。
 */
export function taskOverdueIds(
  nodeData: Map<string, TaskProgressSource>,
  layoutNodes: Array<{ id: string; parentId?: string }>,
  today: string,
): Set<string> {
  const deriveNodes = buildDeriveNodes(nodeData, layoutNodes);
  const out = new Set<string>();
  for (const n of deriveNodes) {
    if (isOverdue(n, deriveNodes, today)) out.add(n.id);
  }
  return out;
}

/** 渲染集中的父节点 id 集（有 ≥1 个存活渲染子节点；layout.nodes 的 parentId 反查）。 */
export function taskParentIds(layoutNodes: Array<{ id: string; parentId?: string }>): Set<string> {
  const out = new Set<string>();
  for (const b of layoutNodes) if (b.parentId) out.add(b.parentId);
  return out;
}
