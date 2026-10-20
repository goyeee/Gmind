/**
 * 节点卡片任务视觉（M7c-C2，原 M7b 计划项；spec 2026-09-29-m7c §R4）——
 * 任务语义与几何常量的引擎内单源。
 *
 * 2026-10-10 mindgrid 全量对齐（spec 2026-10-10-node-props-and-task-visual-design）：
 * footer 行改「左=负责人文字名(+N)/无负责人且 depth≥2=橙字未分配，右=百分比」；
 * 预期日期移出任务行，改节点盒右上角外侧悬浮 chip（逾期红字红框，不占盒宽高）；
 * 负责人色点/+n 与行内日期徽标退役。**显示门槛不变**：仅 hasTaskInfo 节点产出
 * 任务行（需求方裁定——非 mindgrid 的每节点恒 footer），零任务信息节点保持纯
 * 脑图卡（金样原则不动）。
 *
 * 语义源（只读对标）：mindgrid `app/src/components/MindMap.tsx` 节点卡
 * （状态色左边条 / footer 左负责人文字右百分比 / MM-DD 悬浮日期 chip）与
 * `@gmind/shared` derive（effectiveProgress/isOverdue 业务口径唯一实现，
 * engine 直接复用不内联）；状态四色取企微底色（2026-09-29 裁定色值）。
 *
 * 只增不改纪律：
 * - 无任务信息（hasTaskInfo=false）的节点不产生任何槽位与元素——布局几何、
 *   渲染 DOM 与现状逐字节一致（金样锁定）。
 * - engine 不 import core：NodeTaskVisual 为 core NodeSnapshot.task 的结构
 *   兼容子集，由宿主（apps/web 适配层）自 getNode(id).task 透传；ownerNames
 *   为渲染期派生数据（宿主成员目录映射），不入 Yjs 文档。
 */
import { effectiveProgress, isOverdue, type DeriveNode, type TaskStatus } from '@gmind/shared';

/** 任务字段渲染子集（core NodeSnapshot.task 结构兼容；字段缺省 = 未设置）。 */
export interface NodeTaskVisual {
  status?: TaskStatus;
  owners?: string[];
  /**
   * 父级进度是否按子级自动汇总（2026-10-20 需求方裁定）。
   * 缺省时 effectiveProgress 按兼容口径处理（有子节点视为自动）。
   */
  autoProgress?: boolean;
  /**
   * 负责人显示名（2026-10-10 mindgrid 对齐：footer 行左栏文字名取代色点）：
   * 与 owners 同序的渲染期派生数据（宿主成员目录映射，不入 Yjs 文档）；
   * 缺省/缺位回退 owners 原值（ID）。
   */
  ownerNames?: string[];
  /**
   * 负责人头像地址（2026-10-11 头像功能）：与 owners 同序（缺省/缺位 = 无自定义
   * 头像，宿主 Avatar 组件按 userId 稳定分配预置 SVG）；上传键经公开 /api/images
   * 端点直出，预置为 /avatars/preset-N.svg。
   */
  ownerAvatarUrls?: Array<string | null>;
  progress?: number;
  dueDate?: string | null;
  /**
   * 人员进度列头像（需求方 2026-10-11 裁定，第二步）：任务行内横向圆形头像 +
   * 弧形进度；与自定义列 assignee 条目一一对应，name 为渲染期派生显示名
   * （宿主成员目录映射，layout 通道可不填 name——槽位宽度只按数量计）。
   */
  assignees?: AssigneeVisual[];
}

/** 人员进度列头像条目（engine 内拉平自定义列 assignee 值后的渲染形态）。 */
export interface AssigneeVisual {
  /** 用户 ID（点击锚点 data-assignee-user）。 */
  user: string;
  /** 显示名（首字符入头像；缺省回退 ID 前 8 位）。 */
  name: string;
  /** 进度 0-100。 */
  progress: number;
  /** 来源列 id（写回 setCustomField 用；点击锚点 data-assignee-col）。 */
  colId: string;
  /** 头像地址（2026-10-11；缺省 = 无自定义，宿主稳定分配预置 SVG）。 */
  avatar?: string | null;
  /** 合成比重（2026-10-12 裁定；flatten 时已按列 weighted 开关解析——平分模式恒 1）。 */
  weight?: number;
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
 * 有无任务信息：status=todo 且无负责人/进度/日期/人员进度 → 纯脑图节点
 * （零任务视觉零槽位，卡片保持现状）。人员进度列（2026-10-11 第二步）计入
 * 门槛：仅有 assignee 数据的节点也产任务行（头像需要行位）。
 */
export function hasTaskInfo(task: NodeTaskVisual | undefined): boolean {
  if (!task) return false;
  return (
    (task.status !== undefined && task.status !== 'todo') ||
    (task.owners?.length ?? 0) > 0 ||
    (task.progress ?? 0) > 0 ||
    (task.dueDate ?? '') !== '' ||
    (task.assignees?.length ?? 0) > 0
  );
}

// —— 任务视觉几何常量（measure 量槽与 render 绘制同源，确定性输出）——

/** 状态色左边条宽（节点左缘竖条，全盒高）。 */
export const TASK_BAR_W = 3;
/** 任务信息行（卡片第二行，与 R1 description 行同槽位区域）高度。 */
export const TASK_ROW_H = 20;
/** 进度百分比文本槽宽。 */
export const TASK_PROGRESS_W = 30;
/** MM-DD 日期悬浮标签槽宽（节点盒右上角外侧浮动 chip，不占盒宽/高）。 */
export const TASK_DUE_W = 38;
/** 日期悬浮标签高（胶囊）。 */
export const TASK_DUE_H = 14;
/** 任务行内相邻信息项间距。 */
export const TASK_GAP = 6;
/** 任务行左右内边距（左=负责人文字起点，右=百分比右缘）。 */
export const TASK_ROW_PAD = 6;
/** 日期悬浮标签逾期红（企微 danger；文字+边框同色）。 */
export const TASK_DUE_OVERDUE_BG = '#f53f3f';
/** 日期悬浮标签常态字色/「未分配」之外的行内小字色。 */
export const TASK_DUE_FG = '#86909c';
/** 日期悬浮标签常态边框色（企微 line3 量级）。 */
export const TASK_DUE_FLOAT_BORDER = '#e5e6eb';
/** 「未分配」橙（mindgrid --c-orange；与 blocked 同色系）。 */
export const TASK_UNASSIGNED_FG = '#ff8800';
/** 进度/负责人小字色与字号。 */
export const TASK_META_FG = '#86909c';
export const TASK_META_FONT_SIZE = 11;
/** 日期悬浮标签字号。 */
export const TASK_DUE_FONT_SIZE = 10;

/** 任务行头像几何（需求方 2026-10-11 裁定：负责人/人员进度圆形头像横排）：
 *  头像为「文字圆」（首字符代替——头像图片功能后续迭代），人员进度头像外缘
 *  叠弧形进度环（render 绘制；measure 只按槽宽计几何）。 */
export const AVATAR_R = 7;
/** 相邻头像槽距（直径 2R + 间隙 4）。 */
export const AVATAR_SLOT = AVATAR_R * 2 + 4;
/** 头像首字符字号。 */
export const AVATAR_FONT_SIZE = 8;
/** 头像圆底色（owner 与 assignee 同）。 */
export const AVATAR_BG = '#eef0f2';
/** 头像首字符色。 */
export const AVATAR_FG = '#4e5969';
/** 人员进度弧形进度环色（任务进度绿；100% 同）。 */
export const AVATAR_PROGRESS_FG = '#34c724';
/** 进度环底色（未走部分）。 */
export const AVATAR_PROGRESS_BG = '#e5e6eb';

/** 任务行槽位（layout→measure 透传；render 绘制判定同源）。 */
export interface TaskRowSlots {
  /**
   * 负责人左栏最终文本（2026-10-10 mindgrid 对齐）：有负责人 = 首人显示名
   * （ownerNames[0] ?? owners[0]，多人追加「 +N」）；无负责人且 depth≥2 = 「未分配」；
   * 其余 = ''（左栏不画）。
   * 2026-10-11 负责人头像化后本字段语义收窄：ownerAvatars 非空时恒 ''（头像取代
   * 文字），仅保留「未分配」橙字用途。
   */
  ownerLabel: string;
  /** 「未分配」橙字态（depth≥2 无负责人）。 */
  ownerUnassigned: boolean;
  /** 负责人头像显示名组（与 owners 同序；缺省/空 = 不画头像）。 */
  ownerAvatars?: string[];
  /** 负责人头像地址组（与 ownerAvatars 同序；2026-10-11 头像图片——缺省回退文字首字符）。 */
  ownerAvatarUrls?: Array<string | null>;
  /** 人员进度头像组（横向排于负责人头像之后；缺省/空 = 不画）。 */
  assigneeAvatars?: AssigneeVisual[];
  /** 是否显示进度（父节点恒显示 Σ 汇总；叶子仅 progress>0）。 */
  showProgress: boolean;
}

/**
 * 负责人左栏文案（mindgrid footer 口径；render 绘制与 taskRowSlotsOf 同源）：
 * owners 过滤空串；首人显示名取 ownerNames[0]（缺省回退 owners[0] ID），多人
 * 追加「 +N」；无负责人且 depth≥2 → 「未分配」（橙字态 unassigned=true）。
 */
export function ownerLabelOf(
  task: NodeTaskVisual | undefined,
  depth: number,
): { label: string; unassigned: boolean } {
  const owners = (task?.owners ?? []).filter((o) => o !== '');
  if (owners.length > 0) {
    const first = task?.ownerNames?.[0] ?? (owners[0] as string);
    return {
      label: owners.length > 1 ? `${first} +${owners.length - 1}` : first,
      unassigned: false,
    };
  }
  return depth >= 2 ? { label: '未分配', unassigned: true } : { label: '', unassigned: false };
}

/**
 * 由节点任务字段算任务行槽位（无任务信息 → undefined，零槽位）。
 * isParent = 有无存活子节点（父节点恒显示 Σ 汇总，含 0%）；depth 供「未分配」
 * 判定（depth≥2 才显示，mindgrid 口径）。负责人头像化（2026-10-11）：
 * ownerAvatars=显示名组（左缘横排），「未分配」橙字仅在无负责人时保留。
 */
export function taskRowSlotsOf(
  task: NodeTaskVisual | undefined,
  isParent: boolean,
  depth: number,
): TaskRowSlots | undefined {
  if (!task || !hasTaskInfo(task)) return undefined;
  const { label, unassigned } = ownerLabelOf(task, depth);
  const owners = (task.owners ?? []).filter((o) => o !== '');
  const ownerAvatars = owners.map((o, i) => task.ownerNames?.[i] ?? o);
  const assigneeAvatars = task.assignees ?? [];
  // 头像（负责人/人员进度）存在时「未分配」文字让位——头像已表达有人参与，
  // 且避免文字宽与头像串联的 render 侧测量耦合（render 无文字测量 adapter）。
  const showAvatars = ownerAvatars.length > 0 || assigneeAvatars.length > 0;
  return {
    ownerLabel: showAvatars ? '' : label,
    ownerUnassigned: unassigned && !showAvatars,
    ownerAvatars,
    ownerAvatarUrls: task.ownerAvatarUrls ?? [],
    assigneeAvatars,
    // 任务行存在（hasTaskInfo 门槛已放行）即显示右侧有效进度——2026-10-12 修复：
    // 负责人进度改 0 后右侧 % 不得消失（旧口径「仅 progress>0 显示」会把 0% 场景
    // 整行隐藏，而 0% 也是信息；有人员列时右侧=合成进度，owner 0 更常见）。
    showProgress: true,
  };
}

/**
 * 任务行内容总宽（盒宽下限；render 绘制槽位同源）：
 * 左=「未分配」文字（ownerLabelW 由测量侧 adapter 实测传入——文字宽度不可常量
 * 估算）+ 负责人/人员进度头像槽（常量槽宽 AVATAR_SLOT，头像直径与间距固定），
 * 右=百分比槽；相邻项间距 TASK_GAP。日期为盒外悬浮标签，不占行宽（2026-10-10 起）。
 */
export function taskRowContentWidth(s: TaskRowSlots, ownerLabelW: number): number {
  let w = 0;
  if (s.ownerLabel !== '') w += ownerLabelW;
  const avatars = (s.ownerAvatars?.length ?? 0) + (s.assigneeAvatars?.length ?? 0);
  if (avatars > 0) w += (w > 0 ? TASK_GAP : 0) + avatars * AVATAR_SLOT - (AVATAR_SLOT - AVATAR_R * 2);
  if (s.showProgress) w += (w > 0 ? TASK_GAP : 0) + TASK_PROGRESS_W;
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
    // 人员进度列条目拉平（2026-10-11 Σ 口径修复）：engine 的 effectiveProgress
    // 与 TaskTable/任务面板同源（shared 单一实现）——此前缺此字段，节点任务行
    // 百分比与表格合成进度不一致。weight 由 flatten 按列 weighted 解析（缺省 1）。
    const customAssignees = (t?.assignees ?? []).map(({ user, progress, weight }) => ({
      user,
      progress,
      ...(weight !== undefined ? { weight } : {}),
    }));
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
            ...(t.autoProgress !== undefined ? { autoProgress: t.autoProgress } : {}),
          }
        : undefined,
      ...(customAssignees.length > 0 ? { customAssignees } : {}),
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

/** meta.customColumns（raw）→ assignee 列描述集（layout 通道；防御读：非数组/坏
 *  形状容忍，与 core canonicalCustomColumns 宽松口径对齐——engine 不 import core）。
 *  weighted（2026-10-12 比重裁定）仅透传 true。 */
export function assigneeColumnsOf(raw: unknown): Array<{ id: string; weighted: boolean }> {
  if (!Array.isArray(raw)) return [];
  const out: Array<{ id: string; weighted: boolean }> = [];
  for (const item of raw) {
    if (item === null || typeof item !== 'object') continue;
    const { id, type, weighted } = item as Record<string, unknown>;
    if (typeof id === 'string' && id !== '' && type === 'assignee') {
      out.push({ id, weighted: weighted === true });
    }
  }
  return out;
}

/** 从节点 custom 值拉平人员列条目（layout 通道，2026-10-11 第二步）：按列序遍历、列内
 *  按对象键序；坏形状值跳过；v1 number 简形兼容（按 {progress, weight:1} 归一）；
 *  weight 按列 weighted 开关解析——false（按人数平分）恒 1，true 取存值（缺省 1）。 */
export function flattenAssigneeEntries(
  custom: Record<string, unknown> | undefined,
  columns: Array<{ id: string; weighted: boolean }>,
): AssigneeVisual[] {
  if (!custom || columns.length === 0) return [];
  const out: AssigneeVisual[] = [];
  for (const col of columns) {
    const raw = custom[col.id];
    if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) continue;
    for (const [user, v] of Object.entries(raw as Record<string, unknown>)) {
      const norm = typeof v === 'number' ? { progress: v } : (v as { progress?: unknown; weight?: unknown } | null);
      if (typeof norm?.progress !== 'number') continue;
      if (!Number.isInteger(norm.progress) || norm.progress < 0 || norm.progress > 100) continue;
      const weight =
        col.weighted && typeof norm.weight === 'number' && norm.weight > 0 ? norm.weight : 1;
      out.push({ user, name: user.slice(0, 8), progress: norm.progress, colId: col.id, weight });
    }
  }
  return out;
}
