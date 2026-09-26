import { expect, test, type Page } from '@playwright/test';

/**
 * 快捷键帮助面板 E2E — M5 Task 2（NFR-USE-002 / FR-EDT-007）。
 *
 * 键位裁决（PRD 3.1.2：Ctrl+/ = 折叠、Ctrl+? = 帮助，两键必须错开）：帮助 opener
 * 为 Ctrl/Cmd+Shift+/（US 布局即 Ctrl+?，事件 key='?'）；无 Shift 的 Ctrl+/ 仍是
 * 折叠通道（editor.e2e 用例 6 的既有行为，这里回归钉住）。Playwright 无法产生
 * 「key='/' 且带 Shift」的非 US 布局形态，该分支由 keyboardMap.test.ts 纯函数覆盖。
 *
 * 平台列断言两侧都显式注入 navigator.platform：宿主为 macOS 时 headless Chromium
 * 默认即 MacIntel，不钉死则「Windows 列显示 Ctrl」会随宿主漂移。
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

/** 打开种子文件进入编辑器，等待 root 文本渲染。 */
async function openSeedDoc(page: Page): Promise<void> {
  await registerAndLogin(page);
  await page.locator('.file-list li', { hasText: '本周计划' }).click();
  await expect(page).toHaveURL(/\/edit\//);
  await expect(page.locator('.editor-canvas svg .gm-text', { hasText: '本周计划' })).toBeVisible();
}

test('快捷键面板：Ctrl+? 打开 → 三分组/Windows 键位 → 搜索折叠过滤 → Escape 关闭', async ({
  page,
}) => {
  await page.addInitScript(() => {
    Object.defineProperty(navigator, 'platform', { get: () => 'Win32', configurable: true });
  });
  await openSeedDoc(page);

  // Ctrl+?（= Ctrl+Shift+/，事件 key='?'）打开面板
  await expect(page.getByTestId('help-panel')).toHaveCount(0);
  await page.keyboard.press('Control+Shift+/');
  const panel = page.getByTestId('help-panel');
  await expect(panel).toBeVisible();

  // 三分组标题齐备；Windows 列显示 Ctrl 系键位
  for (const group of ['节点编辑', '视图', '文件']) {
    await expect(panel.getByRole('heading', { name: group })).toBeVisible();
  }
  await expect(panel.locator('[data-testid="help-keys"]', { hasText: 'Ctrl' }).first()).toBeVisible();

  // 搜索「折叠」：仅剩折叠相关条目（折叠条目在，撤销条目不在）
  await page.getByTestId('help-search').fill('折叠');
  await expect(panel.locator('[data-testid="help-item"]', { hasText: '折叠' })).toHaveCount(1);
  await expect(panel.locator('[data-testid="help-item"]', { hasText: '撤销' })).toHaveCount(0);

  // Escape 关闭
  await page.keyboard.press('Escape');
  await expect(panel).toHaveCount(0);

  // 回归钉住：无 Shift 的 Ctrl+/ 仍是折叠通道（root 默认选中 → +N 徽标）
  await page.keyboard.press('Control+/');
  await expect(page.locator('.editor-canvas svg .gm-collapse-badge')).toHaveCount(1);
  await page.keyboard.press('Control+/');
  await expect(page.locator('.editor-canvas svg .gm-collapse-badge')).toHaveCount(0);

  // 输入控件让路：焦点在标题输入内按 Ctrl+? 不开面板（isEditableTarget 判定）
  await page.getByTestId('title-input').click();
  await page.keyboard.press('Control+Shift+/');
  await expect(page.getByTestId('help-panel')).toHaveCount(0);
});

test('快捷键面板：工具栏按钮开合 + macOS 平台显示 ⌘ 键位 + × 关闭', async ({ page }) => {
  await page.addInitScript(() => {
    Object.defineProperty(navigator, 'platform', { get: () => 'iPhone', configurable: true });
  });
  await openSeedDoc(page);

  await page.getByTestId('help-toggle').click();
  const panel = page.getByTestId('help-panel');
  await expect(panel).toBeVisible();

  // macOS 列显示 ⌘ 系键位（平台检测读 navigator.platform）
  await expect(panel.locator('[data-testid="help-keys"]', { hasText: '⌘' }).first()).toBeVisible();

  // × 按钮关闭
  await page.getByTestId('help-panel-close').click();
  await expect(panel).toHaveCount(0);
});
