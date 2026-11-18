import { expect, test, type APIRequestContext } from '@playwright/test';
import { apiRegister, injectToken, registerAndLogin } from './helpers/auth';

/**
 * 分享链接与落地页 E2E — M3b Task 4（FR-SHR-001）。
 *
 * 全链路：A（owner）工作台行菜单「复制分享链接」（剪贴板 toast）→ B（新账号、未登录）
 * 打开 /s/:token → 跳 /login?redirect= → 造号注入后回落地页 → 自动 join → /edit/:fileId
 * 画布渲染（可编辑入口；登录表单提交腿在 login-page.e2e.spec.ts）→ A 经 API 关闭链接
 * （DELETE /api/files/:id/share，产品暂无关闭入口 UI）→ B 再开落地 URL → 失效页
 * （「链接已失效」+ 返回工作台）。
 *
 * 辅助用例：已登录用户直达 active 链接自动加入；closed/未知 token 未登录访客直达
 * 失效页（服务端统一 closed 响应，前端不走登录跳转、不泄露存在性）。
 */

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

test('全链路：A 复制分享链接 → B（helper 造号注入）回落地页自动加入 → 编辑器；关闭后失效页', async ({ browser, request }) => {
  // —— A：注册登录；文件经 API 创建（中心节点文本自 2026-10-09 裁定起固定「中心主题」，
  //    与文件标题解耦——画布断言按中心主题；工作台行内重命名只改 title 列不回写 doc），
  //    随后刷新列表走 UI 分享入口 ——
  const contextA = await browser.newContext({ permissions: ['clipboard-read', 'clipboard-write'] });
  const pageA = await contextA.newPage();
  const userA = await registerAndLogin(pageA);
  const aToken = userA.token;
  const { fileId, shareToken } = await apiCreateSharedFile(request, aToken, '分享目标文档');
  await pageA.reload();
  const row = pageA.getByTestId('file-card').filter({ hasText: '分享目标文档' }).first();
  await expect(row).toBeVisible();
  await row.hover();
  await row.getByTestId('card-menu-btn').click();
  await pageA.getByTestId('card-menu').getByTestId('share-action').click();
  await expect(pageA.getByTestId('toast')).toHaveText('链接已复制');
  const shareUrl = await pageA.evaluate(() => navigator.clipboard.readText());
  expect(shareUrl).toMatch(/\/s\/[0-9a-f]{32}$/);
  expect(shareUrl).toContain(`/s/${shareToken}`);

  // —— B：新账号（独立 context、未登录）打开链接 → 跳登录（带 redirect）——
  const contextB = await browser.newContext();
  const pageB = await contextB.newPage();
  await pageB.goto(shareUrl);
  await expect(pageB).toHaveURL(/\/login\?redirect=\/s\//);

  // —— B 造号注入 → 落地页自动 join → /edit/:fileId，画布渲染 ——
  // （「登录表单提交→回跳」一腿在 login-page.e2e.spec.ts，任务 7 归位）
  const userB = await apiRegister(pageB.request);
  await injectToken(pageB, userB.token);
  await pageB.goto(shareUrl);
  await expect(pageB).toHaveURL(new RegExp(`/edit/${fileId}`));
  await expect(pageB.locator('.editor-canvas svg .gm-text', { hasText: '中心主题' })).toBeVisible();

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
  const aToken = (await apiRegister(request)).token;
  const { fileId, shareToken } = await apiCreateSharedFile(request, aToken, '登录态直达文档');

  const context = await browser.newContext();
  const page = await context.newPage();
  await registerAndLogin(page);
  await page.goto(`/s/${shareToken}`);
  await expect(page).toHaveURL(new RegExp(`/edit/${fileId}`));
  await expect(page.locator('.editor-canvas svg .gm-text', { hasText: '中心主题' })).toBeVisible();
  await context.close();
});

test('密码链接：登录后先验证密码，错误可重试，正确后进入编辑器', async ({ page, request }) => {
  const owner = await apiRegister(request);
  const created = await request.post('/api/files', { data: { title: '密码分享文档' }, headers: authHeader(owner.token) });
  const fileId = ((await created.json()) as { id: string }).id;
  const share = await request.post(`/api/files/${fileId}/share`, { data: { passwordEnabled: true }, headers: authHeader(owner.token) });
  const shareToken = ((await share.json()) as { shareToken: string }).shareToken;
  const described = await request.get(`/api/files/${fileId}/share`, { headers: authHeader(owner.token) });
  const password = ((await described.json()) as { password: string }).password;
  const wrongPassword = String((Number(password) + 1) % 10000).padStart(4, '0');

  await registerAndLogin(page);
  await page.goto(`/s/${shareToken}`);
  await expect(page.getByTestId('share-password')).toBeVisible();
  await page.getByTestId('share-password-input').fill(wrongPassword);
  await page.getByTestId('share-password-submit').click();
  await expect(page.getByTestId('share-password-error')).toHaveText('访问密码错误，请重新输入');
  await page.getByTestId('share-password-input').fill(password);
  await page.getByTestId('share-password-submit').click();
  await expect(page).toHaveURL(new RegExp(`/edit/${fileId}`));
  await expect(page.locator('.editor-canvas svg .gm-text', { hasText: '中心主题' })).toBeVisible();
});

test('过期链接显示过期原因和联系创建者的下一步', async ({ page }) => {
  const token = 'ab'.repeat(16);
  await page.route(`**/api/share/${token}`, (route) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ status: 'expired' }) }));
  await page.goto(`/s/${token}`);
  await expect(page.getByTestId('share-invalid')).toContainText('链接已过期，请联系文件创建者重新分享');
});

test('closed/未知 token：未登录访客直达失效页（不走登录跳转）', async ({ browser, request }) => {
  const aToken = (await apiRegister(request)).token;
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
