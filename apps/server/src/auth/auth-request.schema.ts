import { z } from 'zod';
import { loginSchema } from '@gmind/shared';

export const authRequestSchema = z.intersection(
  z.object({
    rememberMe: z.boolean().optional(),
    /** 仅 email 注册时可选设置密码（6~64 位），登录时用于密码模式校验 */
    password: z.string().min(6).max(64).optional(),
  }),
  loginSchema,
);
