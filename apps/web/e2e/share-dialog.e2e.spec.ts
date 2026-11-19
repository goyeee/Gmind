import { expect, test, type Page } from '@playwright/test';
import { apiRegister, injectToken, registerAndLogin } from './helpers/auth';

const authHeader = (token: string) => ({ Authorization: `Bearer ${token}` });

async function openSeed(page: Page): Promise<void> {
  await registerAndLogin(page);
  await page.getByTestId('file-card').filter({ hasText: '本周计划' }).first().click();
  await expect(page).toHaveURL(/\/edit\//);
  await expect(page.locator('.editor-canvas svg .gm-text', { hasText: '本周计划' })).toBeVisible();
}

test('创建者分享默认邀请；成员直达、空态、固定高度、Escape 与焦点归还', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await openSeed(page);
  await page.getByTestId('share-btn').click();
  await expect(page.getByTestId('share-tab-invite')).toHaveAttribute('aria-selected', 'true');
  const dialog = page.getByTestId('share-dialog');
  await expect(dialog.getByRole('tab')).toHaveText(['协作成员 1', '邀请协作', '链接分享', '导出']);
  const box = await dialog.locator('[role="dialog"]').boundingBox();
  expect(box?.width).toBe(580);
  expect(box?.height).toBe(580);
  await page.keyboard.press('Escape');
  await expect(page.getByTestId('share-dialog')).toHaveCount(0);
  await expect(page.getByTestId('share-btn')).toBeFocused();

  await page.getByTestId('members-btn').click();
  await expect(page.getByTestId('share-tab-members')).toHaveAttribute('aria-selected', 'true');
  await expect(page.getByTestId('member-row')).toHaveCount(1);
  await expect(page.getByTestId('member-group-all')).toContainText('还没有邀请其他人');
  await expect(page.getByTestId('member-online-count')).toContainText('共 1 人');
  await page.getByTestId('share-tab-link').click();
  await page.keyboard.press('Escape');
  await expect(page.getByTestId('members-btn')).toBeFocused();
});

test('真实可邀请成员前5、逐项角色、邀请后回成员并可改角色', async ({ page, request }) => {
  const invited = await apiRegister(request);
  const invitedMe = await request.get('/api/users/me', { headers: authHeader(invited.token) });
  const invitedId = ((await invitedMe.json()) as { id: string }).id;
  await openSeed(page);
  await page.getByTestId('share-btn').click();
  const dialog = page.getByTestId('share-dialog');
  await expect(dialog.getByText('可邀请成员', { exact: true })).toBeVisible();
  const inputBox = await dialog.getByTestId('invite-user-search').boundingBox();
  const dialogBox = await dialog.locator('[role="dialog"]').boundingBox();
  expect(inputBox!.width).toBeLessThanOrEqual(dialogBox!.width - 40);
  const recommendedCount = await dialog.getByTestId('invite-recommended-row').count();
  expect(recommendedCount).toBeGreaterThan(0);
  expect(recommendedCount).toBeLessThanOrEqual(5);
  await dialog.getByTestId('invite-recommended-add').first().click();
  await expect(dialog.getByTestId('invite-pending-row')).toHaveCount(1);
  const recommendedName = await dialog.getByTestId('invite-pending-row').locator('.member-invite-name').boundingBox();
  expect(recommendedName!.width).toBeGreaterThan(40);
  await dialog.locator('.member-invite-remove').click();
  await dialog.getByTestId('invite-user-search').fill(invited.email);
  await dialog.getByTestId('invite-user-row').filter({ hasText: invited.nickname }).click();
  await expect(dialog.getByTestId('invite-pending-row')).toContainText(invited.nickname);
  const pendingName = await dialog.getByTestId('invite-pending-row').locator('.member-invite-name').boundingBox();
  expect(pendingName!.width).toBeGreaterThan(40);
  await dialog.getByTestId('invite-pending-role').selectOption('viewer');
  await dialog.getByTestId('invite-pull-submit').click();
  await expect(dialog.getByTestId('share-tab-members')).toHaveAttribute('aria-selected', 'true');
  const row = dialog.getByTestId('member-row').filter({ hasText: invited.nickname });
  await expect(row).toBeVisible();
  await expect(row.getByTestId('member-role-select')).toHaveValue('viewer');
  await row.getByTestId('member-role-select').selectOption('commenter');
  await expect(row.getByTestId('member-role-select')).toHaveValue('commenter');
  await expect(page.getByTestId('members-count')).toHaveText('2');

  const fileId = /\/edit\/([^/]+)/.exec(page.url())?.[1] ?? '';
  const token = await page.evaluate(() => localStorage.getItem('gmind.token') ?? '');
  const list = await request.get(`/api/files/${fileId}/collaborators`, { headers: authHeader(token) });
  expect((await list.json() as Array<{ userId: string; role: string }>).find((r) => r.userId === invitedId)?.role).toBe('commenter');

  const [deleteResponse] = await Promise.all([
    page.waitForResponse((res) => res.request().method() === 'DELETE' && res.url().includes(`/api/files/${fileId}/collaborators/`)),
    row.getByTestId('member-remove-btn').click(),
  ]);
  expect(deleteResponse.status()).toBe(204);
  await expect.poll(async () => {
    const res = await request.get(`/api/files/${fileId}/collaborators`, { headers: authHeader(token) });
    return (await res.json() as Array<{ userId: string }>).some((r) => r.userId === invitedId);
  }).toBe(false);
  await expect(dialog.getByTestId('member-row').filter({ hasText: invited.nickname })).toHaveCount(0);
  await expect(page.getByTestId('members-count')).toHaveText('1');
});

test('链接页支持三档权限、有效期、4位密码和关闭后重开', async ({ page }) => {
  await openSeed(page);
  await page.getByTestId('share-btn').click();
  const dialog = page.getByTestId('share-dialog');
  await dialog.getByTestId('share-tab-link').click();
  await expect(dialog).toContainText('登录后即可访问');
  await dialog.getByTestId('share-link-toggle').click();
  await expect(dialog.getByTestId('share-link-role')).toHaveValue('viewer');
  await dialog.getByTestId('share-link-role').selectOption('commenter');
  await dialog.getByTestId('share-link-expiry').selectOption('30');
  await dialog.getByTestId('share-link-password-toggle').click();
  await expect(dialog.getByTestId('share-link-password')).toHaveText(/^\d{4}$/);
  const oldUrl = await dialog.getByTestId('share-link-url').textContent();
  await dialog.getByTestId('share-link-toggle').click();
  await expect(dialog.getByTestId('share-link-role')).toHaveCount(0);
  await dialog.getByTestId('share-link-toggle').click();
  await expect(dialog.getByTestId('share-link-url')).not.toHaveText(oldUrl ?? '');
});

test('普通协作者分享默认导出，无邀请与成员管理操作', async ({ browser, request }) => {
  const owner = await apiRegister(request);
  const member = await apiRegister(request);
  const memberMe = await request.get('/api/users/me', { headers: authHeader(member.token) });
  const memberId = ((await memberMe.json()) as { id: string }).id;
  const created = await request.post('/api/files', { data: { title: '普通成员四页签' }, headers: authHeader(owner.token) });
  const fileId = ((await created.json()) as { id: string }).id;
  const added = await request.post(`/api/files/${fileId}/collaborators`, { data: { members: [{ userId: memberId, role: 'commenter' }] }, headers: authHeader(owner.token) });
  expect(added.status()).toBe(201);

  const context = await browser.newContext();
  const page = await context.newPage();
  await injectToken(page, member.token);
  await page.goto(`/edit/${fileId}`);
  await expect(page.locator('.editor-canvas')).toBeVisible();
  await expect(page.getByTestId('members-count')).toHaveText('2');
  await expect(page.getByTestId('members-online-count')).toHaveText('1');
  await expect(page.getByTestId('title-display')).toHaveText('普通成员四页签');
  await expect(page.getByTestId('title-edit')).toHaveCount(0);
  await page.getByTestId('share-btn').click();
  await expect(page.getByTestId('share-tab-export')).toHaveAttribute('aria-selected', 'true');
  await expect(page.getByTestId('share-tab-invite')).toHaveCount(0);
  await page.getByTestId('share-tab-members').click();
  await expect(page.getByTestId('member-role-select')).toHaveCount(0);
  await expect(page.getByTestId('member-remove-btn')).toHaveCount(0);
  await page.getByTestId('share-dialog-close').click();
  await page.locator('.editor-canvas svg .gm-text', { hasText: '中心主题' }).click();
  await page.getByTestId('comment-toggle').click();
  await page.getByTestId('comment-input').fill('可评论成员的真实评论');
  await page.getByTestId('comment-send').click();
  await expect(page.getByTestId('comment-thread')).toContainText('可评论成员的真实评论');
  await context.close();
});
