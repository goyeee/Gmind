import { expect, test, type Page } from '@playwright/test';

/**
 * 节点折叠/展开交互 E2E —— 2026-10-20 需求方裁定：
 *
 * - 展开态**默认不显示折叠样式**：engine 仅对「有可见子节点」的节点渲染折叠
 *   切换钮（.gm-collapse-toggle[data-for-id]，连接处透明命中圆 + 「–」圆钮），
 *   圆钮默认 opacity 0，悬停命中区（连接处）才由宿主 CSS 显形。
 * - 点击切换钮收起：子树隐藏，节点连接处出现折叠徽标 +N（N=被隐藏的存活后代数）。
 * - 点击徽标展开：子树恢复、徽标移除、切换钮回来。
 * - 叶子节点零折叠语义（无切换钮也无徽标）。键盘折叠（toggle-collapse 快捷键）
 *   与「查找定位展开折叠祖先」为既有行为，本套件不重复覆盖。
 *
 * 种子「本周计划」树：root → 周一(周会对齐)/周三(方案评审)/周五(周报复盘)，
 * 周 X 各恰有 1 个子节点 → 周一收起 = +1、root 收起 = +5（3 子 + 3 孙）。
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

function nodeGroup(page: Page, text: string) {
  return page.locator('.editor-canvas svg g[data-node-id]').filter({ hasText: text });
}

function foldToggleOf(page: Page, text: string) {
  return nodeGroup(page, text).locator('.gm-collapse-toggle');
}

function collapseBadgeOf(page: Page, text: string) {
  return nodeGroup(page, text).locator('.gm-collapse-badge');
}

/** 读取元素计算样式 opacity（显隐断言用；SVG 元素同样适用）。 */
async function opacityOf(locator: ReturnType<Page['locator']>): Promise<string> {
  return locator.evaluate((el) => getComputedStyle(el).opacity);
}

/** 悬停后等 0.12s 过渡完成再断言显形（expect.poll 轮询 computed opacity）。 */
async function expectVisibleAfterHover(toggle: ReturnType<Page['locator']>): Promise<void> {
  await toggle.hover();
  await expect
    .poll(() => opacityOf(toggle.locator('.gm-collapse-toggle-fg')), { timeout: 2000 })
    .toBe('1');
}

// 用例 1：展开态默认样式——父节点有切换钮但圆钮隐形（opacity 0）、无徽标；叶子零折叠语义。
test('折叠切换钮：展开态默认隐形，叶子节点不渲染', async ({ page }) => {
  await openSeedDoc(page, '本周计划');
  // 周一（有 1 个子节点）：切换钮存在，圆钮默认隐形
  const toggle = foldToggleOf(page, '周一');
  await expect(toggle).toHaveCount(1);
  await expect(toggle).toHaveAttribute('data-for-id', /.+/); // 点击委托锚点
  await expect(collapseBadgeOf(page, '周一')).toHaveCount(0);
  expect(await opacityOf(toggle.locator('.gm-collapse-toggle-fg'))).toBe('0');
  // 周会对齐（叶子）：无切换钮、无徽标
  await expect(foldToggleOf(page, '周会对齐')).toHaveCount(0);
  await expect(collapseBadgeOf(page, '周会对齐')).toHaveCount(0);
});

// 用例 2：悬停连接处显形 → 点击收起 → 徽标 +N 出现且子树隐藏。
test('折叠切换钮：悬停显形，点击收起后徽标 +1 且子节点隐藏', async ({ page }) => {
  await openSeedDoc(page, '本周计划');
  const toggle = foldToggleOf(page, '周一');
  // 悬停连接处（命中圆）：圆钮显形
  await expectVisibleAfterHover(toggle);
  // 点击收起：徽标 +1（周一恰 1 个被隐藏后代）、切换钮移除、子节点不可见
  await toggle.click();
  const badge = collapseBadgeOf(page, '周一');
  await expect(badge).toHaveCount(1);
  await expect(badge).toHaveText('+1');
  await expect(foldToggleOf(page, '周一')).toHaveCount(0);
  await expect(page.locator('.editor-canvas svg .gm-text', { hasText: '周会对齐' })).toHaveCount(0);
  // 兄弟分支不受影响：周三子树仍可见
  await expect(page.locator('.editor-canvas svg .gm-text', { hasText: '方案评审' })).toBeVisible();
});

// 用例 3：点击徽标展开——子树恢复、徽标移除、切换钮回来（再次悬停可复用）。
test('折叠徽标点击展开：子树恢复、徽标移除、切换钮回归', async ({ page }) => {
  await openSeedDoc(page, '本周计划');
  await foldToggleOf(page, '周一').click();
  const badge = collapseBadgeOf(page, '周一');
  await expect(badge).toHaveText('+1');
  await badge.click();
  await expect(page.locator('.editor-canvas svg .gm-text', { hasText: '周会对齐' })).toBeVisible();
  await expect(badge).toHaveCount(0);
  const toggle = foldToggleOf(page, '周一');
  await expect(toggle).toHaveCount(1);
  await expectVisibleAfterHover(toggle);
});

// 用例 4：root 收起——徽标计数 = 全部被隐藏后代（3 子 + 3 孙 = +6）。
test('root 收起：徽标计数为全部被隐藏后代数（+6）', async ({ page }) => {
  await openSeedDoc(page, '本周计划');
  await expectVisibleAfterHover(foldToggleOf(page, '本周计划'));
  await foldToggleOf(page, '本周计划').click();
  const badge = collapseBadgeOf(page, '本周计划');
  await expect(badge).toHaveText('+6');
  // 全树隐藏：仅 root 文本仍在
  await expect(page.locator('.editor-canvas svg .gm-text', { hasText: '周一' })).toHaveCount(0);
  await expect(page.locator('.editor-canvas svg .gm-text', { hasText: '本周计划' })).toBeVisible();
});
