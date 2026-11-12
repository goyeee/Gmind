import { describe, expect, it } from 'vitest';
import {
  EMAIL_CODE_SCENES,
  NICKNAME_LENGTH_MESSAGE,
  PASSWORD_LENGTH_MESSAGE,
  codeSchema,
  emailCodeRequestSchema,
  emailSchema,
  loginSchema,
  passwordResetSchema,
  registerSchema,
} from './auth';
import { createFileSchema } from './files';

describe('auth schemas（2026-11-12 账号体系重做：邮箱注册制）', () => {
  it('registerSchema 接受合法输入，且 email 归一为小写无首尾空格', () => {
    expect(
      registerSchema.parse({
        email: ' A@X.com ',
        code: '123456',
        password: 'secret1',
        nickname: '小明',
      }),
    ).toEqual({ email: 'a@x.com', code: '123456', password: 'secret1', nickname: '小明' });
  });

  it('registerSchema 拒绝 5 位密码/空昵称/非数字验证码，长度提示为两段式文案', () => {
    const base = { email: 'user@example.com', code: '123456', password: 'secret1', nickname: '小明' };
    expect(() => registerSchema.parse({ ...base, password: 'a1234' })).toThrowError(PASSWORD_LENGTH_MESSAGE);
    expect(() => registerSchema.parse({ ...base, nickname: '' })).toThrowError(NICKNAME_LENGTH_MESSAGE);
    expect(() => registerSchema.parse({ ...base, code: '12a456' })).toThrowError(/验证码/);
    expect(codeSchema.parse('1234')).toBe('1234');
    expect(codeSchema.parse('123456')).toBe('123456');
    expect(() => codeSchema.parse('123')).toThrowError();
    expect(() => codeSchema.parse('1234567')).toThrowError();
  });

  it('loginSchema 拒绝非邮箱 account，接受 rememberMe 缺省', () => {
    expect(() => loginSchema.parse({ account: '13800138000', password: 'secret1' })).toThrowError(/邮箱/);
    expect(loginSchema.parse({ account: ' User@Example.com ', password: 'secret1' })).toEqual({
      account: 'user@example.com',
      password: 'secret1',
    });
    expect(loginSchema.parse({ account: 'user@example.com', password: 'secret1', rememberMe: true }).rememberMe).toBe(
      true,
    );
  });

  it('passwordResetSchema 形状：email+code+newPassword，newPassword 6~64', () => {
    expect(
      passwordResetSchema.parse({ email: ' U@X.com ', code: '1234', newPassword: 'secret1' }),
    ).toEqual({ email: 'u@x.com', code: '1234', newPassword: 'secret1' });
    expect(() =>
      passwordResetSchema.parse({ email: 'u@x.com', code: '1234', newPassword: 'a1234' }),
    ).toThrowError(PASSWORD_LENGTH_MESSAGE);
  });

  it('emailCodeRequestSchema 拒绝 scene 枚举外的值，三个合法场景全通过', () => {
    for (const scene of EMAIL_CODE_SCENES) {
      expect(emailCodeRequestSchema.parse({ scene, email: 'U@X.com' })).toEqual({ scene, email: 'u@x.com' });
    }
    expect(() => emailCodeRequestSchema.parse({ scene: 'login', email: 'u@x.com' })).toThrowError();
  });

  it('emailSchema 大小写/尾随空格归一，超长（>191）与非邮箱格式被拒', () => {
    expect(emailSchema.parse(' A@X.com ')).toBe('a@x.com');
    expect(emailSchema.parse('MiXeD@X.COM')).toBe('mixed@x.com');
    expect(emailSchema.parse(`${'a'.repeat(185)}@x.com`)).toBe(`${'a'.repeat(185)}@x.com`); // 恰好 191 字符
    expect(() => emailSchema.parse(`${'a'.repeat(186)}@x.com`)).toThrowError(); // 192 字符拒绝
    expect(() => emailSchema.parse('not-an-email')).toThrowError(/邮箱/);
  });
});

describe('file schemas', () => {
  it('createFileSchema.parse({}) 缺省 kind=map（title 缺省由服务端按 kind 兜底）', () => {
    expect(createFileSchema.parse({})).toEqual({ kind: 'map' });
    expect(createFileSchema.parse({ kind: 'table' })).toEqual({ kind: 'table' });
  });
});
