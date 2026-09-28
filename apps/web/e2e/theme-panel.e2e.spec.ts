import { expect, test, type Page } from '@playwright/test';

/**
 * 主题扩容 3→12 + 缩略图选择面板 E2E — M6 Task 4（企微对标）。
 *
 * 零回归裁决：既有 theme-select <select> 保留（工具栏/mobile-readonly/toolbar
 * 既有用例依赖其 selectOption 路径），本任务为纯增量——select 展示 12 选项，
 * 旁边新增 theme-panel-toggle 按钮打开缩略图网格抽屉（testid theme-panel /
 * theme-item-{id}）。两条路径套用主题均为 setDocMeta themeId（可撤销）。
 * 颜色断言钉引擎主题主色（与 themes.test 主色钉定同源）：
 * gmind-blue root #3370ff / forest root #2d6a4f / violet root #5e3a99。
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

async function openSeedDoc(page: Page, title: string): Promise<void> {
  await registerAndLogin(page);
  await page.locator('.file-list li', { hasText: title }).click();
  await expect(page).toHaveURL(/\/edit\//);
  await expect(page.locator('.editor-canvas svg .gm-text', { hasText: title })).toBeVisible();
}

/** root 节点（含 title 文本）的 rect fill——主题套用/撤销的观察锚点。 */
function rootRectFill(page: Page, title: string) {
  return page
    .locator('.editor-canvas svg g[data-node-id]', {
      has: page.locator('.gm-text', { hasText: title }),
    })
    .locator('rect')
    .first();
}

// 用例 1：toggle 打开抽屉 → 12 个缩略图（每个内联迷你 SVG）→ 关闭按钮收起
test('主题面板：打开后展示 12 个缩略图，关闭按钮收起', async ({ page }) => {
  await openSeedDoc(page, '本周计划');
  await expect(page.getByTestId('theme-panel')).toHaveCount(0); // 关闭态整棵不渲染
  await page.getByTestId('theme-panel-toggle').click();
  const panel = page.getByTestId('theme-panel');
  await expect(panel).toBeVisible();
  // 12 套全量：M1b 三套 + M6 九套，每个缩略图内联 3 节点迷你 SVG
  const items = panel.locator('[data-testid^="theme-item-"]');
  await expect(items).toHaveCount(12);
  await expect(items.locator('svg').first()).toBeVisible();
  // 当前主题（默认 gmind-blue）高亮标注
  await expect(page.getByTestId('theme-item-gmind-blue')).toHaveAttribute('aria-pressed', 'true');
  await page.getByTestId('theme-panel-close').click();
  await expect(page.getByTestId('theme-panel')).toHaveCount(0);
});

// 用例 2：面板点 forest → root fill #3370ff→#2d6a4f，标题/保存指示不受影响，
// select 同步为 forest；Ctrl+Z 撤销恢复 #3370ff
test('主题面板：点新主题画布变色、select 同步、Ctrl+Z 恢复', async ({ page }) => {
  await openSeedDoc(page, '本周计划');
  const rootFill = rootRectFill(page, '本周计划');
  await expect(rootFill).toHaveAttribute('fill', '#3370ff'); // 默认 gmind-blue
  const titleBefore = await page.getByTestId('title-input').inputValue();

  await page.getByTestId('theme-panel-toggle').click();
  await page.getByTestId('theme-item-forest').click();
  // 套用即关闭抽屉 + 画布重建为 forest 三级色
  await expect(page.getByTestId('theme-panel')).toHaveCount(0);
  await expect(rootFill).toHaveAttribute('fill', '#2d6a4f');
  await expect(page.getByTestId('theme-select')).toHaveValue('forest');
  // 文档面不受影响：标题不变、保存链路照常推进
  await expect(page.getByTestId('title-input')).toHaveValue(titleBefore);
  await expect(page.getByTestId('save-status')).toHaveText(/已保存/);
  // 焦点移出控件后撤销：setDocMeta themeId 走 undo 栈，恢复经典蓝
  await page.locator('.editor-canvas svg').click({ position: { x: 30, y: 30 } });
  await page.keyboard.press('Control+Z');
  await expect(rootFill).toHaveAttribute('fill', '#3370ff');
  await expect(page.getByTestId('theme-select')).toHaveValue('gmind-blue');
});

// 用例 3（零回归）：select 路径保留且扩容到 12 项——selectOption(violet) 同样
// 变色 + 可撤销
test('主题下拉：12 选项保留 selectOption 路径，切换 violet 可撤销', async ({ page }) => {
  await openSeedDoc(page, '本周计划');
  const select = page.getByTestId('theme-select');
  await expect(select.locator('option')).toHaveCount(12);
  const rootFill = rootRectFill(page, '本周计划');
  await expect(rootFill).toHaveAttribute('fill', '#3370ff');
  await select.selectOption('violet');
  await expect(rootFill).toHaveAttribute('fill', '#5e3a99');
  await page.locator('.editor-canvas svg').click({ position: { x: 30, y: 30 } });
  await page.keyboard.press('Control+Z');
  await expect(rootFill).toHaveAttribute('fill', '#3370ff');
});
