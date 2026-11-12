import { z } from 'zod';

/**
 * 账号体系契约（2026-11-12 重做：邮箱注册制）。
 * - 邮箱统一 trim+lowercase 归一，schema 单点 transform，消费方不再二次归一
 *   （MySQL utf8mb4_unicode_ci 唯一索引兜底大小写变体）。
 * - 登录体字段名 `account` 为将来手机号登录预留形状，本期仅收邮箱。
 * - 旧 method 三分支登录体（phone/email/wechat）与登录方式枚举已删除，无兼容期。
 */

/** 邮箱验证码场景：register=注册、password_reset=忘记密码重置、email_bind=换绑邮箱。 */
export const EMAIL_CODE_SCENES = ['register', 'password_reset', 'email_bind'] as const;
export type EmailCodeScene = (typeof EMAIL_CODE_SCENES)[number];

/** 邮箱/验证码格式错误文案（两段式=原因+下一步，NFR-USE-005）。 */
const EMAIL_FORMAT_MESSAGE = '邮箱格式不正确，请检查后重新输入';
const CODE_FORMAT_MESSAGE = '验证码应为 4~6 位数字，请核对后重新输入';

/** 密码长度提示（两段式文案）：注册/登录/重置密码三 schema 共用。 */
export const PASSWORD_LENGTH_MESSAGE = '密码长度需为 6~64 位，请调整后重试';
/** 昵称长度提示（两段式文案）。 */
export const NICKNAME_LENGTH_MESSAGE = '昵称长度需为 1~32 个字符，请调整后重试';

/**
 * 邮箱单点归一 schema：trim 去首尾空格 → 转小写 → 格式校验。
 * max 191 对齐 users.email 列宽；类型锁 z.ZodString（trim/toLowerCase 为 ZodString 内建变换）。
 */
export const emailSchema: z.ZodString = z
  .string({ required_error: EMAIL_FORMAT_MESSAGE, invalid_type_error: EMAIL_FORMAT_MESSAGE })
  .trim()
  .toLowerCase()
  .max(191, EMAIL_FORMAT_MESSAGE)
  .email(EMAIL_FORMAT_MESSAGE);

/** 邮箱验证码：4~6 位数字。 */
export const codeSchema: z.ZodString = z
  .string({ required_error: CODE_FORMAT_MESSAGE, invalid_type_error: CODE_FORMAT_MESSAGE })
  .regex(/^\d{4,6}$/, CODE_FORMAT_MESSAGE);

/** POST /api/auth/email-code 请求体：向指定邮箱发送指定场景的验证码。 */
export const emailCodeRequestSchema = z.object({
  scene: z.enum(EMAIL_CODE_SCENES),
  email: emailSchema,
});

/** POST /api/auth/register 请求体：邮箱验证码验证通过后建号，注册即登录（返回 LoginResponse）。 */
export const registerSchema = z.object({
  email: emailSchema,
  code: codeSchema,
  password: z.string().min(6, PASSWORD_LENGTH_MESSAGE).max(64, PASSWORD_LENGTH_MESSAGE),
  nickname: z.string().min(1, NICKNAME_LENGTH_MESSAGE).max(32, NICKNAME_LENGTH_MESSAGE),
});

/** POST /api/auth/login 请求体：邮箱+密码登录；rememberMe=true 时签发 30 天会话。 */
export const loginSchema = z.object({
  account: emailSchema,
  password: z.string().min(6, PASSWORD_LENGTH_MESSAGE).max(64, PASSWORD_LENGTH_MESSAGE),
  rememberMe: z.boolean().optional(),
});

/** POST /api/auth/password-reset 请求体（忘记密码）：验证码核验通过后重置密码。 */
export const passwordResetSchema = z.object({
  email: emailSchema,
  code: codeSchema,
  newPassword: z.string().min(6, PASSWORD_LENGTH_MESSAGE).max(64, PASSWORD_LENGTH_MESSAGE),
});

export interface LoginResponse {
  token: string;
  expiresAt: number;
  user: { id: string; nickname: string; avatarUrl: string | null };
}
