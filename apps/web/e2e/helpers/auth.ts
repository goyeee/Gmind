import { expect, type APIRequestContext, type Page } from '@playwright/test';

/**
 * web e2e 登录公共 helper（2026-11-12 账号体系重做）。
 *
 * 旧「LoginPage UI 手机验证码登录」通道已随服务端三 Provider 删除：39 份各 spec
 * 自带的 registerAndLogin 副本（走 UI 填手机号）收敛到本文件，改走 API 造号 +
 * localStorage 注 token 直达工作台（原 settings.e2e.spec.ts「API 造号→addInitScript
 * 注 token」先例的放大版）。覆盖：
 * - apiRegister：POST /api/auth/email-code（dev 固定码 123456，免 SMTP）+
 *   POST /api/auth/register（注册即登录，返回 token）；每个用例用唯一邮箱，
 *   不触碰 60s 重发冷却；
 * - injectToken：addInitScript 写 localStorage gmind.token（app 侧会话装载通道）；
 * - registerAndLogin：apiRegister → injectToken → 落工作台（原副本落点语义：
 *   首页 quick-create-blank 可见 → 我的文件视图 3 个种子文件）。
 *
 * 注册即赠 3 个种子文件（服务端 register → createSeedFiles），与旧「手机验证码
 * 首登即注册」的种子语义一致，故依赖种子文件的既有断言不必改动。
 */

/** e2e 造号邮箱统一域名（cleanup-test-users 判据按此后缀清理，勿改）。 */
export const E2E_DOMAIN = 'e2e.gmind.dev';

/** 注册即登录的账号视图：token 供 API 级编排复用（免二次登录）。 */
export interface WebAccount {
  email: string;
  password: string;
  nickname: string;
  token: string;
}

const randomSuffix = (): string =>
  `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;

/**
 * 经 API 注册新账号并返回完整账号视图（注册即登录）。
 * email 默认随机 @E2E_DOMAIN（唯一，不撞发码 60s 冷却）；password 默认 pass123456
 * （6~64 位，同服务端 registerSchema）；nickname 默认「用户」+ 随机 4 位
 * （与旧手机注册的默认昵称形态一致——展示断言请直接用返回值，勿自行拼接）。
 */
export async function apiRegister(
  request: APIRequestContext,
  opts?: { email?: string; password?: string; nickname?: string },
): Promise<WebAccount> {
  const account: WebAccount = {
    email: opts?.email ?? `e2e-${randomSuffix()}@${E2E_DOMAIN}`,
    password: opts?.password ?? 'pass123456',
    nickname: opts?.nickname ?? `用户${Math.floor(1000 + Math.random() * 9000)}`,
    token: '',
  };
  const code = await request.post('/api/auth/email-code', {
    data: { scene: 'register', email: account.email },
  });
  expect(code.status()).toBe(204); // dev 恒 204：固定码不发信（EmailCodeService 裁定）
  const registered = await request.post('/api/auth/register', {
    data: { email: account.email, code: '123456', password: account.password, nickname: account.nickname },
  });
  expect(registered.status()).toBe(200);
  account.token = ((await registered.json()) as { token: string }).token;
  return account;
}

/** 注入会话：addInitScript 在每个后续导航前写 localStorage gmind.token（app 装载通道）。 */
export async function injectToken(page: Page, token: string): Promise<void> {
  await page.addInitScript((t) => localStorage.setItem('gmind.token', t), token);
}

/**
 * 注册并直达工作台（原 39 份副本的调用形态兼容：多数只传 page；个别旧副本传
 * 手机号的调用点已随邮箱化改传/改用返回值）。落点断言保留原副本语义：
 * /workspace 首页 quick-create-blank 可见 → 我的文件视图 3 个种子文件。
 */
export async function registerAndLogin(page: Page, opts?: { nickname?: string }): Promise<WebAccount> {
  const account = await apiRegister(page.request, opts);
  await injectToken(page, account.token);
  await page.goto('/workspace');
  await expect(page.getByTestId('quick-create-blank')).toBeVisible(); // 首页落点（种子文件在「我的文件」视图）
  await page.goto('/workspace?view=files');
  await expect(page.getByTestId('mine-grid').getByTestId('file-card')).toHaveCount(3);
  return account;
}
