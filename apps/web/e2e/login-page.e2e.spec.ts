import { expect, test, type Page } from '@playwright/test';
import { apiRegister, E2E_DOMAIN, injectToken } from './helpers/auth';

/**
 * 登录页三视图 UI E2E（2026-11-12 账号体系重做，spec §4.4 / plan Task 7 Step 4）。
 *
 * LoginPage 已重做为 `login|register|forgot` 状态机（旧手机/微信通道删除），本文件
 * 是唯一走「UI 表单提交」登录/注册旅程的 spec（其余 39 份经 helpers/auth 造号注入），
 * 同时补回任务 6 从 share/member-center 移出的「登录表单提交→redirect 回跳」一腿。
 *
 * 覆盖面：
 * ① 注册旅程：UI 收码填表（60s 倒计时禁用）→ 落工作台 → 3 个示例文件可见；
 * ② 登录失败文案：账号不存在 / 密码错误（服务端两段式原文）；
 * ③ 记住我：勾选登录后刷新仍登录（前端 token 持久化；服务端 7/30 天 TTL 在 server e2e）；
 * ④ 忘记密码：重置成功回登录视图带提示 → 新密码登录成功；
 * ⑤ 登录表单提交 → /login?redirect=/s/:token 回跳落地页自动加入（share 全链路的登录腿）；
 * ⑥ 无密码账号：设置页引导文案+禁用表单（me.hasPassword=false 渲染分支）；
 *    管理员建号的登录死路文案（需超管，任务 8 seed-demo 后解除 skip）。
 */

const uniqueEmail = (): string => `e2e-login-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}@${E2E_DOMAIN}`;

/** UI 登录表单提交（login 视图 testid 驱动）；expectURL=true 时断言落到 redirect/workspace。 */
async function uiLogin(page: Page, account: string, password: string): Promise<void> {
  await page.getByTestId('login-account').fill(account);
  await page.getByTestId('login-password').fill(password);
  await page.getByTestId('login-submit').click();
}

// ① 注册旅程（注册即登录，注册即赠 3 个示例文件——语义同 helpers/auth.ts 注记）
test('注册旅程：UI 收码填表 → 落工作台 → 3 个示例文件可见（发码钮 60s 倒计时禁用）', async ({ page }) => {
  const email = uniqueEmail();
  await page.goto('/login');
  await page.getByTestId('link-register').click();
  await expect(page.getByTestId('register-view')).toBeVisible();

  await page.getByTestId('reg-email').fill(email);
  await page.getByTestId('reg-code-send').click();
  // 发码成功 → 60s 倒计时禁用（服务端重发冷却同源；文本随秒递减，断言「后重发」形态）
  const sendBtn = page.getByTestId('reg-code-send');
  await expect(sendBtn).toBeDisabled();
  await expect(sendBtn).toContainText('后重发');

  await page.getByTestId('reg-code').fill('123456'); // dev/test 验证码恒 DEV_MAIL_CODE（默认 123456）
  await page.getByTestId('reg-password').fill('pass123456');
  await page.getByTestId('reg-nickname').fill('登录页用户');
  await page.getByTestId('reg-submit').click();
  await expect(page).toHaveURL(/\/workspace/);
  await expect(page.getByTestId('quick-create-blank')).toBeVisible();
  await page.goto('/workspace?view=files');
  await expect(page.getByTestId('mine-grid').getByTestId('file-card')).toHaveCount(3);
});

// ② 登录失败：服务端两段式文案原文透出（NFR-USE-005）
test('登录失败文案：账号不存在 / 密码错误（服务端两段式原文）', async ({ page }) => {
  const account = await apiRegister(page.request);
  await page.goto('/login');

  // 账号不存在 → 401「账号不存在，请先注册」
  await uiLogin(page, uniqueEmail(), account.password);
  const error = page.locator('.error');
  await expect(error).toContainText('账号不存在，请先注册');
  await expect(page).toHaveURL(/\/login/);

  // 密码错误 → 401「密码错误，请重新输入或找回密码」
  await uiLogin(page, account.email, 'wrong-pass-9');
  await expect(error).toContainText('密码错误，请重新输入或找回密码');
  await expect(page).toHaveURL(/\/login/);
});

// ③ 记住我：勾选 → 登录 → 刷新仍登录（token 持久化；TTL 差异由 server auth e2e 钉）
test('记住我：勾选登录后刷新仍登录（token 持久化）', async ({ page }) => {
  const account = await apiRegister(page.request);
  await page.goto('/login');
  await page.getByTestId('login-remember').check();
  await uiLogin(page, account.email, account.password);
  await expect(page).toHaveURL(/\/workspace/);
  await expect(page.getByTestId('quick-create-blank')).toBeVisible();

  await page.reload();
  await expect(page).toHaveURL(/\/workspace/);
  await expect(page.getByTestId('quick-create-blank')).toBeVisible();
  // token 仍在（UI 登录签发的新会话，非 apiRegister 的造号 token，故只断非空）
  const token = await page.evaluate(() => localStorage.getItem('gmind.token'));
  expect(token).not.toBeNull();
  expect((token ?? '').length).toBeGreaterThan(0);
});

// ④ 忘记密码：重置成功 → 回登录视图带提示 → 新密码登录成功
test('忘记密码 → 回登录视图带提示，新密码登录成功', async ({ page }) => {
  const account = await apiRegister(page.request); // 旧密码 pass123456
  await page.goto('/login');
  await page.getByTestId('link-forgot').click();
  await expect(page.getByTestId('forgot-view')).toBeVisible();

  await page.getByTestId('forgot-email').fill(account.email);
  await page.getByTestId('forgot-code-send').click();
  await expect(page.getByTestId('forgot-code-send')).toBeDisabled(); // 60s 倒计时
  await page.getByTestId('forgot-code').fill('123456');
  await page.getByTestId('forgot-password').fill('newpass654321');
  await page.getByTestId('forgot-submit').click();

  // 回登录视图 + 结果提示（两段式：结果 + 下一步），旧密码已失效
  await expect(page.getByTestId('login-view')).toBeVisible();
  await expect(page.getByTestId('login-notice')).toHaveText('密码已重置，请使用新密码登录');
  await uiLogin(page, account.email, account.password);
  await expect(page.locator('.error')).toContainText('密码错误，请重新输入或找回密码');

  await uiLogin(page, account.email, 'newpass654321');
  await expect(page).toHaveURL(/\/workspace/);
  await expect(page.getByTestId('quick-create-blank')).toBeVisible();
});

// ⑤ 登录表单提交 → redirect 回跳（share/member-center 移出的「登录腿」归位于此）：
//    未登录打开 /s/:token → /login?redirect=/s/:token → 登录成功 → 回落地页自动加入。
test('登录表单提交 → 回跳 /s/:token 落地页自动加入', async ({ browser, request }) => {
  const owner = await apiRegister(request);
  const created = await request.post('/api/files', {
    data: { title: '登录回跳落地页' },
    headers: { Authorization: `Bearer ${owner.token}` },
  });
  expect(created.status()).toBe(201);
  const fileId = ((await created.json()) as { id: string }).id;
  const share = await request.post(`/api/files/${fileId}/share`, {
    headers: { Authorization: `Bearer ${owner.token}` },
  });
  expect(share.status()).toBe(201);
  const shareToken = ((await share.json()) as { shareToken: string }).shareToken;

  // B：新 context 未登录打开落地页 → 跳登录（带 redirect）
  const contextB = await browser.newContext();
  const pageB = await contextB.newPage();
  await pageB.goto(`/s/${shareToken}`);
  await expect(pageB).toHaveURL(new RegExp(`/login\\?redirect=/s/${shareToken}`));

  // B 以已注册账号走 UI 登录表单 → 回落地页自动加入 → /edit/:fileId 画布渲染
  const userB = await apiRegister(pageB.request);
  await uiLogin(pageB, userB.email, userB.password);
  await expect(pageB).toHaveURL(new RegExp(`/s/${shareToken}`));
  await expect(pageB).toHaveURL(new RegExp(`/edit/${fileId}`));
  await expect(pageB.locator('.editor-canvas svg .gm-text', { hasText: '中心主题' })).toBeVisible();
  await contextB.close();
});

// ⑥a 无密码账号设置页形态：me.hasPassword=false → 引导文案 + 禁用表单。
//     造号通道说明：邮箱注册必有密码，无密码形态仅管理员建号可得——真实账号链路
//     需超管（任务 8 seed-demo 后解 skip），此处以 me 响应 fixture 钉 UI 渲染分支。
test('无密码账号设置页：引导文案 + 表单禁用（hasPassword=false 渲染分支）', async ({ page }) => {
  // me 与通知偏好都需 mock（SettingsPage 的 reload 是 Promise.all，任一真实 401 会
  // 整体拒绝 → me 不落状态）
  const fixtureUser = {
    id: '01ARZ3NDEKTSV4RRFFQ69G5FAV',
    nickname: '管理员建号成员',
    phone: null,
    email: 'nopassword@gmind.dev',
    hasPassword: false,
    avatarUrl: null,
    systemRole: 'member',
  };
  await page.route('**/api/users/me', (route) =>
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(fixtureUser) }),
  );
  await page.route('**/api/users/me/notify-prefs', (route) =>
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ emailOptOut: [] }) }),
  );
  await injectToken(page, 'fixture-token-for-nopassword-view');
  await page.goto('/settings');
  await expect(page.getByTestId('password-section')).toBeVisible();
  const guide = page.getByTestId('password-guide');
  await expect(guide).toHaveText('尚未设置密码，请通过登录页"忘记密码"用邮箱验证码设置');
  await expect(page.getByTestId('password-current')).toBeDisabled();
  await expect(page.getByTestId('password-new')).toBeDisabled();
  await expect(page.getByTestId('settings-save')).toBeDisabled();
});

// ⑥b 管理员建号（无密码）登录死路：密码闸先于停用闸 →「密码错误，请重新输入或找回密码」。
//     依赖超管 demo@gmind.dev（任务 8 seed-demo 落地），完成前 skip（计划内中间态）。
test('管理员建号（无密码）登录死路文案', async ({ page }) => {
  const login = await page.request.post('/api/auth/login', {
    data: { account: 'demo@gmind.dev', password: 'demo123456' },
  });
  if (!login.ok()) {
    test.skip(true, '库内无演示超管 demo@gmind.dev，任务 8 seed-demo 后重跑');
    return;
  }
  const adminToken = ((await login.json()) as { token: string }).token;
  const nopassEmail = uniqueEmail();
  const created = await page.request.post('/api/admin/users', {
    headers: { Authorization: `Bearer ${adminToken}` },
    data: { email: nopassEmail, nickname: '无密码成员' },
  });
  expect(created.status()).toBe(201);

  await page.goto('/login');
  await uiLogin(page, nopassEmail, 'pass123456');
  await expect(page.locator('.error')).toContainText('密码错误，请重新输入或找回密码');
  await expect(page).toHaveURL(/\/login/);
});
