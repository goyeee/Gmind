import { z } from 'zod';
import { codeSchema, emailSchema, NICKNAME_LENGTH_MESSAGE, PASSWORD_LENGTH_MESSAGE } from '@gmind/shared';

/**
 * 账号设置端点请求 schema（2026-11-12 账号体系重做 + FR-CMT-006 通知偏好收口）。
 * 校验失败由全局 ZodExceptionFilter 统一转 400 {message}。
 *
 * 邮箱/验证码格式与归一（trim+lowercase）直接复用 @gmind/shared 单点 schema
 * （Task 1 契约），服务端不再写第二份；密码/昵称长度文案复用 shared 导出常量，防漂移。
 */

/** 改密：强度 = 6~64 位（与注册/登录/重置统一口径，文案单点 PASSWORD_LENGTH_MESSAGE，
 *  旧 8~64 口径作废）；邮箱注册制人人有密码，恒带 currentPassword 核身。 */
export const changePasswordSchema = z.object({
  currentPassword: z.string().min(1, '请输入当前密码'),
  newPassword: z.string().min(6, PASSWORD_LENGTH_MESSAGE).max(64, PASSWORD_LENGTH_MESSAGE),
});

/** 换绑邮箱（POST /users/me/email）：当前密码核身 + email_bind 场景验证码 + 新邮箱
 *  （shared emailSchema 单点 trim+lowercase+格式）。核身顺序（密码 → 码 → 占用）在 service。 */
export const rebindEmailSchema = z.object({
  currentPassword: z.string().min(1, '请输入当前密码'),
  email: emailSchema,
  code: codeSchema,
});

/** 换绑手机号（POST /users/me/phone）：仅密码核身；格式同登录手机号口径 /^1\d{10}$/。 */
export const rebindPhoneSchema = z.object({
  currentPassword: z.string().min(1, '请输入当前密码'),
  phone: z.string().regex(/^1\d{10}$/, '手机号格式不正确，请检查后重试'),
});

/** 自助改昵称（PATCH /users/me）：1~32 字符，文案复用 shared 单点导出。 */
export const updateNicknameSchema = z.object({
  nickname: z.string().min(1, NICKNAME_LENGTH_MESSAGE).max(32, NICKNAME_LENGTH_MESSAGE),
});

/** 邮件退订类型（FR-CMT-006）：仅 mention/reply/permission——站内通知不可关闭；
 *  system（FR-FIL-010 回收站提醒恒发）不在可关闭之列，出现在请求中即 400。 */
export const EMAIL_OPT_OUT_TYPES = ['mention', 'reply', 'permission'] as const;

export type EmailOptOutType = (typeof EMAIL_OPT_OUT_TYPES)[number];

const optOutMemberSchema = z.enum(EMAIL_OPT_OUT_TYPES, {
  message: '通知类型仅支持 mention/reply/permission，请重新选择',
});

/** 通知偏好：PATCH 同 body 全量替换。两开关（2026-10-28 P1）可选，缺省 true。 */
export const notifyPrefsSchema = z.object({
  emailOptOut: z
    .array(optOutMemberSchema)
    .max(EMAIL_OPT_OUT_TYPES.length, '通知类型仅支持 mention/reply/permission，请重新选择'),
  notifyEnabled: z.boolean().optional(),
  digestEnabled: z.boolean().optional(),
});

/** 头像设置（2026-10-11）：avatarUrl 为 5 个预置 SVG 路径（/avatars/preset-1..5.svg）
 *  或本人上传键（users/{userId}/{ulid}.{ext}）——白名单在 service 二次校验
 *  （预置正则 + 本人键前缀），此处只约束长度。 */
export const avatarSchema = z.object({
  avatarUrl: z.string().min(1).max(500),
});
