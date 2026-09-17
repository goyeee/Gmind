/** 文件级四级权限（spec §7.1）。一期只实际写入 owner/editor，枚举按四级预留。 */
export type FileRole = 'owner' | 'editor' | 'commenter' | 'viewer';

export type StructureType = 'mindmap' | 'logic' | 'org';

export type LoginMethod = 'phone' | 'email' | 'wechat';
