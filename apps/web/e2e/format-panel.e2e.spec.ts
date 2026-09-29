import { expect, test, type Page } from '@playwright/test';

/**
 * 格式面板随选中联动 E2E — M6 Task 2（企微对标）。
 *
 * 样式区回显选中节点的样式：填充/文字色色钮按 style.fill/color 回显 aria-pressed；
 * 字号/作用域 select 回显当前值；清空选择（点空白画布）→ 样式区 fieldset 置灰
 * （disabled）+ 提示「选中节点后设置样式」；切换选中节点即时刷新。
 *
 * 复用 rich-content.e2e 的登录/种子文档模式（新手机号注册即赠 3 个种子文件；
 * 「本周计划」树：root 下有 周一~周五，周三 有子节点 方案评审）。
 */

const RED = '#f53f3f';

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

async function selectNodeByText(page: Page, text: string): Promise<void> {
  await page.locator('.editor-canvas svg .gm-text', { hasText: text }).click();
}

/** 打开工具栏「格式」右列样式面板（M7b-R6：右列默认不渲染，点格式开）。 */
async function openFormatPanel(page: Page) {
  await page.getByTestId('format-toggle').click();
  const panel = page.getByTestId('rich-panel');
  await expect(panel).toBeVisible();
  return panel;
}

function nodeGroup(page: Page, text: string) {
  return page.locator('.editor-canvas svg g[data-node-id]').filter({ hasText: text });
}

// 用例 1：选 A（周三）设填充红 → 色钮回显 pressed 且画布 rect 变红；字号回显；
// 切换到 B（周五，未设样式）→ 无任何色钮 pressed、面板可用；点空白画布 →
// 面板按「外点关闭」收起（2026-09-28 走查语义）+ 清空选择；重开面板 → 样式区
// 置灰（disabled）+ 提示「选中节点后设置样式」。
test('格式面板：填充色钮随选中回显 pressed，画布点击收面板，空选重开置灰', async ({ page }) => {
  await openSeedDoc(page, '本周计划');

  // —— A：周三（有子节点 方案评审）——
  await selectNodeByText(page, '周三');
  const panel = await openFormatPanel(page);
  const section = panel.getByTestId('style-section');
  await expect(section).toBeVisible();
  // fieldset 非 Playwright 可禁用件集（按钮/输入等）成员，启用态以内部控件为准
  await expect(panel.getByTestId('font-size-select')).toBeEnabled();
  await panel.getByTitle('填充-红').click();
  // 面板回显：填充-红钮 pressed、其余填充钮不 pressed；画布本节点 rect 变红
  await expect(panel.getByTitle('填充-红')).toHaveAttribute('aria-pressed', 'true');
  await expect(panel.getByTitle('填充-蓝')).toHaveAttribute('aria-pressed', 'false');
  await expect(nodeGroup(page, '周三').locator('rect')).toHaveAttribute('fill', RED);
  // 字号回显：设 24 后 select 显示 24（style 存字符串，option 值同为字符串）
  await panel.getByTestId('font-size-select').selectOption('24');
  await expect(panel.getByTestId('font-size-select')).toHaveValue('24');
  await expect(nodeGroup(page, '周三').locator('.gm-text')).toHaveAttribute('font-size', '24');

  // —— B：周五（画布点击命中「弹层外点」语义：面板收起，选中照常切换）——
  await selectNodeByText(page, '周五');
  await expect(panel).toHaveCount(0);
  await openFormatPanel(page);
  await expect(panel.getByTestId('font-size-select')).toBeEnabled();
  await expect(panel.getByTitle('填充-红')).toHaveAttribute('aria-pressed', 'false');
  await expect(panel.getByTitle('文字-红')).toHaveAttribute('aria-pressed', 'false');
  // 两排色板共 16 钮均不 pressed
  await expect(panel.locator('.swatch[aria-pressed="true"]')).toHaveCount(0);
  await expect(panel.getByTestId('font-size-select')).toHaveValue('');

  // —— 清空选择：点空白画布（角落，远离自适应居中的内容）→ 面板收起 + 清选；
  //     重开面板 → 样式区置灰 + 提示 ——
  await page.locator('.editor-canvas svg').click({ position: { x: 6, y: 6 } });
  await expect(panel).toHaveCount(0);
  await openFormatPanel(page);
  // fieldset 自身断言 disabled 属性；禁用级联以内部控件 toBeDisabled 双重钉死
  await expect(section).toHaveAttribute('disabled', '');
  await expect(panel.getByTestId('font-size-select')).toBeDisabled();
  await expect(panel.getByTitle('填充-红')).toBeDisabled();
  await expect(panel.getByTestId('style-hint')).toBeVisible();
  await expect(panel.getByTestId('style-hint')).toHaveText('选中节点后设置样式');
  // 重新选 A：画布点击会再收面板 → 重开面板后回显恢复（红钮 pressed 复现）
  await page.getByTestId('format-toggle').click(); // 收起（toggle）
  await selectNodeByText(page, '周三');
  await openFormatPanel(page);
  await expect(panel.getByTestId('font-size-select')).toBeEnabled();
  await expect(panel.getByTitle('填充-红')).toHaveAttribute('aria-pressed', 'true');
});

// 用例 2：文字色回显——设文字-蓝后色钮 pressed；默认（无值）时全不 pressed；
// 切节点（画布点击收面板）重开后回显即时刷新（不残留上一节点的 pressed）。
test('格式面板：文字色钮随选中回显 pressed', async ({ page }) => {
  await openSeedDoc(page, '本周计划');
  await selectNodeByText(page, '周一');
  const panel = await openFormatPanel(page);
  await expect(panel.getByTitle('文字-蓝')).toHaveAttribute('aria-pressed', 'false');
  await panel.getByTitle('文字-蓝').click();
  await expect(panel.getByTitle('文字-蓝')).toHaveAttribute('aria-pressed', 'true');
  await expect(panel.getByTitle('文字-红')).toHaveAttribute('aria-pressed', 'false');
  // 同面板切到未设样式的节点：画布点击收面板 → 重开后回显随新节点
  await selectNodeByText(page, '周五');
  await expect(panel).toHaveCount(0);
  await openFormatPanel(page);
  await expect(panel.getByTitle('文字-蓝')).toHaveAttribute('aria-pressed', 'false');
  // 切回 周一：回显恢复 pressed（选中态画布切换）
  await page.getByTestId('format-toggle').click();
  await selectNodeByText(page, '周一');
  await openFormatPanel(page);
  await expect(panel.getByTitle('文字-蓝')).toHaveAttribute('aria-pressed', 'true');
});
