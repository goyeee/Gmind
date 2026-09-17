import { describe, expect, it } from 'vitest';
import { emailLoginSchema, loginSchema, phoneLoginSchema, wechatLoginSchema } from './auth';
import { createFileSchema } from './files';

describe('auth schemas', () => {
  it('四个 schema 均可构造，且 loginSchema 接受合法手机号登录', () => {
    // 回归锁：构造阶段抛错即代表 @gmind/shared 无法导入（见 Task 1 review Critical 1）
    expect(phoneLoginSchema).toBeDefined();
    expect(emailLoginSchema).toBeDefined();
    expect(wechatLoginSchema).toBeDefined();
    expect(loginSchema).toBeDefined();

    expect(
      loginSchema.parse({ method: 'phone', phone: '13800138000', code: '123456' }),
    ).toEqual({ method: 'phone', phone: '13800138000', code: '123456' });
  });

  it('loginSchema 拒绝 email mode=code 但缺少 code（原 refine 语义，保留在 union 层）', () => {
    expect(() =>
      loginSchema.parse({ method: 'email', email: 'user@example.com', mode: 'code' }),
    ).toThrowError(/验证码或密码不能为空/);
  });

  it('emailLoginSchema 单独解析时仍拒绝 email mode=code 但缺少 code', () => {
    expect(() =>
      emailLoginSchema.parse({ method: 'email', email: 'user@example.com', mode: 'code' }),
    ).toThrowError(/验证码或密码不能为空/);
  });

  it('loginSchema 接受合法 email 密码登录（superRefine 不误伤）', () => {
    expect(loginSchema.parse({ method: 'email', email: 'user@example.com', mode: 'password', password: 'secret1' })).toEqual({
      method: 'email',
      email: 'user@example.com',
      mode: 'password',
      password: 'secret1',
    });
  });
});

describe('file schemas', () => {
  it('createFileSchema.parse({}) 默认标题为 未命名脑图', () => {
    expect(createFileSchema.parse({})).toEqual({ title: '未命名脑图' });
  });
});
