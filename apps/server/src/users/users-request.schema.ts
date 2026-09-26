import { z } from 'zod';

/**
 * 账号设置端点请求 schema（M5 Task 1，FR-ACC-002 收口 + FR-CMT-006 通知偏好收口）。
 * 校验失败由全局 ZodExceptionFilter 统一转 400 {message}。
 */

/** 改密：强度 = 8~64 位（PRD 未定义强度规则，登记：仅约束长度，任意可见字符均接受）。
 *  有密码（邮箱注册设置过）用户带 currentPassword；无密码（手机号注册）用户带 code。 */
export const changePasswordSchema = z.object({
  newPassword: z
    .string()
    .min(8, '新密码长度需为 8~64 位，请调整后重试')
    .max(64, '新密码长度需为 8~64 位，请调整后重试'),
  currentPassword: z.string().min(1).optional(),
  code: z.string().min(4).max(6).optional(),
});

/** 换绑基础结构：channel + 新身份 + 验证码。新身份格式校验在 service 内按 channel
 *  二次解析（brief 语义顺序：code 校验 → 格式校验 → 占用检查）。 */
export const rebindRequestSchema = z.object({
  channel: z.enum(['phone', 'email']),
  newIdentity: z.string().min(1).max(191),
  code: z.string().min(4).max(6),
});

/** 新手机号格式（同登录 phoneLoginSchema 的 phone 口径 /^1\d{10}$/）。 */
export const rebindPhoneIdentitySchema = z.string().regex(/^1\d{10}$/, '手机号格式不正确，请检查后重试');

/** 新邮箱格式（同登录 emailLoginSchema 的 email 口径）。 */
export const rebindEmailIdentitySchema = z.string().email('邮箱格式不正确，请检查后重试');

/** 邮件退订类型（FR-CMT-006）：仅 mention/reply/permission——站内通知不可关闭；
 *  system（FR-FIL-010 回收站提醒恒发）不在可关闭之列，出现在请求中即 400。 */
export const EMAIL_OPT_OUT_TYPES = ['mention', 'reply', 'permission'] as const;

export type EmailOptOutType = (typeof EMAIL_OPT_OUT_TYPES)[number];

const optOutMemberSchema = z.enum(EMAIL_OPT_OUT_TYPES, {
  message: '通知类型仅支持 mention/reply/permission，请重新选择',
});

/** 通知偏好：PATCH 同 body 全量替换。 */
export const notifyPrefsSchema = z.object({
  emailOptOut: z
    .array(optOutMemberSchema)
    .max(EMAIL_OPT_OUT_TYPES.length, '通知类型仅支持 mention/reply/permission，请重新选择'),
});
