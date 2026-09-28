export type GmindCoreErrorCode =
  | 'NODE_NOT_FOUND' | 'NODE_DELETED' | 'ROOT_FORBIDDEN' | 'CYCLE_FORBIDDEN'
  | 'TEXT_TOO_LONG' | 'NOTE_TOO_LONG' | 'INVALID_HREF' | 'INVALID_ICON_GROUP'
  | 'SUMMARY_INVALID';

export class GmindCoreError extends Error {
  constructor(readonly code: GmindCoreErrorCode, message: string) {
    super(message);
    this.name = 'GmindCoreError';
  }
}
