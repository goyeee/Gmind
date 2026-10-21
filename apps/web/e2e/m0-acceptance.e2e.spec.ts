import { test, expect } from '@playwright/test';

test('M0 验收：手机验证码注册登录后看到 3 个示例文件', async ({ page }) => {
  await page.goto('/login');
  const phone = '138' + String(Date.now()).slice(-8);
  await page.getByPlaceholder('手机号').fill(phone);
  await page.getByPlaceholder('验证码（开发环境固定 123456）').fill('123456');
  await page.getByRole('button', { name: '登录', exact: true }).click();
  await expect(page).toHaveURL(/\/workspace/);
  await expect(page.getByText('欢迎使用 Gmind')).toBeVisible();
  await expect(page.getByTestId('mine-grid').getByTestId('file-card')).toHaveCount(3);
});

test('M0 验收：新建脑图出现在列表首位', async ({ page }) => {
  await page.goto('/login');
  const phone = '138' + String(Date.now()).slice(-8);
  await page.getByPlaceholder('手机号').fill(phone);
  await page.getByPlaceholder('验证码（开发环境固定 123456）').fill('123456');
  await page.getByRole('button', { name: '登录', exact: true }).click();
  await expect(page).toHaveURL(/\/workspace/);
  await page.getByRole('button', { name: '新建脑图' }).click();
  // 新建即开（2026-10-20 重设计）：点新建直接进编辑器
  await expect(page).toHaveURL(/\/edit\//);
  await expect(page.locator('.editor-canvas svg .gm-text', { hasText: '中心主题' })).toBeVisible();
});

test('未登录访问工作台跳转登录页', async ({ page }) => {
  await page.goto('/workspace');
  await expect(page).toHaveURL(/\/login/);
});
