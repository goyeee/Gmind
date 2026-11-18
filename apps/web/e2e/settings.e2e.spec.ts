import { expect, test } from '@playwright/test';
import { E2E_DOMAIN, registerAndLogin } from './helpers/auth';

/**
 * 账号设置页 UI E2E — M5 Task 1（FR-ACC-002 + FR-CMT-006）→ 2026-11-12 账号体系重做
 * 邮箱化改写（plan Task 7 Step 2/3）。
 *
 * 登录走公共 helper（API 邮箱注册即登录 + 注 token，见 helpers/auth.ts；注册即赠
 * 3 个种子文件）。设置页现为六卡：头像 / 账号资料（昵称行内编辑）/ 登录密码（恒
 * 当前密码核身）/ 换绑账号（邮箱区=验证码+密码 → POST /users/me/email；手机号区=
 * 仅密码 → POST /users/me/phone）/ 绑定微信（占位）/ 通知偏好。
 *
 * 「无密码账号（管理员建号）设置页引导文案」分支由 login-page.e2e.spec.ts 的
 * hasPassword=false 渲染分支用例覆盖（真实无密码账号无会话通道，无法注入 token——
 * 登录死路正是产品行为，故无真实造号用例）。
 */

const uniqueEmail = (): string => `e2e-set-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}@${E2E_DOMAIN}`;

/** 从工作台头部进入设置页（user-card → settings-entry，SPA 导航）。 */
async function openSettings(page: import('@playwright/test').Page): Promise<void> {
  await page.getByTestId('user-card').click();
  await page.getByTestId('settings-entry').click();
  await expect(page).toHaveURL(/\/settings/);
  await expect(page.getByTestId('settings-page')).toBeVisible();
}

test('工作台「账号设置」入口 → /settings 六卡渲染（有密码形态）', async ({ page }) => {
  await registerAndLogin(page);
  await openSettings(page);

  // 六卡齐备
  await expect(page.getByTestId('avatar-section')).toBeVisible();
  await expect(page.getByTestId('profile-section')).toBeVisible();
  await expect(page.getByTestId('password-section')).toBeVisible();
  await expect(page.getByTestId('rebind-section')).toBeVisible();
  await expect(page.getByTestId('wechat-section')).toBeVisible();
  await expect(page.getByTestId('notify-pref-mention')).toBeVisible();
  await expect(page.getByTestId('notify-pref-reply')).toBeVisible();
  await expect(page.getByTestId('notify-pref-permission')).toBeVisible();

  // 有密码（邮箱注册）：当前密码形态，无引导文案，表单可用
  await expect(page.getByTestId('password-current')).toBeVisible();
  await expect(page.getByTestId('password-guide')).toHaveCount(0);
  await expect(page.getByTestId('settings-save')).toBeEnabled();
});

// 头像区（2026-10-11 需求方裁定）：当前头像展示 + 5 预置 SVG 可选 + 本地上传。
test('头像区：当前头像与预置库渲染，选预置后当前头像与 me 同步', async ({ page }) => {
  await registerAndLogin(page);
  await openSettings(page);
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
  // 2026-11-18 原型对齐：选中预置带选中态（蓝圈 + 小勾），其余未选
  await expect(page.getByTestId('avatar-preset-4')).toHaveAttribute('aria-pressed', 'true');
  await expect(page.getByTestId('avatar-preset-1')).toHaveAttribute('aria-pressed', 'false');
  const token = await page.evaluate(() => localStorage.getItem('gmind.token'));
  const me = await page.request.get('/api/users/me', { headers: { Authorization: `Bearer ${token ?? ''}` } });
  expect(((await me.json()) as { avatarUrl: string }).avatarUrl).toBe('/avatars/preset-4.svg');
});

test('改密：当前密码核身成功 toast，新密码可再次登录', async ({ page }) => {
  const account = await registerAndLogin(page);
  await page.goto('/settings');
  await expect(page.getByTestId('settings-page')).toBeVisible();

  await page.getByTestId('password-current').fill(account.password);
  await page.getByTestId('password-new').fill('newpass654321');
  await page.getByTestId('settings-save').click();
  await expect(page.getByTestId('toast')).toContainText('密码已修改');

  // 新密码可登录、旧密码失效（UI 登录表单路径；token 清除后走登录页）
  await page.evaluate(() => localStorage.removeItem('gmind.token'));
  await page.goto('/login');
  await page.getByTestId('login-account').fill(account.email);
  await page.getByTestId('login-password').fill('newpass654321');
  await page.getByTestId('login-submit').click();
  await expect(page).toHaveURL(/\/workspace/);
});

test('换绑邮箱：验证码+当前密码核身 → toast，当前绑定随列更新', async ({ page }) => {
  await registerAndLogin(page);
  await openSettings(page);

  const newEmail = uniqueEmail();
  await page.getByTestId('rebind-email').fill(newEmail);
  await page.getByTestId('rebind-email-code-send').click();
  await expect(page.getByTestId('rebind-email-code-send')).toBeDisabled(); // 60s 倒计时
  await page.getByTestId('rebind-email-code').fill('123456'); // dev/test 验证码恒 DEV_MAIL_CODE
  await page.getByTestId('rebind-email-password').fill('pass123456');
  await page.getByTestId('rebind-email-save').click();

  await expect(page.getByTestId('toast')).toContainText('邮箱已换绑，请使用新邮箱登录');
  await expect(page.getByTestId('rebind-email-block').locator('.settings-hint')).toContainText(newEmail);
  // 服务端落库核对
  const token = await page.evaluate(() => localStorage.getItem('gmind.token'));
  const me = await page.request.get('/api/users/me', { headers: { Authorization: `Bearer ${token ?? ''}` } });
  expect(((await me.json()) as { email: string }).email).toBe(newEmail);
});

test('换绑手机号：仅当前密码核身 → toast，当前手机号带「未验证」徽标', async ({ page }) => {
  await registerAndLogin(page);
  await openSettings(page);

  const newPhone = `138${String(Date.now()).slice(-8)}`;
  await page.getByTestId('rebind-phone').fill(newPhone);
  await page.getByTestId('rebind-phone-password').fill('pass123456');
  await page.getByTestId('rebind-phone-save').click();

  await expect(page.getByTestId('toast')).toContainText('手机号已更新');
  // 2026-11-18 原型对齐：当前绑定手机号掩码展示（138 **** 1234 形态）
  await expect(page.getByTestId('rebind-phone-block').locator('.settings-hint')).toContainText(
    `${newPhone.slice(0, 3)} **** ${newPhone.slice(7)}`,
  );
  await expect(page.getByTestId('rebind-phone-block').locator('.settings-hint')).not.toContainText(newPhone);
  await expect(page.getByTestId('phone-unverified-badge')).toHaveText('未验证');
});

test('账号资料：昵称行内编辑 → toast，刷新仍保持', async ({ page }) => {
  await registerAndLogin(page, { nickname: '资料卡旧昵称' });
  await openSettings(page);
  await expect(page.getByTestId('profile-nickname')).toHaveText('资料卡旧昵称');

  await page.getByTestId('profile-nickname-edit').click();
  await page.getByTestId('profile-nickname-input').fill('资料卡新昵称');
  await page.getByTestId('profile-nickname-save').click();
  await expect(page.getByTestId('toast')).toContainText('昵称已更新');
  await expect(page.getByTestId('profile-nickname')).toHaveText('资料卡新昵称');

  await page.reload();
  await expect(page.getByTestId('profile-nickname')).toHaveText('资料卡新昵称');
  // 2026-11-18 原型对齐：部门/分组只读行（新注册用户未分配 → 均显示「无」）
  await expect(page.getByTestId('profile-dept')).toContainText('无');
  await expect(page.getByTestId('profile-groups')).toContainText('无');
  await expect(page.getByTestId('profile-section')).toContainText('部门与分组由管理员在"组织管理"中调整');
});

test('绑定微信占位卡：点击 toast「微信绑定暂未开通，敬请期待」', async ({ page }) => {
  await registerAndLogin(page);
  await openSettings(page);
  await page.getByTestId('wechat-bind-btn').click();
  await expect(page.getByTestId('toast')).toHaveText('微信绑定暂未开通，敬请期待');
});

test('偏好开关切换 → 刷新仍保持', async ({ page }) => {
  await registerAndLogin(page);
  await openSettings(page);

  // 2026-11-18 原型语义（需求方拍板反转）：蓝=接收该类型邮件提醒，默认全蓝；
  // 点灭=关闭提醒（写入 emailOptOut，服务端语义不变）
  await expect(page.getByTestId('notify-pref-mention')).toBeChecked();
  await page.getByTestId('notify-pref-mention').uncheck();
  await expect(page.getByTestId('toast')).toContainText('已完成');

  // 刷新后「提及」保持关闭，其他类型仍接收
  await page.reload();
  await expect(page.getByTestId('notify-pref-mention')).not.toBeChecked();
  await expect(page.getByTestId('notify-pref-reply')).toBeChecked();
  await expect(page.getByTestId('notify-pref-permission')).toBeChecked();
});

test('邮件摘要总开关关闭：按事件类型区提示「暂不生效」且开关禁用', async ({ page }) => {
  await registerAndLogin(page);
  await openSettings(page);
  // 等 PATCH 真实成功再断言（乐观更新在高负载全量跑时可能与回滚/二次点击竞态）
  const waitPrefPatch = (): Promise<unknown> =>
    page.waitForResponse(
      (r) => r.url().includes('/api/users/me/notify-prefs') && r.request().method() === 'PATCH' && r.ok(),
    );
  let patched = waitPrefPatch();
  await page.getByTestId('notify-master-digest').click();
  await patched;
  // 2026-11-18 原型对齐：总开关关后说明文案切换 + 细项禁用
  await expect(page.getByTestId('notify-pref-group')).toContainText('邮件摘要已整体关闭，以下选项暂不生效。');
  await expect(page.getByTestId('notify-pref-mention')).toBeDisabled();
  // 重新打开：说明回到原口径
  patched = waitPrefPatch();
  await page.getByTestId('notify-master-digest').click();
  await patched;
  await expect(page.getByTestId('notify-pref-group')).toContainText('回收站清理提醒恒发');
});
