import { z } from 'zod';

/** 文件夹命名规则（FR-FIL-002）：1~64 字符，禁止文件系统非法字符 / \ : * ? " < > |。 */
export const FOLDER_NAME_MAX = 64;

export const folderNameSchema = z
  .string()
  .min(1, '文件夹名称不能为空')
  .max(FOLDER_NAME_MAX, `文件夹名称不能超过 ${FOLDER_NAME_MAX} 个字符`)
  .refine((v) => !/[/\\:*?"<>|]/.test(v), '文件夹名称不能包含 / \\ : * ? " < > | 字符');

/** POST /api/folders {name, parentId?}。 */
export const createFolderSchema = z.object({
  name: folderNameSchema,
  parentId: z.string().min(1).max(26).optional(),
});

/** PATCH /api/folders/:id：改名与移动二选一或同时；至少提供一个字段。 */
export const updateFolderSchema = z
  .object({
    name: folderNameSchema.optional(),
    parentId: z.string().min(1).max(26).nullable().optional(),
  })
  .refine((v) => v.name !== undefined || v.parentId !== undefined, {
    message: '至少提供 name 或 parentId',
  });

/** FolderItem（GET /api/folders 裁定口径）：扁平数组，客户端组树；服务端按 depth ASC → name ASC 排序。 */
export interface FolderItem {
  id: string;
  name: string;
  parentId: string | null;
  depth: number;
}
