export const MAX_TEXT_LENGTH = 500;
export const MAX_NOTE_LENGTH = 5000;

/**
 * 标记三组制（M7a-T1，2026-09-28 需求方裁定「功能冲突以 mindgrid 为准」）：
 * 五组制（priority/progress/flag/star/emoji）切换为 mindgrid 三组制——
 * priority(1-7) / icon(10 符号) / emoji(10 字符)；status 与 progress 从标记体系
 * 迁入节点任务字段（setNodeTask）。组内单选、组间并存语义不变。
 * 值目录由本模块单源导出（setIcon 值校验 / xmind-io 目录对齐 / repair 旧值映射
 * 的收敛目标都指向这里）；旧五组值的迁移见 repair.ts 的图标收敛规则。
 */
export const ICON_GROUPS = ['priority', 'icon', 'emoji'] as const;
export type IconGroup = (typeof ICON_GROUPS)[number];

/** 优先级值目录 '1'..'7'（XMind 的 8/9 在导入与 repair 收敛为 '7'）。 */
export const PRIORITY_VALUES = ['1', '2', '3', '4', '5', '6', '7'] as const;

/**
 * icon 组值目录（10 个 slug，与 mindgrid MARKER_GROUPS.icon 逐一对应；字形
 * ✓✗★⚑?!💡♥🔗⏰ 由 engine 渲染层持有）：done=完成 cancel=取消 important=重要
 * flag=旗帜 question=疑问 alert=注意 idea=想法 like=喜欢 link=关联 clock=提醒。
 */
export const ICON_VALUES = [
  'done',
  'cancel',
  'important',
  'flag',
  'question',
  'alert',
  'idea',
  'like',
  'link',
  'clock',
] as const;

/** emoji 组值目录（10 字符，与 mindgrid MARKER_GROUPS.emoji 完全一致）。 */
export const EMOJI_VALUES = ['😄', '🙂', '😐', '😟', '😢', '😠', '😴', '🤔', '👍', '👎'] as const;

/** 组 → 值目录（setIcon 值校验与消费方目录遍历的统一入口）。 */
export function iconValuesOf(group: IconGroup): readonly string[] {
  switch (group) {
    case 'priority':
      return PRIORITY_VALUES;
    case 'icon':
      return ICON_VALUES;
    default:
      return EMOJI_VALUES;
  }
}

/* ── 任务字段约束（M7a-T1，setNodeTask 校验口径单源）────────────────────── */

export const TASK_STATUSES = ['todo', 'doing', 'done', 'blocked'] as const;
export type TaskStatus = (typeof TASK_STATUSES)[number];

/** 负责人上限：去重后 ≤20 项，每项（用户ID）长度 1-64。 */
export const MAX_TASK_OWNERS = 20;
export const TASK_OWNER_MIN_LENGTH = 1;
export const TASK_OWNER_MAX_LENGTH = 64;

/** 'YYYY-MM-DD'（repair/read 防御读取与 op 校验共用的形状正则；合法性另做日历校验）。 */
export const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/** 日期字符串日历合法性（形状 + 年月日回读一致，覆盖大小月/闰年边界）；read 与
 *  setNodeTask 校验共用的单源实现。 */
export function isValidDateStr(s: string): boolean {
  if (!DATE_RE.test(s)) return false;
  const [y, m, d] = s.split('-').map(Number) as [number, number, number];
  const dt = new Date(y, m - 1, d);
  return dt.getFullYear() === y && dt.getMonth() === m - 1 && dt.getDate() === d;
}
