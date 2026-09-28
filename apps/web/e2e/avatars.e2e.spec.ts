import { expect, test, type APIRequestContext, type Page } from '@playwright/test';

/**
 * 顶栏协作者头像栏 E2E — M6 Task 9（企微对标）。
 *
 * 数据面与 MemberPanel 同源（collab onPresence → members state）：头像栏是同一
 * presence 通道的展示派生，不建第二获取通道。会话内已见成员缓存支撑「离线=灰」
 * ——presence 只含在线者，B 关页后 A 侧 B 的头像不消失、转为灰态（awareness
 * removeAwarenessStates 即时移除路径同 collab.e2e 用例 5/6，断言给 10s 容忍）。
 *
 * 覆盖面：
 * - 单上下文：自身 1 枚在线头像（首字符回退 + 在线类名）；点击头像打开成员面板；
 *   移动端只读分支不装配头像栏（桌面工具栏专属），回桌面视口自身头像回归；
 * - 双上下文（share.e2e 分享链接 API 编排）：B 经 /s/:token 登录回跳自动加入 →
 *   A 头像栏出现 B 在线头像；B 关闭 context → A 侧 B 头像转离线灰（仍展示）；
 * - 溢出：6 人在线 → ≤5 枚头像 + 「+1」溢出位（第 6 位折叠），点击溢出位同样
 *   打开成员面板（B~F 经 dev-e2e grant-collaborator 授权 + token 直开 /edit）。
 */

/** 注册并登录（UI 全流程），返回所用手机号。 */
async function registerAndLogin(page: Page): Promise<string> {
  await page.goto('/login');
  const phone = '138' + String(Math.floor(10000000 + Math.random() * 89999999));
  await page.getByPlaceholder('手机号').fill(phone);
  await page.getByPlaceholder('验证码（开发环境固定 123456）').fill('123456');
  await page.getByRole('button', { name: '登录', exact: true }).click();
  await expect(page).toHaveURL(/\/workspace/);
  await expect(page.locator('.file-list li')).toHaveCount(3);
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
  await page.locator('.file-list li', { hasText: title }).click();
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

test('单上下文：自身 1 枚在线头像，点击打开成员面板；移动端只读不装配', async ({ page }) => {
  test.setTimeout(90_000);
  await openSeedDoc(page, '本周计划');
  const myId = await userIdOf(page);
  // 仅自己：头像栏恰 1 枚，自身头像在线态（presence 身份装配后出现）
  const own = page.getByTestId(`avatar-${myId}`);
  await expect(own).toBeVisible({ timeout: 15_000 });
  await expect(own).toHaveClass(/online/);
  await expect(page.getByTestId('avatar-bar').locator('.avatar-chip')).toHaveCount(1);
  // 点击头像 = 打开成员面板（既有 members-btn 面板）
  await own.click();
  await expect(page.getByTestId('member-panel')).toBeVisible();
  await page.getByTestId('member-panel-close').click();
  // 移动端只读分支（≤768px）：头像栏随桌面工具栏整体不装配（React 分支断言）
  await page.setViewportSize({ width: 375, height: 667 });
  await expect(page.getByTestId('avatar-bar')).toHaveCount(0);
  // 回桌面视口：断点跨越重建后自身头像回归
  await page.setViewportSize({ width: 1280, height: 720 });
  await expect(page.getByTestId(`avatar-${myId}`)).toBeVisible({ timeout: 15_000 });
});

test('双上下文：B 经分享链接加入 → A 头像栏见 B 在线；B 关闭 → B 头像转离线灰', async ({ browser, request }) => {
  test.setTimeout(120_000);
  // —— A（owner）：开种子文档 + 建分享链接（share.e2e 同款 API 编排；token 取页面
  //    登录态，避免二次注册换号导致 owner 不一致）——
  const contextA = await browser.newContext();
  const pageA = await contextA.newPage();
  const fileId = await openSeedDoc(pageA, '本周计划');
  const aId = await userIdOf(pageA);
  const aToken = await pageA.evaluate(() => localStorage.getItem('gmind.token') ?? '');
  expect(aToken).not.toBe('');
  const share = await request.post(`/api/files/${fileId}/share`, { headers: authHeader(aToken) });
  expect(share.status()).toBe(201);
  const shareToken = ((await share.json()) as { shareToken: string }).shareToken;

  // —— B：新账号（独立 context、未登录）开链接 → 登录回跳 → 自动 join → /edit ——
  const contextB = await browser.newContext();
  const pageB = await contextB.newPage();
  await pageB.goto(`/s/${shareToken}`);
  await expect(pageB).toHaveURL(/\/login\?redirect=\/s\//);
  await pageB.getByPlaceholder('手机号').fill(randomPhone());
  await pageB.getByPlaceholder('验证码（开发环境固定 123456）').fill('123456');
  await pageB.getByRole('button', { name: '登录', exact: true }).click();
  await expect(pageB).toHaveURL(new RegExp(`/edit/${fileId}`));
  await expect(pageB.locator('.editor-canvas svg .gm-text', { hasText: '本周计划' })).toBeVisible();
  const bId = await userIdOf(pageB);

  // —— A 头像栏：自身 + B 两枚，B 在线态 ——
  await expect(pageA.getByTestId(`avatar-${aId}`)).toBeVisible({ timeout: 15_000 });
  const bAvatar = pageA.getByTestId(`avatar-${bId}`);
  await expect(bAvatar).toBeVisible({ timeout: 15_000 });
  await expect(bAvatar).toHaveClass(/online/, { timeout: 10_000 });
  await expect(pageA.getByTestId('avatar-bar').locator('.avatar-chip')).toHaveCount(2);

  // —— B 关闭 → A 侧 B 头像转离线灰（会话内记住成员，不移除；awareness 即时移除
  //    路径同 collab.e2e 用例 5/6，10s 容忍）——
  await contextB.close();
  await expect(bAvatar).toHaveClass(/offline/, { timeout: 10_000 });
  await expect(bAvatar).not.toHaveClass(/online/);
  await expect(pageA.getByTestId('avatar-bar').locator('.avatar-chip')).toHaveCount(2);
  await contextA.close();
});

test('溢出：6 人在线 → ≤5 枚头像 +「+1」溢出位，点击溢出位打开成员面板', async ({ browser, request }) => {
  test.setTimeout(150_000);
  // —— A 经 API 建号建文件，token 直开 /edit（owner）——
  const aToken = await apiLogin(request, randomPhone());
  const created = await request.post('/api/files', { data: { title: '头像栏溢出' }, headers: authHeader(aToken) });
  expect(created.status()).toBe(201);
  const fileId = ((await created.json()) as { id: string }).id;
  const openWithToken = async (token: string): Promise<Page> => {
    const ctx = await browser.newContext();
    await ctx.addInitScript((t: string) => localStorage.setItem('gmind.token', t), token);
    const p = await ctx.newPage();
    await p.goto(`/edit/${fileId}`);
    await expect(p.locator('.editor-canvas svg .gm-text', { hasText: '头像栏溢出' })).toBeVisible({
      timeout: 15_000,
    });
    return p;
  };
  const pageA = await openWithToken(aToken);
  const aId = await userIdOf(pageA);

  // —— B~F 五位协作者：dev-e2e 授权（collab.e2e 同款）+ token 直开 ——
  let lastId = '';
  for (let i = 0; i < 5; i++) {
    const phone = randomPhone();
    const token = await apiLogin(request, phone);
    const granted = await request.post('/api/dev-e2e/grant-collaborator', { data: { fileId, phone } });
    expect(granted.ok()).toBeTruthy();
    const p = await openWithToken(token);
    lastId = await userIdOf(p);
  }

  // —— A 头像栏：恰 5 枚头像（首见序 A..E），第 6 位（F，最后加入）折叠为 +1 ——
  await expect(pageA.getByTestId('avatar-bar').locator('.avatar-chip')).toHaveCount(5, {
    timeout: 15_000,
  });
  await expect(pageA.getByTestId('avatar-overflow')).toHaveText('+1', { timeout: 15_000 });
  await expect(pageA.getByTestId(`avatar-${aId}`)).toBeVisible();
  await expect(pageA.getByTestId(`avatar-${lastId}`)).toHaveCount(0);
  // 点击溢出位 = 打开成员面板（全部 6 人在线）
  await pageA.getByTestId('avatar-overflow').click();
  await expect(pageA.getByTestId('member-panel')).toBeVisible();
  await expect(pageA.getByTestId('members-count')).toHaveText('6');
});
