import { z } from 'zod';
import type { StructureType } from '../enums';

export const createFileSchema = z.object({
  title: z.string().min(1).max(255).default('未命名脑图'),
});

export interface FileListItem {
  id: string;
  title: string;
  structure: StructureType;
  nodeCount: number;
  lastOpenedAt: string | null;
  updatedAt: string;
}

/** 文件列表详细项（M3a Task 4，FR-FIL-001）：四视图（mine/shared/starred/recent）
 *  与 GET /api/files 全量的返回形态——在 FileListItem 基础上追加展示域。
 *  POST /api/files 创建响应维持 FileListItem 不变（toListItem 契约）。 */
export interface FileListItemDetailed extends FileListItem {
  ownerUserId: string;
  /** owner 昵称（LEFT JOIN users；用户缺失等异常 → null）。 */
  ownerName: string | null;
  /** 最后修改人昵称（LEFT JOIN users by last_modifier_user_id；从未有人编辑 → null）。 */
  lastModifierName: string | null;
  folderId: string | null;
  folderName: string | null;
  /** 当前用户视角是否已加星。 */
  starred: boolean;
}
