import { expect, test, type APIRequestContext, type Page } from '@playwright/test';

/**
 * 分享链接与落地页 E2E — M3b Task 4（FR-SHR-001）。
 *
 * 全链路：A（owner）工作台行菜单「复制分享链接」（剪贴板 toast）→ B（新账号、未登录）
 * 打开 /s/:token → 跳 /login?redirect= → 登录回跳落地页 → 自动 join → /edit/:fileId
 * 画布渲染（可编辑入口）→ A 经 API 关闭链接（DELETE /api/files/:id/share，产品暂无
 * 关闭入口 UI）→ B 再开落地 URL → 失效页（「链接已失效」+ 返回工作台）。
 *
 * 辅助用例：已登录用户直达 active 链接自动加入；closed/未知 token 未登录访客直达
 * 失效页（服务端统一 closed 响应，前端不走登录跳转、不泄露存在性）。
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

/** 经 API 以 A 的身份建文件 → 建 active 分享链接，返回 { fileId, shareToken }。 */
async function apiCreateSharedFile(
  request: APIRequestContext,
  token: string,
  title: string,
): Promise<{ fileId: string; shareToken: string }> {
  const created = await request.post('/api/files', { data: { title }, headers: authHeader(token) });
  expect(created.status()).toBe(201);
  const fileId = ((await created.json()) as { id: string }).id;
  const share = await request.post(`/api/files/${fileId}/share`, { headers: authHeader(token) });
  expect(share.status()).toBe(201);
  return { fileId, shareToken: ((await share.json()) as { shareToken: string }).shareToken };
}

/** 随机手机号。 */
const randomPhone = () => '138' + String(Math.floor(10000000 + Math.random() * 89999999));

test('全链路：A 复制分享链接 → B 登录回跳自动加入 → 编辑器；关闭后失效页', async ({ browser, request }) => {
  // —— A：注册登录；文件经 API 创建（标题与画布 root 文本一致；工作台行内重命名只改
  //    title 列不回写 doc，画布标题口径以创建时为准），随后刷新列表走 UI 分享入口 ——
  const contextA = await browser.newContext({ permissions: ['clipboard-read', 'clipboard-write'] });
  const pageA = await contextA.newPage();
  const aPhone = await registerAndLogin(pageA);
  const aToken = await apiLogin(request, aPhone);
  const { fileId, shareToken } = await apiCreateSharedFile(request, aToken, '分享目标文档');
  await pageA.reload();
  const row = pageA.locator('.file-list li', { hasText: '分享目标文档' });
  await expect(row).toBeVisible();
  await row.getByTestId('row-menu').click();
  await pageA.getByTestId('row-menu-popup').getByTestId('share-action').click();
  await expect(pageA.getByTestId('toast')).toHaveText('链接已复制');
  const shareUrl = await pageA.evaluate(() => navigator.clipboard.readText());
  expect(shareUrl).toMatch(/\/s\/[0-9a-f]{32}$/);
  expect(shareUrl).toContain(`/s/${shareToken}`);

  // —— B：新账号（独立 context、未登录）打开链接 → 跳登录（带 redirect）——
  const contextB = await browser.newContext();
  const pageB = await contextB.newPage();
  await pageB.goto(shareUrl);
  await expect(pageB).toHaveURL(/\/login\?redirect=\/s\//);

  // —— B 登录 → 回跳落地页 → 自动 join → /edit/:fileId，画布渲染 ——
  await pageB.getByPlaceholder('手机号').fill(randomPhone());
  await pageB.getByPlaceholder('验证码（开发环境固定 123456）').fill('123456');
  await pageB.getByRole('button', { name: '登录', exact: true }).click();
  await expect(pageB).toHaveURL(new RegExp(`/edit/${fileId}`));
  await expect(pageB.locator('.editor-canvas svg .gm-text', { hasText: '分享目标文档' })).toBeVisible();

  // —— A 关闭链接（产品暂无关闭入口 UI，经 API 编排）——
  const closed = await request.delete(`/api/files/${fileId}/share`, { headers: authHeader(aToken) });
  expect(closed.ok()).toBeTruthy();

  // —— B 再开落地 URL → 失效页 → 返回工作台 ——
  await pageB.goto(shareUrl);
  const invalid = pageB.getByTestId('share-invalid');
  await expect(invalid).toBeVisible();
  await expect(invalid).toContainText('链接已失效');
  await invalid.getByRole('button', { name: '返回工作台' }).click();
  await expect(pageB).toHaveURL(/\/workspace/);

  await contextA.close();
  await contextB.close();
});

test('已登录用户打开 active 链接：自动加入并进入编辑器（画布渲染）', async ({ browser, request }) => {
  const aToken = await apiLogin(request, randomPhone());
  const { fileId, shareToken } = await apiCreateSharedFile(request, aToken, '登录态直达文档');

  const context = await browser.newContext();
  const page = await context.newPage();
  await registerAndLogin(page);
  await page.goto(`/s/${shareToken}`);
  await expect(page).toHaveURL(new RegExp(`/edit/${fileId}`));
  await expect(page.locator('.editor-canvas svg .gm-text', { hasText: '登录态直达文档' })).toBeVisible();
  await context.close();
});

test('closed/未知 token：未登录访客直达失效页（不走登录跳转）', async ({ browser, request }) => {
  const aToken = await apiLogin(request, randomPhone());
  const { fileId, shareToken } = await apiCreateSharedFile(request, aToken, '已关闭文档');
  const closed = await request.delete(`/api/files/${fileId}/share`, { headers: authHeader(aToken) });
  expect(closed.ok()).toBeTruthy();

  const context = await browser.newContext();
  const page = await context.newPage();
  await page.goto(`/s/${shareToken}`);
  const invalid = page.getByTestId('share-invalid');
  await expect(invalid).toBeVisible();
  await expect(invalid).toContainText('链接已失效');

  // 未知 token 同样失效页（统一 closed 口径）
  await page.goto(`/s/${'ff'.repeat(16)}`);
  await expect(page.getByTestId('share-invalid')).toBeVisible();
  await context.close();
});
