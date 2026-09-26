import { expect, test, type Page } from '@playwright/test';

/**
 * 账号设置页 UI E2E — M5 Task 1（FR-ACC-002 收口 + FR-CMT-006 通知偏好收口）。
 *
 * 复用 M0 登录模式（新手机号注册即赠 3 个种子文件；手机号注册用户 password_hash
 * 为空 → 改密区=验证码形态）。覆盖：
 * - 工作台头部「账号设置」入口（data-testid="settings-entry"）→ /settings 渲染
 *   （data-testid="settings-page"），三区卡片与开关 testid 齐备；
 * - 密码区按身份形态渲染：无密码=验证码输入（password-code），有密码=旧密码输入
 *   （password-current，邮箱注册用户经 API 造号 + token 注入直达）；
 * - 换绑表单提交成功 toast（含「已完成」）；
 * - 偏好开关切换（开关即 PATCH）→ 刷新仍保持。
 */

async function registerAndLogin(page: Page): Promise<void> {
  await page.goto('/login');
  const phone = '138' + String(Math.floor(10000000 + Math.random() * 89999999));
  await page.getByPlaceholder('手机号').fill(phone);
  await page.getByPlaceholder('验证码（开发环境固定 123456）').fill('123456');
  await page.getByRole('button', { name: '登录', exact: true }).click();
  await expect(page).toHaveURL(/\/workspace/);
  await expect(page.locator('.file-list li')).toHaveCount(3);
}

test('工作台「账号设置」入口 → /settings 三区渲染（无密码=验证码形态）', async ({ page }) => {
  await registerAndLogin(page);
  await page.getByTestId('settings-entry').click();
  await expect(page).toHaveURL(/\/settings/);
  await expect(page.getByTestId('settings-page')).toBeVisible();

  await expect(page.getByTestId('password-section')).toBeVisible();
  // 无密码（手机号注册）：验证码输入形态，无旧密码输入
  await expect(page.getByTestId('password-code')).toBeVisible();
  await expect(page.getByTestId('password-current')).toHaveCount(0);
  await expect(page.getByTestId('settings-save')).toBeVisible();

  await expect(page.getByTestId('rebind-section')).toBeVisible();
  await expect(page.getByTestId('notify-pref-mention')).toBeVisible();
  await expect(page.getByTestId('notify-pref-reply')).toBeVisible();
  await expect(page.getByTestId('notify-pref-permission')).toBeVisible();
});

test('有密码（邮箱注册）用户：密码区渲染旧密码形态', async ({ page }) => {
  // 邮箱验证码注册并设置密码（UI 不提供该组合，经 API 造号）→ 注入 token 直达 /settings
  const email = `u${Date.now()}@test.dev`;
  const res = await page.request.post('/api/auth/login', {
    data: { method: 'email', email, mode: 'code', code: '123456', password: 'oldpass66' },
  });
  expect(res.ok()).toBeTruthy();
  const { token } = (await res.json()) as { token: string };
  await page.addInitScript((t) => localStorage.setItem('gmind.token', t), token);

  await page.goto('/settings');
  await expect(page.getByTestId('settings-page')).toBeVisible();
  await expect(page.getByTestId('password-current')).toBeVisible();
  await expect(page.getByTestId('password-code')).toHaveCount(0);
});

test('换绑表单提交成功 toast（含「已完成」）', async ({ page }) => {
  await registerAndLogin(page);
  await page.getByTestId('settings-entry').click();
  await expect(page.getByTestId('settings-page')).toBeVisible();

  await page.getByTestId('rebind-channel').selectOption('email');
  await page.getByTestId('rebind-identity').fill(`rebind-${Date.now()}@test.dev`);
  await page.getByTestId('rebind-code').fill('123456');
  await page.getByTestId('rebind-save').click();
  await expect(page.getByTestId('toast')).toContainText('已完成');
});

test('偏好开关切换 → 刷新仍保持', async ({ page }) => {
  await registerAndLogin(page);
  await page.getByTestId('settings-entry').click();
  await expect(page.getByTestId('settings-page')).toBeVisible();

  // 开关即 PATCH：勾选后「已完成」toast 到达
  await page.getByTestId('notify-pref-mention').check();
  await expect(page.getByTestId('toast')).toContainText('已完成');

  // 刷新后开关保持勾选，且其他开关不受影响
  await page.reload();
  await expect(page.getByTestId('notify-pref-mention')).toBeChecked();
  await expect(page.getByTestId('notify-pref-reply')).not.toBeChecked();
  await expect(page.getByTestId('notify-pref-permission')).not.toBeChecked();
});
