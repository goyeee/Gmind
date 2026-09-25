/** mysql2 唯一键冲突判定（M4 清偿包统一出口）：ER_DUP_ENTRY / errno 1062。TypeORM
 *  QueryFailedError 会把驱动错误的自身可枚举属性（code/errno）拷贝到实例上，
 *  同时保留 driverError 引用——两层都查，跨驱动包装形态不漏判。
 *  调用点（并发双插败者归并幂等 no-op 的同一语义）：files.service star、
 *  share.service joinByToken、invite.service acceptPendingForNewUser。 */
export function isDuplicateKeyError(err: unknown): boolean {
  const e = err as { code?: string; errno?: number; driverError?: { code?: string; errno?: number } } | null;
  if (!e) return false;
  return (
    e.code === 'ER_DUP_ENTRY' ||
    e.errno === 1062 ||
    e.driverError?.code === 'ER_DUP_ENTRY' ||
    e.driverError?.errno === 1062
  );
}
