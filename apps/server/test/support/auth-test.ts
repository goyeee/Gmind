import type { INestApplication } from '@nestjs/common';
import { expect } from 'vitest';
import request from 'supertest';

/**
 * e2e 账号装置（2026-11-12 账号体系重做，Task 5）：全部走真实 API 建号/登录，
 * 不再直签会话（旧 users.create({method:'phone'}) + SessionService.create 通道已废）。
 *
 * - 建号 = POST /api/auth/email-code(register) → POST /api/auth/register（注册即登录）；
 *   dev/test 验证码恒 TEST_CODE（= env.DEV_MAIL_CODE 默认值，任务 2 裁定）。
 * - 每个注册号自动种 3 个示例文件（register → createSeedFiles，FR-ACC-001）——
 *   断言文件列表/数量时须把这 3 个计入。
 * - uniqueEmail 前缀 ts+随机：全库唯一，e2e 串行 + createTestApp 每文件清库，
 *   不与历史数据冲突。
 */

/** dev/test 邮箱验证码固定值（= DEV_MAIL_CODE 默认值，勿在 spec 里硬编码）。 */
export const TEST_CODE = '123456';

/** 全库唯一测试邮箱：默认域 'test.dev'，前缀 ts+随机防撞。 */
export function uniqueEmail(domain = 'test.dev'): string {
  return `u${Date.now()}${Math.random().toString(36).slice(2, 8)}@${domain}`;
}

export interface TestAccount {
  id: string;
  email: string;
  token: string;
}

/** 建号即登录（走真实 API）：返回 {id, email, token}。password 默认 'pass123456'、
 *  nickname 默认 '用户'+随机 4 位（需断言昵称/邮箱的用例显式传）。 */
export async function createAccount(
  app: INestApplication,
  opts?: { email?: string; password?: string; nickname?: string },
): Promise<TestAccount> {
  const email = opts?.email ?? uniqueEmail();
  const password = opts?.password ?? 'pass123456';
  const nickname = opts?.nickname ?? `用户${Math.floor(1000 + Math.random() * 9000)}`;
  const issue = await request(app.getHttpServer())
    .post('/api/auth/email-code')
    .send({ scene: 'register', email });
  expect(issue.status).toBe(204);
  const res = await request(app.getHttpServer())
    .post('/api/auth/register')
    .send({ email, code: TEST_CODE, password, nickname });
  expect(res.status).toBe(200);
  const body = res.body as { token: string; user: { id: string } };
  return { id: body.user.id, email, token: body.token };
}

/** 邮箱+密码登录换 token（password 缺省与 createAccount 默认对齐）。 */
export async function loginToken(
  app: INestApplication,
  email: string,
  password = 'pass123456',
): Promise<string> {
  const res = await request(app.getHttpServer())
    .post('/api/auth/login')
    .send({ account: email, password });
  expect(res.status).toBe(200);
  return (res.body as { token: string }).token;
}
