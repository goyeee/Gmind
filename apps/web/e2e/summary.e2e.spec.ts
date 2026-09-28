import { expect, test, type Page } from '@playwright/test';

/**
 * 概要（summary bracket）E2E — M6 Task 6（企微对标，FR-EDT-023 提前）。
 *
 * 契约（testid 冻结）：context-menu 既有容器；menu-add-summary / menu-remove-summary
 * （右键菜单项）；summary-label-input（bracket 标签位置的行内编辑输入框）；
 * 画布侧 g[data-summary-id]（引擎渲染层）+ .gm-summary-label。
 *
 * 种子「本周计划」树：本周计划 → 周一(周会对齐) / 周三(方案评审) / 周五(周报复盘)
 * —— 周一/周三是 root 下连续兄弟，周一/周五不连续（隔周三）。
 *
 * 覆盖：
 * - Ctrl+点击 加选连续兄弟（周一+周三）→ 右键选中成员之一 → 「添加概要」→
 *   默认标签「概要」的行内编辑器出现 → 改「工作日」Enter → bracket+标签出现；
 * - 点标签再编辑 → 改「上半周」；
 * - 删除片段成员（周三）→ bracket 收敛到存活段（周一），label 保留；
 * - 撤销（含删除/标签编辑/建概要的撤销栈）至概要消失；
 * - 非法选区（周一+周五 非连续；跨父）→ 「添加概要」→ toast 原因+下一步；
 * - 右键 bracket → 「删除概要」→ bracket 消失。
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

function summaryG(page: Page): ReturnType<Page['locator']> {
  return page.locator('.editor-canvas svg [data-summary-id]');
}

function nodeText(page: Page, text: string): ReturnType<Page['locator']> {
  return page.locator('.editor-canvas svg .gm-text', { hasText: text });
}

/** 加选键：macOS 上 Ctrl+左键被浏览器原生征用为右键（contextmenu），等价键为 Cmd。 */
const mod = process.platform === 'darwin' ? 'Meta' : 'Control';

test('概要主流程：加选连续兄弟 → 添加概要 → 改标签 → 删成员收敛 → 撤销概要', async ({ page }) => {
  test.setTimeout(90_000);
  await openSeedDoc(page, '本周计划');

  // Ctrl+点击加选周一、周三（root 下连续兄弟；首击普通点击选中周一）
  await nodeText(page, '周一').click();
  await nodeText(page, '周三').click({ modifiers: [mod] });
  await expect(page.locator('.editor-canvas svg g.gm-selected')).toHaveCount(2);

  // 右键选中成员之一（多选保持）→ 菜单含「添加概要」
  await nodeText(page, '周三').click({ button: 'right' });
  const menu = page.getByTestId('context-menu');
  await expect(menu).toBeVisible();
  await expect(page.getByTestId('menu-add-summary')).toBeVisible();

  // 添加概要：立即建默认标签「概要」并进入行内编辑 → 改「工作日」Enter 提交
  await page.getByTestId('menu-add-summary').click();
  const input = page.getByTestId('summary-label-input');
  await expect(input).toBeVisible();
  await expect(input).toHaveValue('概要');
  await input.fill('工作日');
  await page.keyboard.press('Enter');
  await expect(input).toHaveCount(0);

  // bracket + 标签出现
  await expect(summaryG(page)).toHaveCount(1);
  await expect(page.locator('.editor-canvas svg .gm-summary-label')).toHaveText('工作日');

  // 点标签再编辑 → 改「上半周」
  await page.locator('.editor-canvas svg .gm-summary-label').click();
  await expect(page.getByTestId('summary-label-input')).toHaveValue('工作日');
  await page.getByTestId('summary-label-input').fill('上半周');
  await page.keyboard.press('Enter');
  await expect(page.locator('.editor-canvas svg .gm-summary-label')).toHaveText('上半周');

  // 删除片段成员（周三）：bracket 收敛到存活段（周一），label 保留
  await nodeText(page, '周三').click();
  await page.keyboard.press('Delete');
  await expect(nodeText(page, '周三')).toHaveCount(0);
  await expect(summaryG(page)).toHaveCount(1);
  await expect(page.locator('.editor-canvas svg .gm-summary-label')).toHaveText('上半周');
  await expect(nodeText(page, '周一')).toBeVisible(); // 周一仍在片段内

  // 撤销至概要消失（栈内含：建概要 / 两次标签 / 删周三；captureTimeout 可能合并，循环撤销）
  for (let i = 0; i < 6; i += 1) {
    if ((await summaryG(page).count()) === 0) break;
    await page.getByTestId('undo-btn').click();
    await page.waitForTimeout(120);
  }
  await expect(summaryG(page)).toHaveCount(0);
});

test('概要非法选区 toast + 右键 bracket 删除概要', async ({ page }) => {
  test.setTimeout(90_000);
  await openSeedDoc(page, '本周计划');

  // 非连续（周一+周五，隔周三）→ 添加概要 → toast 原因+下一步，且不创建
  await nodeText(page, '周一').click();
  await nodeText(page, '周五').click({ modifiers: [mod] });
  await nodeText(page, '周五').click({ button: 'right' });
  await page.getByTestId('menu-add-summary').click();
  await expect(page.getByTestId('toast')).toContainText('概要需选择同一父节点下的连续节点');
  await expect(summaryG(page)).toHaveCount(0);

  // 跨父（周一 + 周一会子节点）同样拒绝
  await page.locator('.editor-canvas svg .gm-text', { hasText: '周会对齐' }).click();
  await nodeText(page, '周一').click({ modifiers: [mod] });
  await nodeText(page, '周一').click({ button: 'right' });
  await page.getByTestId('menu-add-summary').click();
  await expect(page.getByTestId('toast')).toContainText('概要需选择同一父节点下的连续节点');
  await expect(summaryG(page)).toHaveCount(0);

  // 合法创建（默认标签直接 Enter）→ 右键 bracket 标签 → 「删除概要」→ 消失
  await nodeText(page, '周一').click();
  await nodeText(page, '周三').click({ modifiers: [mod] });
  await nodeText(page, '周三').click({ button: 'right' });
  await page.getByTestId('menu-add-summary').click();
  await page.getByTestId('summary-label-input').press('Enter');
  await expect(summaryG(page)).toHaveCount(1);
  await page.locator('.editor-canvas svg .gm-summary-label').click({ button: 'right' });
  await expect(page.getByTestId('menu-remove-summary')).toBeVisible();
  await page.getByTestId('menu-remove-summary').click();
  await expect(summaryG(page)).toHaveCount(0);
});
