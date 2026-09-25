import { z } from 'zod';

/**
 * 埋点端点请求体（M4 Task 7，binding 形状 {type: string, fileId?: string, payload?: object}）。
 *
 * type：1~64 字符（与 events.type varchar(64) 列宽一致）；fileId 从宽（≤64，ULID 形状
 * 不在此强校验——埋点是遥测通道，坏 id 只影响行值不伤业务）；payload：任意对象。
 */
export const trackEventSchema = z.object({
  type: z.string().min(1, 'type 不能为空').max(64),
  fileId: z.string().max(64).optional(),
  payload: z.record(z.unknown()).optional(),
});

export type TrackEventInput = z.infer<typeof trackEventSchema>;
