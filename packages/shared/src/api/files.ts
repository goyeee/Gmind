import { z } from 'zod';
import type { StructureType } from '../enums';

export const FILE_KINDS = ['map', 'table'] as const;
export type FileKind = (typeof FILE_KINDS)[number];

export const createFileSchema = z.object({
  /** title 缺省由服务端按 kind 兜底（未命名脑图/未命名表格）。 */
  title: z.string().min(1).max(255).optional(),
  /** 文件类型（第二期批次 D）：table=表格文件（同构 docState，默认开表格视图）；缺省 map。 */
  kind: z.enum(FILE_KINDS).default('map'),
});

export interface FileListItem {
  id: string;
  title: string;
  structure: StructureType;
  nodeCount: number;
  lastOpenedAt: string | null;
  updatedAt: string;
  /** 文件类型（批次 D）：map=脑图（默认）、table=表格文件（同构 docState，默认开表格视图）。 */
  kind: FileKind;
}

/** 文件列表详细项（M3a Task 4，FR-FIL-001）：四视图（mine/shared/starred/recent）
 *  与 GET /api/files 全量的返回形态——在 FileListItem 基础上追加展示域。
 *  POST /api/files 创建响应维持 FileListItem 不变（toListItem 契约）。 */
export interface FileListItemDetailed extends FileListItem {
  ownerUserId: string;
  /** 创建时刻（ISO；二期对齐轮：首页「本周已创建 N 张脑图」口径）。 */
  createdAt: string;
  /** owner 昵称（LEFT JOIN users；用户缺失等异常 → null）。 */
  ownerName: string | null;
  /** owner 头像 URL（2026-10-25 原型文件卡创建者头像；无自定义头像 → null，
   *  前端 Avatar 兜底首字符色块）。 */
  ownerAvatarUrl: string | null;
  /** 最后修改人昵称（LEFT JOIN users by last_modifier_user_id；从未有人编辑 → null）。 */
  lastModifierName: string | null;
  folderId: string | null;
  folderName: string | null;
  /** 当前用户视角是否已加星。 */
  starred: boolean;
  /** 当前用户在该文件中的真实角色；工作台据此收敛改名等写入口。 */
  myRole: 'owner' | 'editor' | 'commenter' | 'viewer';
}

/** PATCH /api/files/:id 响应（M3a Task 5，FR-FIL-002）：FileListItem + 落点 folderId——
 *  改名与/或移动后的最新值，客户端无需回查列表即知落点（null = 根目录）。 */
export type FilePatchResult = FileListItem & { folderId: string | null };
