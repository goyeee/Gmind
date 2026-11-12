import { test, expect, type Page } from '@playwright/test';
import { E2E_DOMAIN } from './helpers/auth';

/** UI 注册旅程（2026-11-12 新注册视图，替代旧「手机验证码登录即注册」）：
 *  邮箱 → 获取验证码（dev 固定码）→ 密码/昵称 → 注册并登录，落工作台。 */
async function uiRegister(page: Page): Promise<string> {
  const email = `e2e-m0-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}@${E2E_DOMAIN}`;
  await page.goto('/login');
  await page.getByTestId('link-register').click();
  await page.getByTestId('reg-email').fill(email);
  await page.getByTestId('reg-code-send').click();
  await page.getByTestId('reg-code').fill('123456'); // dev/test 验证码恒 DEV_MAIL_CODE（默认 123456）
  await page.getByTestId('reg-password').fill('pass123456');
  await page.getByTestId('reg-nickname').fill('验收用户');
  await page.getByTestId('reg-submit').click();
  return email;
}

test('M0 验收：邮箱验证码注册登录后看到 3 个示例文件', async ({ page }) => {
  await uiRegister(page);
  await expect(page).toHaveURL(/\/workspace/);
  await expect(page.getByTestId('quick-create-blank')).toBeVisible(); // 首页落点（问候+快速创建）
  await page.goto('/workspace?view=files');
  await expect(page.getByText('欢迎使用 Gmind')).toBeVisible(); // 种子文件在「我的文件」视图
  await expect(page.getByTestId('mine-grid').getByTestId('file-card')).toHaveCount(3);
});

test('M0 验收：新建脑图出现在列表首位', async ({ page }) => {
  await uiRegister(page);
  await expect(page).toHaveURL(/\/workspace/);
  await page.getByTestId('new-file-btn').click();
  await page.getByTestId('create-menu-map').click();
  // 新建即开（2026-10-20 重设计）：点新建直接进编辑器
  await expect(page).toHaveURL(/\/edit\//);
  await expect(page.locator('.editor-canvas svg .gm-text', { hasText: '中心主题' })).toBeVisible();
});

test('未登录访问工作台跳转登录页', async ({ page }) => {
  await page.goto('/workspace');
  await expect(page).toHaveURL(/\/login/);
});
