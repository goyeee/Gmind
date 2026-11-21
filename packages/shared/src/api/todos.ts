/**
 * 跨文件待办契约（2026-10-24 第二期批次 B/C，spec 2026-10-24-phase2-features-design §三/§四；
 * 2026-11-21 第二轮扩口径：收录参与人、画布两级、我的角色与子进度、blocked 独立档）。
 * 数据源=服务端 task_index 索引表 + task_participant 参与人表；范围口径=「负责人或
 * 参与人含我」且文件存活且我有权见（owner/协作者）。
 */

export type TodoTaskStatus = 'todo' | 'doing' | 'blocked' | 'done';

/** 我在该任务中的角色（第二轮）：负责人/参与人/双身份（双身份徽章只显「总负责人」）。 */
export type TodoMyRole = 'owner' | 'participant' | 'both';

/** 我的待办条目（一行=一个节点任务；同一任务同一人天然一行，无重复）。 */
export interface TodoItem {
  fileId: string;
  fileTitle: string;
  /** 节点所属画布 id；null=旧口径索引行（文件未重新打开过，画布显示「未知画布」）。 */
  canvasId: string | null;
  /** 画布名快照；null 同上。 */
  canvasName: string | null;
  nodeId: string;
  /** 节点文本（截断 255）。 */
  text: string;
  /** 派生总状态（自动父随子级汇总；blocked 独立档不再归一成 todo）。 */
  status: TodoTaskStatus;
  /** 有效任务总进度（taskProgressOf 同口径）。 */
  progress: number;
  startDate: string | null;
  dueDate: string | null;
  /** 任务负责人 userId 集（明细表显示名由前端经 org directory 昵称解析）。 */
  owners: string[];
  /** 人员列参与人 userId 集（第二轮：统计/下钻/展示用）。 */
  participants: string[];
  /** 我在该任务中的角色。 */
  myRole: TodoMyRole;
  /** 我的子进度（我的人员列条目最高值 ∪ 我是负责人时的 ownerProgress，取最大；
   *  都没有为 null）。「我的子进度未完成」筛选与行上选盘数据源。 */
  mySubProgress: number | null;
}

/** 我的待办统计卡口径（全量口径，不随 view 收缩；done 独立计）。 */
export interface TodoStats {
  /** 未完成总数。 */
  all: number;
  /** 今日到期（dueDate=今天且未完成）。 */
  today: number;
  /** 已逾期（dueDate<今天且未完成）。 */
  overdue: number;
  /** 7 天内到期（dueDate∈[今天,+7] 且未完成）。 */
  week: number;
  /** 已完成总数。 */
  done: number;
}

/** GET /api/todos 响应。 */
export interface TodoPage {
  stats: TodoStats;
  items: TodoItem[];
}

/**
 * 待办空间按主体聚合行（人员/部门/分组同构；name=主体显示名）。
 * 第二轮拆角色计数：responsible=任总负责人的任务数、participating=任执行人的任务数；
 * 同人同任务只进一处（responsible 优先），total=responsible+participating；
 * 完成/进行中/未开始/逾期与完成率仍按任务总进度（任务级）。
 */
export interface TodoOwnerRow {
  key: string;
  name: string;
  /** 头像存储键（users/<id>/…；web 经 avatarSrcOf 转直出 URL；无头像 undefined）。 */
  avatarUrl?: string | null;
  total: number;
  /** 其中我任总负责人的任务数。 */
  responsible: number;
  /** 其中我任执行人（人员列参与）的任务数。 */
  participating: number;
  done: number;
  doing: number;
  todo: number;
  overdue: number;
}

/** 统计面板人员名单项（明细池全部相关人，与时间范围解耦；页面名字/头像解析源）。 */
export interface TodoReportPerson {
  id: string;
  name: string;
  avatarUrl: string | null;
}

/** GET /api/todos/report 响应（待办空间）。 */
export interface TodoReport {
  stats: { total: number; done: number; doing: number; todo: number; overdue: number; rate: number };
  byOwner: TodoOwnerRow[];
  byDepartment: TodoOwnerRow[];
  byGroup: TodoOwnerRow[];
  /** 近 7 天完成趋势（date=YYYY-MM-DD，done=当日 doneDate 计数）。 */
  byDay: Array<{ date: string; done: number }>;
  items: TodoItem[];
  /** 明细池全部相关人名单（id→昵称/头像，与时间范围解耦）——页面名字解析源。 */
  people: TodoReportPerson[];
}

/* ── 任务动态（第二轮，spec §5.5）────────────────────────────────────── */

/** 任务动态事件类型（粗集六类 + 子进度归进度类的裁定扩展）。 */
export type TodoActivityType =
  | 'task_assign'
  | 'task_assignee_add'
  | 'task_assignee_remove'
  | 'task_progress'
  | 'task_status'
  | 'task_complete'
  | 'task_reopen';

/**
 * 任务动态事件 payload（events.payload JSON 文本）。操作者/文案全链路以服务端为准：
 * actor 由连接/服务端身份盖章，taskText 服务端从文档现值覆盖；related=操作瞬间
 * 「总负责人 + 全体人员列成员」，是「与我相关」查询依据（JSON 引号精确串 LIKE）。
 */
export interface TaskEventPayload {
  fileId: string;
  canvasId: string | null;
  nodeId: string;
  taskText: string;
  /** 操作者（重建补记=触发重建的最后修改者，可能 null）。 */
  actor: string | null;
  related: string[];
  /** 任务级状态/进度变化（总进度、状态、完成、重开、自动父派生）。 */
  before: { status: string; progress: number } | null;
  after: { status: string; progress: number } | null;
  /** 子进度变更（task_progress 细分，裁定 2026-11-21：归进度类）。 */
  sub?: { user: string; before: number; after: number; colName?: string | null };
  /** 指派变化（task_assign）：新旧负责人。 */
  owner?: { before: string | null; after: string | null };
  /** 加/移人（task_assignee_add/remove）：对象与列名。 */
  member?: { user: string; colName?: string | null };
  /** 自动父派生变化补记标记（无用户级写入，操作者为近似归属）。 */
  derived?: boolean;
}

/** GET /api/todos/activity 条目（跨文件动态流）。 */
export interface TodoActivityItem {
  id: string;
  type: string;
  createdAt: string;
  /** 操作者昵称（系统补记无操作者为 null，显示层兜底）。 */
  userName: string | null;
  /** 文件标题（跨文件流显示「在 xx 文件」；文件级动态端点无此列，可空）。 */
  fileTitle?: string | null;
  /** 损坏行防御 null（遥测旁路历史脏行不炸动态流）。 */
  payload: TaskEventPayload | null;
}

/* ── 待办/统计参与范围配置（2026-11-21 需求方追加）────────────────────── */

/** 参与范围配置中的画布项（只列有任务的画布；excluded=true=已排除）。 */
export interface TodoScopeCanvas {
  canvasId: string;
  canvasName: string;
  excluded: boolean;
}

/** 参与范围配置中的文件项（excluded=true=整个文件已排除；画布级排除在 file 排除时不生效）。 */
export interface TodoScopeFile {
  fileId: string;
  title: string;
  excluded: boolean;
  canvases: TodoScopeCanvas[];
}

/** GET /api/todos/scope 响应。 */
export interface TodoScope {
  files: TodoScopeFile[];
}
