import { z } from 'zod';

/** 手机验证码登录（开发环境验证码固定为 DEV_SMS_CODE，默认 123456） */
export const phoneLoginSchema = z.object({
  method: z.literal('phone'),
  phone: z.string().regex(/^1\d{10}$/, '手机号格式不正确'),
  code: z.string().min(4).max(6),
});

/**
 * 邮箱登录基础结构。discriminatedUnion 的选项必须是 ZodObject（ZodEffects 无 shape，
 * 传入会在模块加载时抛 TypeError），因此 refine 前先拆出此基础 schema。
 */
const emailLoginBaseSchema = z.object({
  method: z.literal('email'),
  email: z.string().email('邮箱格式不正确'),
  mode: z.enum(['code', 'password']),
  code: z.string().min(4).max(6).optional(),
  password: z.string().min(6).max(64).optional(),
});

/** 邮箱登录：验证码或密码二选一（spec §5.2）。带跨字段校验，服务端可直接解析请求体。 */
export const emailLoginSchema = emailLoginBaseSchema.refine(
  (v) => (v.mode === 'code' ? !!v.code : !!v.password),
  {
    message: '验证码或密码不能为空',
  },
);

/** 微信扫码登录（开发环境返回模拟账号，spec §5.2 DevProvider） */
export const wechatLoginSchema = z.object({
  method: z.literal('wechat'),
  mockOpenid: z.string().min(1).max(64).optional(),
  nickname: z.string().min(1).max(64).optional(),
});

export const loginSchema = z
  .discriminatedUnion('method', [phoneLoginSchema, emailLoginBaseSchema, wechatLoginSchema])
  .superRefine((v, ctx) => {
    // 原 emailLoginSchema.refine 的跨字段校验语义，迁到 union 层统一保证。
    if (v.method === 'email' && !(v.mode === 'code' ? !!v.code : !!v.password)) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: '验证码或密码不能为空' });
    }
  });

export type LoginRequest = z.infer<typeof loginSchema>;

export interface LoginResponse {
  token: string;
  expiresAt: number;
  user: { id: string; nickname: string; avatarUrl: string | null };
}
