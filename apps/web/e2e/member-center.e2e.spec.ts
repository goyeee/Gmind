import { expect, test, type APIRequestContext, type Page } from '@playwright/test';

/**
 * 顶栏成员入口与个人中心 E2E —— 2026-10-11 需求方裁定：协作者头像栏（M6 Task 9，
 * ≤5 枚 chips + 溢出位）退役，顶栏最右改为：
 *   [成员钮 members-btn（MembersIcon + members-count 在线数角标）] → 成员面板
 *   [本人头像 avatar-me（昵称首字符 + 个人色）] → 个人中心下拉
 * 工具栏协作组的旧 members-btn 删除（testid 随按钮迁移，既有用例零改动）；
 * membersFocus 定位管线保留但暂无头像触发入口。
 *
 * 个人中心下拉（最小版）：本人昵称 + 手机号（GET /users/me）、返回工作台、
 * 退出登录（POST /auth/logout + 清 token 回 /login，复用工作台范式）；Esc/外点关闭。
 *
 * 覆盖面：
 * - 单上下文：成员钮角标=1、accessible name「在线成员」；点成员钮开成员面板；
 *   本人头像可见（首字符）；点本人头像开个人中心（昵称/手机号/两菜单项）；Esc 关闭；
 * - 个人中心：返回工作台 → /workspace；退出登录 → token 清除 + /login；
 * - 双上下文：B 经分享链接加入 → A 角标 1→2、成员面板可见 B 行；B 关闭 → 角标回 1；
 * - 多人在线：6 人 → 角标 6 + 成员面板 6 行（头像栏的 ≤5+溢出语义随退役移除）。
 */

/** 注册并登录（UI 全流程），返回所用手机号。 */
async function registerAndLogin(page: Page): Promise<string> {
  await page.goto('/login');
  const phone = '138' + String(Math.floor(10000000 + Math.random() * 89999999));
  await page.getByPlaceholder('手机号').fill(phone);
  await page.getByPlaceholder('验证码（开发环境固定 123456）').fill('123456');
  await page.getByRole('button', { name: '登录', exact: true }).click();
  await expect(page).toHaveURL(/\/workspace/);
  await expect(page.getByTestId('mine-grid').getByTestId('file-card')).toHaveCount(3);
  return phone;
}

/** 经 API 注册/登录（手机验证码首登即注册）并返回 token。 */
async function apiLogin(request: APIRequestContext, phone: string): Promise<string> {
  const res = await request.post('/api/auth/login', { data: { method: 'phone', phone, code: '123456' } });
  expect(res.ok()).toBeTruthy();
  return ((await res.json()) as { token: string }).token;
}

const authHeader = (token: string) => ({ Authorization: `Bearer ${token}` });
const randomPhone = () => '138' + String(Math.floor(10000000 + Math.random() * 89999999));

/** 打开种子文件进入编辑器，等待 root 文本渲染，返回 fileId。 */
async function openSeedDoc(page: Page, title: string): Promise<string> {
  await registerAndLogin(page);
  await page.getByTestId('file-card').filter({ hasText: title }).first().click();
  await expect(page).toHaveURL(/\/edit\//);
  await expect(page.locator('.editor-canvas svg .gm-text', { hasText: title })).toBeVisible();
  const m = /\/edit\/([0-9A-Za-z]+)/.exec(page.url());
  if (!m || !m[1]) throw new Error(`URL 中无 fileId：${page.url()}`);
  return m[1];
}

/** 当前登录用户 id（collab.ts 身份广播同源：GET /api/users/me）。 */
async function userIdOf(page: Page): Promise<string> {
  return page.evaluate(async () => {
    const res = await fetch('/api/users/me', {
      headers: { Authorization: `Bearer ${localStorage.getItem('gmind.token') ?? ''}` },
    });
    const body = (await res.json()) as { id?: string };
    if (!body.id) throw new Error('users/me 无 id');
    return body.id;
  });
}

test('顶栏右缘：成员钮角标与可访问名，点成员钮开成员面板；本人头像开个人中心', async ({ page }) => {
  test.setTimeout(90_000);
  const phone = await registerAndLogin(page);
  await page.getByTestId('file-card').filter({ hasText: '本周计划' }).first().click();
  await expect(page).toHaveURL(/\/edit\//);
  await expect(page.locator('.editor-canvas svg .gm-text', { hasText: '本周计划' })).toBeVisible();
  // 成员钮（顶栏最右，成员面板唯一入口）：在线数角标=1 + 可访问名
  const membersBtn = page.getByTestId('members-btn');
  await expect(membersBtn).toBeVisible();
  await expect(page.getByTestId('members-count')).toHaveText('1', { timeout: 15_000 });
  await expect(membersBtn).toHaveAccessibleName('在线成员');
  // 本人头像：昵称首字符（圆形钮，位于成员钮右侧）
  const avatar = page.getByTestId('avatar-me');
  await expect(avatar).toBeVisible();
  const avatarBox = (await avatar.boundingBox())!;
  const membersBox = (await membersBtn.boundingBox())!;
  expect(avatarBox.x).toBeGreaterThan(membersBox.x);
  // 点成员钮 = 打开成员面板（原 members-btn 行为）
  await membersBtn.click();
  await expect(page.getByTestId('member-panel')).toBeVisible();
  await page.getByTestId('member-panel-close').click();
  // 点本人头像 = 个人中心下拉：昵称/手机号 + 两菜单项；Esc 关闭
  await avatar.click();
  const menu = page.getByTestId('personal-menu');
  await expect(menu).toBeVisible();
  await expect(menu.getByTestId('personal-nickname')).not.toHaveText('');
  await expect(menu.getByTestId('personal-phone')).toHaveText(phone);
  await expect(menu.getByTestId('personal-workspace')).toBeVisible();
  await expect(menu.getByTestId('personal-logout')).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(menu).toHaveCount(0);
});

test('个人中心：返回工作台跳转 /workspace；退出登录清 token 回 /login', async ({ page }) => {
  test.setTimeout(90_000);
  await openSeedDoc(page, '本周计划');
  const avatar = page.getByTestId('avatar-me');
  await expect(avatar).toBeVisible();
  // 返回工作台
  await avatar.click();
  const menu = page.getByTestId('personal-menu');
  await expect(menu).toBeVisible();
  await menu.getByTestId('personal-workspace').click();
  await expect(page).toHaveURL(/\/workspace/);
  // 回编辑器再退出登录（会话作废 + token 清除 + 回登录页）
  await page.getByTestId('file-card').filter({ hasText: '本周计划' }).first().click();
  await expect(page).toHaveURL(/\/edit\//);
  await page.getByTestId('avatar-me').click();
  await page.getByTestId('personal-logout').click();
  await expect(page).toHaveURL(/\/login/);
  const token = await page.evaluate(() => localStorage.getItem('gmind.token'));
  expect(token).toBeNull();
});

test('双上下文：B 加入 → 角标 1→2 且成员面板见 B 行；B 关闭 → 角标回 1', async ({ browser, request }) => {
  test.setTimeout(120_000);
  const contextA = await browser.newContext();
  const pageA = await contextA.newPage();
  const fileId = await openSeedDoc(pageA, '本周计划');
  const aToken = await pageA.evaluate(() => localStorage.getItem('gmind.token') ?? '');
  expect(aToken).not.toBe('');
  const share = await request.post(`/api/files/${fileId}/share`, { headers: authHeader(aToken) });
  expect(share.status()).toBe(201);
  const shareToken = ((await share.json()) as { shareToken: string }).shareToken;

  const contextB = await browser.newContext();
  const pageB = await contextB.newPage();
  await pageB.goto(`/s/${shareToken}`);
  await expect(pageB).toHaveURL(/\/login\?redirect=\/s\//);
  await pageB.getByPlaceholder('手机号').fill(randomPhone());
  await pageB.getByPlaceholder('验证码（开发环境固定 123456）').fill('123456');
  await pageB.getByRole('button', { name: '登录', exact: true }).click();
  await expect(pageB).toHaveURL(new RegExp(`/edit/${fileId}`));
  const bId = await userIdOf(pageB);

  // A 角标 1 → 2（presence 通道，15s 容忍）；点成员钮开面板见 B 行
  await expect(pageA.getByTestId('members-count')).toHaveText('2', { timeout: 15_000 });
  await pageA.getByTestId('members-btn').click();
  const panel = pageA.getByTestId('member-panel');
  await expect(panel).toBeVisible();
  await expect(panel.locator(`[data-member-user="${bId}"]`)).toBeVisible();
  await expect(panel.locator('[data-testid="member-row"]')).toHaveCount(2);
  await pageA.getByTestId('member-panel-close').click();

  // B 关闭 → A 角标回 1（awareness 即时移除路径，10s 容忍）
  await contextB.close();
  await expect(pageA.getByTestId('members-count')).toHaveText('1', { timeout: 10_000 });
  await contextA.close();
});

test('多人在线：6 人角标 6，成员面板 6 行', async ({ browser, request }) => {
  test.setTimeout(150_000);
  const aToken = await apiLogin(request, randomPhone());
  const created = await request.post('/api/files', { data: { title: '成员角标' }, headers: authHeader(aToken) });
  expect(created.status()).toBe(201);
  const fileId = ((await created.json()) as { id: string }).id;
  const openWithToken = async (token: string): Promise<Page> => {
    const ctx = await browser.newContext();
    await ctx.addInitScript((t: string) => localStorage.setItem('gmind.token', t), token);
    const p = await ctx.newPage();
    await p.goto(`/edit/${fileId}`);
    await expect(p.locator('.editor-canvas svg .gm-text', { hasText: '中心主题' })).toBeVisible({
      timeout: 15_000,
    });
    return p;
  };
  const pageA = await openWithToken(aToken);
  for (let i = 0; i < 5; i++) {
    const phone = randomPhone();
    const token = await apiLogin(request, phone);
    const granted = await request.post('/api/dev-e2e/grant-collaborator', { data: { fileId, phone } });
    expect(granted.ok()).toBeTruthy();
    await openWithToken(token);
  }
  // 角标=6（presence 收敛 15s 容忍）；面板 6 行
  await expect(pageA.getByTestId('members-count')).toHaveText('6', { timeout: 15_000 });
  await pageA.getByTestId('members-btn').click();
  const panel = pageA.getByTestId('member-panel');
  await expect(panel).toBeVisible();
  await expect(panel.locator('[data-testid="member-row"]')).toHaveCount(6, { timeout: 15_000 });
});
