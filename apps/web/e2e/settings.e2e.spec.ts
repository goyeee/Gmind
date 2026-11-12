import { expect, test } from '@playwright/test';
import { apiRegister, injectToken, registerAndLogin } from './helpers/auth';

/**
 * 账号设置页 UI E2E — M5 Task 1（FR-ACC-002 收口 + FR-CMT-006 通知偏好收口）。
 *
 * 登录走公共 helper（API 邮箱注册即登录 + 注 token，见 helpers/auth.ts；注册即赠
 * 3 个种子文件）。注意（2026-11-12 账号重做中间态）：新契约下注册必有密码，且
 * 换绑/验证码改密的旧 UI 通道（POST /users/me/rebind 等）已随服务端重做删除，
 * 「无密码=验证码形态」与「换绑成功 toast」两用例在 Task 7 重做 SettingsPage 前
 * 预期红。覆盖：
 * - 工作台头部「账号设置」入口（data-testid="settings-entry"）→ /settings 渲染
 *   （data-testid="settings-page"），三区卡片与开关 testid 齐备；
 * - 密码区按身份形态渲染：有密码=旧密码输入（password-current，API 造号 + token 注入直达）；
 * - 换绑表单提交成功 toast（含「已完成」，旧通道，预期红）；
 * - 偏好开关切换（开关即 PATCH）→ 刷新仍保持。
 */

test('工作台「账号设置」入口 → /settings 三区渲染（无密码=验证码形态）', async ({ page }) => {
  // 2026-11-12 账号重做中间态：邮箱注册必有密码，「无密码=验证码形态」造号通道只剩
  // 管理员建号（需超管，任务 8 seed-demo 后可恢复）；且 me 未装载时页面先渲染验证码
  // 分支（me?.hasPassword 为 undefined 走 falsy），断言会落在竞态窗口上假绿——故显式
  // skip，待 Task 7 重做 SettingsPage 后按新契约重写。
  test.skip(true, '无密码形态造号通道已随注册必有密码删除（中间态，Task 7 重写）');
  await registerAndLogin(page);
  await page.getByTestId('user-card').click();
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

// 头像区（2026-10-11 需求方裁定）：当前头像展示 + 5 预置 SVG 可选 + 本地上传。
test('头像区：当前头像与预置库渲染，选预置后当前头像与 me 同步', async ({ page }) => {
  await registerAndLogin(page);
  await page.getByTestId('user-card').click();
  await page.getByTestId('settings-entry').click();
  await expect(page).toHaveURL(/\/settings/);
  const section = page.getByTestId('avatar-section');
  await expect(section).toBeVisible();
  // 当前头像（未自定义 → Avatar 组件稳定分配预置 SVG，圆形 <img>）
  const current = page.getByTestId('avatar-current').locator('img');
  await expect(current).toHaveAttribute('src', /\/avatars\/preset-\d\.svg/);
  // 预置库 5 枚齐
  for (let i = 1; i <= 5; i += 1) {
    await expect(page.getByTestId(`avatar-preset-${i}`)).toBeVisible();
  }
  await expect(page.getByTestId('avatar-upload-input')).toHaveCount(1);
  // 选 preset-4 → 当前头像同步 + 服务端 me 落库
  await page.getByTestId('avatar-preset-4').click();
  await expect(page.getByTestId('avatar-current').locator('img')).toHaveAttribute('src', '/avatars/preset-4.svg');
  await expect(page.getByTestId('toast')).toContainText('头像已更新');
  const token = await page.evaluate(() => localStorage.getItem('gmind.token'));
  const me = await page.request.get('/api/users/me', { headers: { Authorization: `Bearer ${token ?? ''}` } });
  expect(((await me.json()) as { avatarUrl: string }).avatarUrl).toBe('/avatars/preset-4.svg');
});

test('有密码（邮箱注册）用户：密码区渲染旧密码形态', async ({ page }) => {
  // 邮箱注册即设密码（helpers/auth API 造号）→ 注入 token 直达 /settings
  const account = await apiRegister(page.request);
  await injectToken(page, account.token);
  await page.goto('/settings');
  await expect(page.getByTestId('settings-page')).toBeVisible();
  await expect(page.getByTestId('password-current')).toBeVisible();
  await expect(page.getByTestId('password-code')).toHaveCount(0);
});

test('换绑表单提交成功 toast（含「已完成」）', async ({ page }) => {
  await registerAndLogin(page);
  await page.getByTestId('user-card').click();
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
  await page.getByTestId('user-card').click();
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
