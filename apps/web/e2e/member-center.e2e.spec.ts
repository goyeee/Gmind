import { expect, test, type Page } from '@playwright/test';
import { apiRegister, injectToken, registerAndLogin } from './helpers/auth';

/**
 * 顶栏成员入口 E2E —— 2026-10-11 需求方裁定：协作者头像栏（M6 Task 9）退役，
 * 顶栏最右 = 成员钮 members-btn（头像堆 + members-count 在线数角标）→ 成员面板。
 * 2026-11-16 需求方裁定：本人头像 avatar-me 与个人中心下拉**整体删除**——账号
 * 设置/退出登录由工作台侧栏用户卡（user-card → user-menu）承接，见 workspace.e2e。
 *
 * 覆盖面：
 * - 单上下文：成员钮角标=1、accessible name「在线成员」；点成员钮开成员面板；
 *   avatar-me / personal-menu 不再渲染；
 * - 双上下文：B 经分享链接加入 → A 角标 1→2、成员面板可见 B 行；B 关闭 → 角标回 1；
 * - 多人在线：6 人 → 角标 6 + 成员面板 6 行。
 */

const authHeader = (token: string) => ({ Authorization: `Bearer ${token}` });

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

test('顶栏右缘：成员钮角标与可访问名，点成员钮开成员面板；本人头像入口已删除', async ({ page }) => {
  test.setTimeout(90_000);
  await registerAndLogin(page);
  await page.getByTestId('file-card').filter({ hasText: '本周计划' }).first().click();
  await expect(page).toHaveURL(/\/edit\//);
  await expect(page.locator('.editor-canvas svg .gm-text', { hasText: '本周计划' })).toBeVisible();
  // 成员钮（顶栏最右，成员面板唯一入口）：在线数角标=1 + 可访问名
  const membersBtn = page.getByTestId('members-btn');
  await expect(membersBtn).toBeVisible();
  await expect(page.getByTestId('members-count')).toHaveText('1', { timeout: 15_000 });
  await expect(membersBtn).toHaveAccessibleName('在线成员');
  // 2026-11-16 裁定：本人头像与个人中心下拉整体删除
  await expect(page.getByTestId('avatar-me')).toHaveCount(0);
  await expect(page.getByTestId('personal-menu')).toHaveCount(0);
  // 点成员钮 = 打开成员面板
  await membersBtn.click();
  await expect(page.getByTestId('member-panel')).toBeVisible();
  await page.getByTestId('member-panel-close').click();
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
  // B 经 helper 造号注入后回落地页完成加入；「登录表单提交→回跳」一腿在
  // login-page.e2e.spec.ts（任务 7 归位）
  const userB = await apiRegister(pageB.request);
  await injectToken(pageB, userB.token);
  await pageB.goto(`/s/${shareToken}`);
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
  const userA = await apiRegister(request);
  const created = await request.post('/api/files', { data: { title: '成员角标' }, headers: authHeader(userA.token) });
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
  const pageA = await openWithToken(userA.token);
  for (let i = 0; i < 5; i++) {
    const collaborator = await apiRegister(request);
    const granted = await request.post('/api/dev-e2e/grant-collaborator', { data: { fileId, email: collaborator.email } });
    expect(granted.ok()).toBeTruthy();
    await openWithToken(collaborator.token);
  }
  // 角标=6（presence 收敛 15s 容忍）；面板 6 行
  await expect(pageA.getByTestId('members-count')).toHaveText('6', { timeout: 15_000 });
  await pageA.getByTestId('members-btn').click();
  const panel = pageA.getByTestId('member-panel');
  await expect(panel).toBeVisible();
  await expect(panel.locator('[data-testid="member-row"]')).toHaveCount(6, { timeout: 15_000 });
});
