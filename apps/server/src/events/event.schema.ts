import { z } from 'zod';

/**
 * 埋点端点请求体（M4 Task 7，binding 形状 {type: string, fileId?: string, payload?: object}）。
 *
 * type：1~64 字符（与 events.type varchar(64) 列宽一致）；fileId 从宽（≤64，ULID 形状
 * 不在此强校验——埋点是遥测通道，坏 id 只影响行值不伤业务）；payload：任意对象。
 *
 * payload 尺寸上界（M5 Task 4，M4 挂账清偿）：JSON.stringify ≤ 10_000 字符——payload 列
 * 为 MySQL TEXT（64KB），放任超长 payload 会在列边界炸 500（遥测通道不得伤主流程，
 * 更不该以 500 收场）。超限 400「事件数据过大」，由 ZodExceptionFilter 统一呈现。
 */
export const MAX_EVENT_PAYLOAD_CHARS = 10_000;

export const trackEventSchema = z.object({
  type: z.string().min(1, 'type 不能为空').max(64),
  fileId: z.string().max(64).optional(),
  payload: z
    .record(z.unknown())
    .refine((p) => JSON.stringify(p).length <= MAX_EVENT_PAYLOAD_CHARS, { message: '事件数据过大' })
    .optional(),
});

export type TrackEventInput = z.infer<typeof trackEventSchema>;
