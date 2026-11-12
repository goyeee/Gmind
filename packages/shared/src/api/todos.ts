/**
 * 跨文件待办契约（2026-10-24 第二期批次 B/C，spec 2026-10-24-phase2-features-design §三/§四）。
 * 数据源=服务端 task_index 索引表（persisted/PUT 落库后从 docState 抽取，owners 为
 * 任务负责人 userId 集）；范围口径=「负责人含我」且文件存活且我有权见（owner/协作者）。
 */

export type TodoTaskStatus = 'todo' | 'doing' | 'done';

/** 我的待办条目（一行=一个节点任务）。 */
export interface TodoItem {
  fileId: string;
  fileTitle: string;
  nodeId: string;
  /** 节点文本（截断 255）。 */
  text: string;
  status: TodoTaskStatus;
  progress: number;
  startDate: string | null;
  dueDate: string | null;
  /** 任务负责人 userId 集（明细表显示名由前端经 org directory 昵称解析）。 */
  owners: string[];
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

/** 待办空间按主体聚合行（人员/部门/分组同构；name=主体显示名）。 */
export interface TodoOwnerRow {
  key: string;
  name: string;
  total: number;
  done: number;
  doing: number;
  todo: number;
  overdue: number;
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
}
