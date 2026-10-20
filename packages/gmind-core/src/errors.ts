export type GmindCoreErrorCode =
  | 'NODE_NOT_FOUND' | 'NODE_DELETED' | 'ROOT_FORBIDDEN' | 'CYCLE_FORBIDDEN'
  | 'TEXT_TOO_LONG' | 'NOTE_TOO_LONG' | 'DESCRIPTION_TOO_LONG' | 'INVALID_HREF' | 'INVALID_ICON_GROUP'
  | 'INVALID_ICON_VALUE' | 'INVALID_ICON_OVERFLOW'
  | 'TASK_INVALID_STATUS'
  | 'TASK_INVALID_PROGRESS'
  | 'TASK_INVALID_AUTO_PROGRESS'
  | 'TASK_INVALID_OWNERS'
  | 'TASK_INVALID_DATE'
  /** done 门禁（人员进度列，需求方 2026-10-11 裁定）：标完成要求所有人员进度列
   *  条目与标准负责人进度全 100%（文案两段式=原因+下一步）。 */
  | 'TASK_DONE_GATE_BLOCKED'
  | 'SUMMARY_INVALID'
  | 'INVALID_NODE_SIDE' | 'SIDE_ONLY_ROOT_CHILD'
  /** 表格自定义列（doc 级 schema + 节点 custom 值）：schema 定义非法 / 超列上限 /
   *  未知列 / 值类型非法 / text 超长（文案两段式=原因+下一步，NFR-USE-005）。 */
  | 'CUSTOM_COLUMN_INVALID' | 'CUSTOM_COLUMN_OVERFLOW'
  | 'CUSTOM_FIELD_UNKNOWN_COL' | 'CUSTOM_FIELD_INVALID_VALUE' | 'CUSTOM_FIELD_TEXT_TOO_LONG'
  /** 表格视图列体系（meta.tableView 统一列序/隐藏/固定/排序）：入参形状非法。 */
  | 'TABLE_VIEW_INVALID'
  /** 节点图片位置（图文四槽位，需求方 2026-10-20）：placement 非法 / 同节点移动。 */
  | 'INVALID_IMAGE_PLACEMENT' | 'INVALID_IMAGE_MOVE';

export class GmindCoreError extends Error {
  constructor(readonly code: GmindCoreErrorCode, message: string) {
    super(message);
    this.name = 'GmindCoreError';
  }
}
