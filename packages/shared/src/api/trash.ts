/** 回收站条目（M3a Task 7 服务端契约，Task 9 随 web 接线上移 @gmind/shared）：
 *  GET /api/trash 的返回形态。 */
export interface TrashItem {
  id: string;
  title: string;
  nodeCount: number;
  /** 删除时刻（ISO）。 */
  deletedAt: string;
  /** 删除人昵称（deleted_by → users.nickname；异常缺失 → null）。 */
  deletedByName: string | null;
  /** 删除时所在文件夹名（files.folder_id → folders.name，不筛 deleted_at——
   *  原文件夹随后被删时按旧名回显；根目录文件 → null）。 */
  folderName: string | null;
}
