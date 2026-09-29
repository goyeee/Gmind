export type GmindCoreErrorCode =
  | 'NODE_NOT_FOUND' | 'NODE_DELETED' | 'ROOT_FORBIDDEN' | 'CYCLE_FORBIDDEN'
  | 'TEXT_TOO_LONG' | 'NOTE_TOO_LONG' | 'INVALID_HREF' | 'INVALID_ICON_GROUP'
  | 'INVALID_ICON_VALUE' | 'INVALID_ICON_OVERFLOW'
  | 'TASK_INVALID_STATUS' | 'TASK_INVALID_PROGRESS' | 'TASK_INVALID_OWNERS' | 'TASK_INVALID_DATE'
  | 'SUMMARY_INVALID';

export class GmindCoreError extends Error {
  constructor(readonly code: GmindCoreErrorCode, message: string) {
    super(message);
    this.name = 'GmindCoreError';
  }
}
