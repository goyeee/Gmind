export const MAX_TEXT_LENGTH = 500;
export const MAX_NOTE_LENGTH = 5000;
export const ICON_GROUPS = ['priority', 'progress', 'flag', 'star'] as const;
export type IconGroup = (typeof ICON_GROUPS)[number];
