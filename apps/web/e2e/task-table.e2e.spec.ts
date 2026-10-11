import { expect, test, type Page } from '@playwright/test';

/**
 * 任务表格视图 E2E —— 2026-10-01 需求方反馈包（表格两题）：
 *
 * 1. 描述第二行（反馈任务 2）：标题格内标题行下方渲染描述第二行（.tt-title-desc，
 *    12px 灰字、单行省略、title 悬停看全文；有描述才渲染，无独立描述列——对齐
 *    mindgrid TreeTable 的 QuickEditor 两行式行内编辑）。
 * 2. 标题格标记单源渲染（反馈任务 1）：标记 chip 全部经 MarkerChip（engine
 *    drawMarkerBadge SVG 徽章，<svg viewBox="0 0 14 14"> + 定宽高 + flex
 *    收缩保护）——钉定「圆形图标不扁、完整显示」：chip 渲染盒恒 14×14，自定义
 *    kind（五角星等）走 SVG path 而非文本回落；「未开始」播放环同径。
 * 3. 双击收窄（反馈任务 5）：行其他区域（行号/状态等非标题格）双击一律无操作
 *    （不进标题编辑、父行不折叠——旧行为双击行折叠已移除）；仅双击标题文字
 *    进入行内编辑。
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

/** 画布视图选中节点（标记面板入口在画布/表格共用工具栏，选种走画布语义）。 */
async function selectNodeByText(page: Page, text: string): Promise<void> {
  await page.locator('.editor-canvas svg .gm-text', { hasText: text }).click();
}

/** 打开 TaskPanel 标记区块并展开「其他」折叠组（2026-10-10 内嵌化：优先级/进度
 *  平铺常显、其余组折叠），返回任务面板。TaskPanel 已开时跳过 task-toggle。 */
async function openMarkerPanel(page: Page) {
  if ((await page.getByTestId('task-panel').count()) === 0) await page.getByTestId('task-toggle').click();
  const panel = page.getByTestId('task-panel');
  await expect(panel).toBeVisible();
  const toggle = panel.getByTestId('task-panel-marker-toggle-other');
  if ((await toggle.getAttribute('aria-expanded')) === 'false') await toggle.click();
  return panel;
}

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

// 用例 2（反馈任务 1）：标题格标记与画布/面板单源（drawMarkerBadge SVG）——
// 画布给叶子节点 周会对齐 挂三组标记（优先级 P0 圆徽 / 进度「未开始」播放环 /
// 其他 五角星），切表格后钉定：chip 是 14×14 定尺寸 SVG（不扁），自定义 kind 走
// path 而非文本回落。（2026-10-10 内嵌化：进度行 radio+联动，父节点只读——种进度
// 档位须在叶子节点上，种子 周一/三/五 全为父级。）
test('标题格标记单源渲染：SVG 徽章 14×14 不扁，自定义 kind 不回落文本', async ({ page }) => {
  test.setTimeout(90_000);
  // 画布视图种标记（任务面板内嵌行写入；单组替换/多组叠加语义不变）
  await registerAndLogin(page);
  await page.locator('.file-list li', { hasText: '本周计划' }).click();
  await expect(page).toHaveURL(/\/edit\//);
  await expect(page.locator('.editor-canvas svg .gm-text', { hasText: '周一' })).toBeVisible();
  await selectNodeByText(page, '周会对齐');
  const panel = await openMarkerPanel(page);
  await panel.getByTestId('marker-priority-p0').click(); // circleText 圆徽（此前被压扁的形）
  await panel.getByTestId('marker-progress-none').click(); // progressNone 播放环（radio 点档位）
  await panel.getByTestId('marker-other-important').click(); // star 自定义 kind（此前回落 ★ 文本）
  await page.getByTestId('task-toggle').click(); // 关任务面板再切视图
  await page.getByTestId('view-tab-table').click();
  await expect(page.locator('.task-table-root')).toBeVisible();

  const table = page.locator('.task-table-root');
  const markers = table.locator('tbody tr').filter({ hasText: '周会对齐' }).first().locator('.tt-markers');
  // 三枚 chip 都在（data-marker-* 与画布 g.gm-marker-badge 同名属性）
  for (const v of ['p0', 'none', 'important']) {
    await expect(markers.locator(`[data-marker-value="${v}"]`)).toHaveCount(1);
  }
  // 单源几何：每枚 chip 都是 <svg viewBox="0 0 14 14"> 包 engine 徽章（非手写文本 chip）
  for (const v of ['p0', 'none', 'important']) {
    const svg = markers.locator(`[data-marker-value="${v}"] svg`);
    await expect(svg).toHaveCount(1);
    await expect(svg).toHaveAttribute('viewBox', '0 0 14 14');
  }
  // 「不扁」断言：渲染盒恒 14×14（旧手写 chip 无定宽高，圆徽靠 11px 文本行高压瘪）
  const box = await markers.locator('[data-marker-value="p0"]').boundingBox();
  expect(box?.width).toBe(14);
  expect(box?.height).toBe(14);
  const noneBox = await markers.locator('[data-marker-value="none"]').boundingBox();
  expect(noneBox?.width).toBe(14);
  expect(noneBox?.height).toBe(14);
  // 自定义 kind：五角星走 SVG path（旧实现无分支，回落彩色 ★ 字符）
  await expect(markers.locator('[data-marker-value="important"] svg path')).toHaveCount(1);
  // 悬停 title 与画布 SVG <title> 同文案（目录中文 label 单源）
  await expect(markers.locator('[data-marker-value="p0"]')).toHaveAttribute('title', '优先级 P0');
});

// 用例 3（反馈任务 5）：双击收窄——行其他区域双击无操作（不进标题编辑、父行不
// 折叠），仅双击标题文字进入行内编辑；右键菜单/单击选中交互不受影响。
test('双击收窄：行其他区域双击无操作（不进编辑、不折叠），仅标题文字双击进编辑', async ({ page }) => {
  test.setTimeout(90_000);
  await openSeedDocTable(page, '本周计划');

  const table = page.locator('.task-table-root');
  const row = table.locator('tbody tr').filter({ hasText: '周一' }).first();
  const titleInput = page.getByTestId('table-title-input');

  // 初始 6 行（周一/周三/周五 各带 1 子任务），无编辑器
  await expect(page.getByTestId('table-row-count')).toHaveText('6 行');
  await expect(titleInput).toHaveCount(0);

  // 双击行号格（行其他区域）：不进编辑；旧行为「双击父行折叠」已移除 → 子行仍在
  await row.locator('td.tt-rownum').dblclick();
  await expect(titleInput).toHaveCount(0);
  await expect(table.locator('tbody tr').filter({ hasText: '周会对齐' })).toHaveCount(1);

  // 双击状态格（统一列模型 data-col-key 定位）：同样不进标题编辑
  await row.locator('td[data-col-key="status"]').dblclick();
  await expect(titleInput).toHaveCount(0);

  // 双击标题文字 → 两行式行内编辑（QuickEditor）
  await row.locator('.tt-title-text').dblclick();
  await expect(titleInput).toBeVisible();
  await expect(titleInput).toHaveValue('周一');
  await titleInput.press('Escape'); // 取消不写，行数不变
  await expect(titleInput).toHaveCount(0);
  await expect(page.getByTestId('table-row-count')).toHaveText('6 行');
});
