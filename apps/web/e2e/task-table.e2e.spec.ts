import { expect, test, type Page } from '@playwright/test';

/**
 * 任务表格视图 E2E —— 描述第二行（2026-10-01 需求方反馈任务 2）。
 *
 * 背景：表格 QuickEditor（两行式行内编辑）早已能编辑描述（table-desc-input），
 * 但标题格不展示——需求方反馈「编辑得了看不见」。本 spec 钉定展示形态：
 * 标题格内标题行下方渲染描述第二行（.tt-title-desc，12px 灰字、单行省略、
 * title 悬停看全文；有描述才渲染，无独立描述列——对齐 mindgrid TreeTable）。
 *
 * 复用既有登录/种子文件模式（新手机号注册即赠 3 个种子文件）。
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

async function openSeedDocTable(page: Page, title: string): Promise<void> {
  await registerAndLogin(page);
  await page.locator('.file-list li', { hasText: title }).click();
  await expect(page).toHaveURL(/\/edit\//);
  await expect(page.locator('.editor-canvas svg .gm-text', { hasText: title })).toBeVisible();
  // 切到表格视图（表格常驻挂载，切换仅显隐）
  await page.getByTestId('view-tab-table').click();
  await expect(page.locator('.task-table-root')).toBeVisible();
}

const DESC = '全天站会对齐进度，会后同步纪要';

test('表格描述第二行：行内编辑写入描述 → 标题格下方灰字可见，无描述行不渲染', async ({ page }) => {
  test.setTimeout(90_000);
  await openSeedDocTable(page, '本周计划');

  const table = page.locator('.task-table-root');
  // 初始：种子文档无描述 → 不渲染任何描述行（「有描述才渲染」）
  await expect(table.locator('.tt-title-desc')).toHaveCount(0);

  // 双击 周一 标题格 → 两行式行内编辑 → Tab 切描述框填写 → Enter 提交
  await table.locator('.tt-title-text', { hasText: '周一' }).dblclick();
  const titleInput = page.getByTestId('table-title-input');
  await expect(titleInput).toHaveValue('周一');
  const descInput = page.getByTestId('table-desc-input');
  await expect(descInput).toBeVisible();
  await descInput.fill(DESC);
  await descInput.press('Enter');
  await expect(page.getByTestId('table-desc-input')).toHaveCount(0);

  // 描述第二行可见：文本单行展示、title 悬停携带全文（截断兜底语义）
  const descLine = table.locator('.tt-title-desc', { hasText: DESC });
  await expect(descLine).toHaveCount(1);
  await expect(descLine).toBeVisible();
  await expect(descLine).toHaveAttribute('title', DESC);
  // 仍只有这一行有描述（其余行不渲染描述行）
  await expect(table.locator('.tt-title-desc')).toHaveCount(1);
});
