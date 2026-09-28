import { expect, test, type Page } from '@playwright/test';

/**
 * 格式刷 E2E — M6 Task 7（企微对标，FR-EDT-016 提前）。
 *
 * 单击刷 = 复制当前选中节点 style+icons 快照 → 光标 copy 提示（body.painter-active）
 * → 点目标节点 = 单事务应用（setStyle 逐键 + setIcon 逐组）并退出；
 * 双击刷 = 粘滞模式（连续应用到逐个点击的节点，Esc / 再点按钮退出）；
 * 无单选点按钮 → toast「请先选中要复制样式的节点」；自刷（源=目标）零写入；
 * 一次 Ctrl+Z 整体回滚单次应用（单事务语义）。
 *
 * 复用 format-panel.e2e 的登录/种子文档模式（「本周计划」树：root 下有
 * 周一/周三/周五，各带一个子节点——周会对齐/方案评审/周报复盘）。撤销用例间以
 * >500ms 间隔隔开相邻写，规避 UndoManager captureTimeout 合并（500ms 内连续
 * user 事务并成一个撤销单元）。
 */

const RED = '#f53f3f';
// 撤销单元分离间隔（> captureTimeout 500ms）
const UNDO_GAP = 600;

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

function nodeGroup(page: Page, text: string) {
  return page.locator('.editor-canvas svg g[data-node-id]').filter({ hasText: text });
}

/** 选中节点并设填充红 + 旗帜红（源格式）。填充红在 RichPanel 样式区，旗帜红经
 *  插入→标记面板路径（2026-09-28 图标区迁出 RichPanel）。 */
async function styleSourceRedFlag(page: Page, text: string) {
  await selectNodeByText(page, text);
  const panel = page.getByTestId('rich-panel');
  await panel.getByTitle('填充-红').click();
  await expect(nodeGroup(page, text).locator('rect')).toHaveAttribute('fill', RED);
  await page.getByTestId('insert-menu').click();
  await page.getByTestId('insert-markers').click();
  const markers = page.getByTestId('marker-panel');
  await expect(markers).toBeVisible();
  await markers.getByTitle('旗帜-红').click();
  await expect(nodeGroup(page, text).locator('.gm-icons')).toHaveText('⚑');
  return panel;
}

// 用例 1（单击）：源 周三 设红+旗 → 单击刷（进入模式：pressed + body 光标 class）
// → 点 周五 → 周五 变红带旗且模式退出；源节点保持原样。
test('格式刷：单击复制选中节点样式，点目标应用后自动退出', async ({ page }) => {
  await openSeedDoc(page, '本周计划');
  await styleSourceRedFlag(page, '周三');

  const painterBtn = page.getByTestId('format-painter');
  await painterBtn.click();
  // 模式激活：按钮 pressed + body.painter-active（画布 copy 光标提示钩子）
  await expect(painterBtn).toHaveAttribute('aria-pressed', 'true');
  await expect(page.locator('body')).toHaveClass(/painter-active/);

  // 点目标 周五：应用格式（不让位给选中切换）
  await selectNodeByText(page, '周五');
  await expect(nodeGroup(page, '周五').locator('rect')).toHaveAttribute('fill', RED);
  await expect(nodeGroup(page, '周五').locator('.gm-icons')).toHaveText('⚑');
  // 单发模式：应用一次即退出（按钮回落、光标提示摘除）
  await expect(painterBtn).toHaveAttribute('aria-pressed', 'false');
  await expect(page.locator('body')).not.toHaveClass(/painter-active/);
  // 源节点保持红+旗（复制不搬移）
  await expect(nodeGroup(page, '周三').locator('rect')).toHaveAttribute('fill', RED);
  await expect(nodeGroup(page, '周三').locator('.gm-icons')).toHaveText('⚑');
});

// 用例 2（粘滞 + Esc）：双击刷 → 连点 周一、周五 都应用；Esc 退出后再点
// 周一对齐（周一子节点，未刷到——顺带钉死单节点作用域）不变。
test('格式刷：双击进入粘滞模式连续应用，Esc 退出后点击不再应用', async ({ page }) => {
  await openSeedDoc(page, '本周计划');
  await styleSourceRedFlag(page, '周三');

  const painterBtn = page.getByTestId('format-painter');
  await painterBtn.dblclick();
  await expect(painterBtn).toHaveAttribute('aria-pressed', 'true');
  await expect(page.locator('body')).toHaveClass(/painter-active/);

  // 粘滞：连续两个目标都应用，模式保持
  await selectNodeByText(page, '周一');
  await expect(nodeGroup(page, '周一').locator('rect')).toHaveAttribute('fill', RED);
  await expect(nodeGroup(page, '周一').locator('.gm-icons')).toHaveText('⚑');
  await expect(painterBtn).toHaveAttribute('aria-pressed', 'true');
  await selectNodeByText(page, '周五');
  await expect(nodeGroup(page, '周五').locator('rect')).toHaveAttribute('fill', RED);
  await expect(nodeGroup(page, '周五').locator('.gm-icons')).toHaveText('⚑');
  await expect(painterBtn).toHaveAttribute('aria-pressed', 'true');

  // Esc 退出：按钮回落、光标提示摘除；再点 周一对齐 不应用（单节点作用域：
  // 粘滞刷了 周一，其子节点 周会对齐 不随刷）
  await page.keyboard.press('Escape');
  await expect(painterBtn).toHaveAttribute('aria-pressed', 'false');
  await expect(page.locator('body')).not.toHaveClass(/painter-active/);
  await selectNodeByText(page, '周会对齐');
  await expect(nodeGroup(page, '周会对齐').locator('rect')).not.toHaveAttribute('fill', RED);
  await expect(nodeGroup(page, '周会对齐').locator('.gm-icons')).toHaveCount(0);
});

// 用例 3（无选中）：清空选择后点刷 → toast 提示，不进入模式。
test('格式刷：无选中节点点按钮给出 toast 提示', async ({ page }) => {
  await openSeedDoc(page, '本周计划');
  // 点空白画布清空选择（远离自适应居中的内容）
  await page.locator('.editor-canvas svg').click({ position: { x: 6, y: 6 } });
  await expect(page.getByTestId('rich-panel').getByTestId('style-hint')).toBeVisible();

  const painterBtn = page.getByTestId('format-painter');
  await painterBtn.click();
  await expect(page.getByTestId('toast')).toHaveText('请先选中要复制样式的节点');
  // 未进入模式
  await expect(painterBtn).toHaveAttribute('aria-pressed', 'false');
});

// 用例 4（自刷 no-op）：源=目标点击零写入——撤销一步应轮到「加旗帜」而不是
// 格式刷事务（若误写入，Ctrl+Z #1 将回滚无可视变化的空应用，旗帜仍在）。
test('格式刷：自刷（源=目标）零写入', async ({ page }) => {
  await openSeedDoc(page, '本周计划');
  // 两个写之间 >500ms，各自独立成撤销单元
  await selectNodeByText(page, '周三');
  const panel = page.getByTestId('rich-panel');
  await panel.getByTitle('填充-红').click();
  await expect(nodeGroup(page, '周三').locator('rect')).toHaveAttribute('fill', RED);
  await page.waitForTimeout(UNDO_GAP);
  await page.getByTestId('insert-menu').click();
  await page.getByTestId('insert-markers').click();
  await page.getByTestId('marker-panel').getByTitle('旗帜-红').click();
  await expect(nodeGroup(page, '周三').locator('.gm-icons')).toHaveText('⚑');
  await page.waitForTimeout(UNDO_GAP);

  // 单击刷 → 点源节点自身：外观不变、模式退出（单发语义）
  const painterBtn = page.getByTestId('format-painter');
  await painterBtn.click();
  await selectNodeByText(page, '周三');
  await expect(painterBtn).toHaveAttribute('aria-pressed', 'false');
  await expect(nodeGroup(page, '周三').locator('rect')).toHaveAttribute('fill', RED);
  await expect(nodeGroup(page, '周三').locator('.gm-icons')).toHaveText('⚑');

  // 撤销一步 = 撤「加旗帜」（自刷零写入的直接证据：旗帜消失、红色保留）
  await page.keyboard.press('Control+Z');
  await expect(nodeGroup(page, '周三').locator('.gm-icons')).toHaveCount(0);
  await expect(nodeGroup(page, '周三').locator('rect')).toHaveAttribute('fill', RED);
});

// 用例 5（单事务撤销）：单击应用后一次 Ctrl+Z 同时回滚样式与图标
// （fill 回默认且旗帜消失——若拆多事务则需两次撤销）。
test('格式刷：单次应用可被一次 Ctrl+Z 整体回滚', async ({ page }) => {
  await openSeedDoc(page, '本周计划');
  await selectNodeByText(page, '周三');
  const panel = page.getByTestId('rich-panel');
  await panel.getByTitle('填充-红').click();
  await page.waitForTimeout(UNDO_GAP);
  await page.getByTestId('insert-menu').click();
  await page.getByTestId('insert-markers').click();
  await page.getByTestId('marker-panel').getByTitle('旗帜-红').click();
  // 与应用隔开 >500ms：格式刷事务独立成撤销单元
  await page.waitForTimeout(UNDO_GAP);

  await page.getByTestId('format-painter').click();
  await selectNodeByText(page, '周五');
  await expect(nodeGroup(page, '周五').locator('rect')).toHaveAttribute('fill', RED);
  await expect(nodeGroup(page, '周五').locator('.gm-icons')).toHaveText('⚑');

  // 一次 Ctrl+Z：样式 + 图标一并回滚
  await page.keyboard.press('Control+Z');
  await expect(nodeGroup(page, '周五').locator('rect')).not.toHaveAttribute('fill', RED);
  await expect(nodeGroup(page, '周五').locator('.gm-icons')).toHaveCount(0);
  // 源节点不受撤销影响（事务只覆盖目标写入）
  await expect(nodeGroup(page, '周三').locator('rect')).toHaveAttribute('fill', RED);
  await expect(nodeGroup(page, '周三').locator('.gm-icons')).toHaveText('⚑');
});
