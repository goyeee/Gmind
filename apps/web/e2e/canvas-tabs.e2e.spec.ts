import { expect, test, type Page } from '@playwright/test';

/**
 * 底部画布页签条 E2E — 多画布 web 计划三 Task 2（企微形态：底栏左侧画布页签）。
 *
 * 契约（testid 冻结）：
 * - canvas-tabbar（页签条容器）；canvas-tab-<id>（页签，当前项加 canvas-tab-active 类）；
 * - canvas-add（➕ 新建）：弹出 canvas-rename-input 行内输入（Enter/失焦提交、Esc 取消）；
 * - 双击页签重命名（同一个 canvas-rename-input）；
 * - 右键菜单 canvas-menu-rename / canvas-menu-delete（样式令牌对齐 .context-menu）；
 * - 删除确认 window.confirm（先例：TaskPanel/VersionPanel）；最后一张删除被 core 拦截
 *   （CANVAS_LAST_FORBIDDEN）→ 两段式 toast「这是最后一张画布。画布不可全部删除」。
 *
 * 覆盖（brief Step 1）：
 * - ➕ 新建画布 → 页签 +1 且自动切换到新画布（场景 root = 中心主题）；
 * - 双击重命名 → Enter 提交持久化；
 * - 右键删除（confirm 接受）→ 页签 -1 且活动回退；
 * - 刷新后页签与名字仍在；删最后一张 → toast 拦截、页签不变。
 */

async function registerAndLogin(page: Page): Promise<void> {
  await page.goto('/login');
  const phone = '138' + String(Math.floor(10000000 + Math.random() * 89999999));
  await page.getByPlaceholder('手机号').fill(phone);
  await page.getByPlaceholder('验证码（开发环境固定 123456）').fill('123456');
  await page.getByRole('button', { name: '登录', exact: true }).click();
  await expect(page).toHaveURL(/\/workspace/);
  await expect(page.getByTestId('mine-grid').getByTestId('file-card')).toHaveCount(3);
}

async function openSeedDoc(page: Page, title: string): Promise<void> {
  await registerAndLogin(page);
  await page.getByTestId('file-card').filter({ hasText: title }).first().click();
  await expect(page).toHaveURL(/\/edit\//);
  await expect(page.locator('.editor-canvas svg .gm-text', { hasText: title })).toBeVisible();
  await expect(page.getByTestId('canvas-tabbar')).toBeVisible();
}

/** 页签条内全部页签（canvas-tab-<id>，前缀选择器——id 为 ULID 不可预知）。 */
function tabs(page: Page): ReturnType<Page['locator']> {
  return page.locator('[data-testid="canvas-tabbar"] [data-testid^="canvas-tab-"]');
}

/** ➕ 新建画布（行内输入提交）。 */
async function addCanvasViaUi(page: Page, name: string): Promise<void> {
  await page.getByTestId('canvas-add').click();
  const input = page.getByTestId('canvas-rename-input');
  await expect(input).toBeVisible();
  await input.fill(name);
  await page.keyboard.press('Enter');
  await expect(input).toHaveCount(0);
}

test('➕ 新建画布：页签 +1、自动切换、刷新后页签与名字仍在', async ({ page }) => {
  test.setTimeout(90_000);
  await openSeedDoc(page, '本周计划');
  await expect(tabs(page)).toHaveCount(1); // 种子文档 = 单画布（迁移画布）

  // 新建「画布B」：页签 +1
  await addCanvasViaUi(page, '画布B');
  await expect(tabs(page)).toHaveCount(2);

  // 自动切换到新画布：活动页签 = 画布B，场景 root = 中心主题
  await expect(page.locator('.canvas-tab-active')).toHaveText('画布B');
  await expect(page.locator('.editor-canvas svg .gm-text', { hasText: '中心主题' })).toBeVisible();

  // 刷新（会话保持先例：editor/emoji/collab spec 同款 reload）：页签与名字仍在，活动仍=画布B
  await page.reload();
  await expect(page.getByTestId('canvas-tabbar')).toBeVisible();
  await expect(tabs(page)).toHaveCount(2);
  await expect(page.locator('.canvas-tab-active')).toHaveText('画布B');
});

test('双击重命名持久化 → 右键删除回退 → 删最后一张被拦截', async ({ page }) => {
  test.setTimeout(90_000);
  // 删除确认走 window.confirm（先例：TaskPanel/VersionPanel）——Playwright 默认 dismiss
  // 会取消删除，统一接受（导入导出 spec 折叠导出同款处理）。
  page.on('dialog', (dialog) => void dialog.accept());
  await openSeedDoc(page, '本周计划');
  await addCanvasViaUi(page, '画布B');
  await expect(tabs(page)).toHaveCount(2);

  // 双击重命名 → Enter 提交 → 页签名字即时更新
  await page.locator('[data-testid^="canvas-tab-"]', { hasText: '画布B' }).dblclick();
  const input = page.getByTestId('canvas-rename-input');
  await expect(input).toHaveValue('画布B');
  await input.fill('画布B-改');
  await page.keyboard.press('Enter');
  await expect(page.getByTestId('canvas-rename-input')).toHaveCount(0);
  await expect(page.locator('[data-testid^="canvas-tab-"]', { hasText: '画布B-改' })).toBeVisible();

  // 刷新后名字仍在
  await page.reload();
  await expect(page.getByTestId('canvas-tabbar')).toBeVisible();
  await expect(page.locator('[data-testid^="canvas-tab-"]', { hasText: '画布B-改' })).toBeVisible();

  // 右键删除「画布B-改」→ confirm 接受 → 页签 -1，活动回退到首个画布
  await page.locator('[data-testid^="canvas-tab-"]', { hasText: '画布B-改' }).click({ button: 'right' });
  await expect(page.getByTestId('canvas-menu-delete')).toBeVisible();
  await page.getByTestId('canvas-menu-delete').click();
  await expect(tabs(page)).toHaveCount(1);
  await expect(page.locator('.canvas-tab-active').first()).not.toHaveText('画布B-改');

  // 删最后一张：core CANVAS_LAST_FORBIDDEN 拦截 → 两段式 toast，页签不变
  await page.locator('[data-testid^="canvas-tab-"]').first().click({ button: 'right' });
  await page.getByTestId('canvas-menu-delete').click();
  await expect(page.getByTestId('toast')).toContainText('这是最后一张画布');
  await expect(tabs(page)).toHaveCount(1);
});
