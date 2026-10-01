import { expect, test, type Page } from '@playwright/test';

/**
 * 简洁模式（M7b 补课，mindgrid 账号级显示偏好「脑图简洁模式」移植）E2E。
 *
 * 流程：新建带描述 + 任务状态/进度的节点（任务面板写入）→ 详细模式默认显示
 * gm-desc 第二行 / 状态色条 / 任务行 → 点 compact-toggle → 断言三者消失、节点盒
 * 变矮、进度内联小字出现 → 再点恢复 → 断言回来、盒高还原；刷新后偏好保持
 * （localStorage `gmind.compact`，账号级显示偏好、不入文档数据）。
 *
 * 复用 M0 登录模式：新手机号注册即赠 3 个种子文件（helper 内联自 editor.e2e.spec.ts），
 * 用例打开种子文件「本周计划」。
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
async function openSeedDoc(page: Page, title: string): Promise<void> {
  await registerAndLogin(page);
  await page.locator('.file-list li', { hasText: title }).click();
  await expect(page).toHaveURL(/\/edit\//);
  await expect(page.locator('.editor-canvas svg .gm-text', { hasText: title })).toBeVisible();
}

/**
 * 惰性补开首键（带重试，同 editor.e2e 纪律）：Tab 后盒子未就绪时补开按键被保留
 * 待重试——重试按 ASCII 首键至编辑框出现，首键即占位字符（随后退格清掉）。
 */
async function pressFirstCharToOpen(page: Page): Promise<void> {
  const editor = page.locator('.gm-text-editor');
  for (let i = 0; i < 20 && (await editor.count()) === 0; i += 1) {
    await page.keyboard.press('x');
    await page.waitForTimeout(25);
  }
  await expect(editor).toBeVisible();
}

/** 经任务面板给当前选中节点写入描述 + 状态 doing + 进度 50（即改即存）。 */
async function fillTaskFields(page: Page): Promise<void> {
  await page.getByTestId('task-toggle').click();
  await expect(page.getByTestId('task-panel')).toBeVisible();
  // 面板绑定当前选中节点（Tab 刚建的「写周报」），防写错目标
  await expect(page.getByTestId('task-panel-title')).toHaveText('写周报');
  await page.getByTestId('task-panel-desc').fill('本周五前完成周报初稿');
  await page.getByTestId('task-panel-desc').blur(); // 描述失焦提交
  await page.getByTestId('task-panel-status-doing').click();
  await page.getByTestId('task-panel-progress').fill('50');
  await page.getByTestId('task-panel-progress').press('Enter'); // 进度 Enter 提交
}

test('简洁模式：切换隐藏描述/状态条/任务行并内联进度、盒高变小，再点恢复，刷新保持偏好', async ({
  page,
}) => {
  await openSeedDoc(page, '本周计划');
  // root 为默认选中：Tab 立即落位「新主题」节点（惰性，不开框），改名「写周报」
  await page.keyboard.press('Tab');
  await expect(page.locator('.editor-canvas svg .gm-text', { hasText: '新主题' })).toBeVisible();
  await pressFirstCharToOpen(page);
  await page.keyboard.press('Backspace'); // 清占位首键
  await page.keyboard.insertText('写周报');
  await page.keyboard.press('Enter'); // 标题框 Enter → 切描述框（此刻仍详细模式=双框）
  await page.keyboard.press('Enter'); // 描述框留空 → 提交两者
  await expect(page.locator('.gm-text-editor')).toHaveCount(0);

  await fillTaskFields(page);
  const node = page.locator('.editor-canvas svg [data-node-id]', { hasText: '写周报' });

  // —— 详细模式（默认）：描述第二行 + 状态色条 + 任务行进度齐备 ——
  await expect(node.locator('text.gm-desc')).toHaveText('本周五前完成周报初稿');
  await expect(node.locator('rect.gm-task-bar')).toBeVisible(); // doing 蓝条
  await expect(node.locator('text.gm-task-progress')).toHaveText('50%');
  await expect(node.locator('text.gm-task-progress-inline')).toHaveCount(0);
  const rectBefore = await node.locator('rect').first().boundingBox();
  expect(rectBefore).not.toBeNull();

  // —— 点「简洁」：描述/状态条/任务行消失，盒高变小，进度内联标题行右缘 ——
  await page.getByTestId('compact-toggle').click();
  await expect(page.getByTestId('compact-toggle')).toHaveAttribute('aria-pressed', 'true');
  await expect(node.locator('text.gm-desc')).toHaveCount(0);
  await expect(node.locator('rect.gm-task-bar')).toHaveCount(0);
  await expect(node.locator('g.gm-task-row')).toHaveCount(0);
  await expect(node.locator('text.gm-task-progress-inline')).toHaveText('50%');
  const rectCompact = await node.locator('rect').first().boundingBox();
  expect(rectCompact).not.toBeNull();
  expect(rectCompact!.height!).toBeLessThan(rectBefore!.height!);

  // —— 再点「简洁」恢复：描述/状态条回来、内联进度消失、盒高还原 ——
  await page.getByTestId('compact-toggle').click();
  await expect(page.getByTestId('compact-toggle')).toHaveAttribute('aria-pressed', 'false');
  await expect(node.locator('text.gm-desc')).toHaveText('本周五前完成周报初稿');
  await expect(node.locator('rect.gm-task-bar')).toBeVisible();
  await expect(node.locator('text.gm-task-progress')).toHaveText('50%');
  await expect(node.locator('text.gm-task-progress-inline')).toHaveCount(0);
  const rectRestored = await node.locator('rect').first().boundingBox();
  expect(Math.abs(rectRestored!.height! - rectBefore!.height!)).toBeLessThan(0.5);

  // —— 刷新后偏好保持（localStorage 账号级持久，不入文档数据）——
  await page.getByTestId('compact-toggle').click(); // 再开简洁
  await expect(node.locator('text.gm-task-progress-inline')).toHaveText('50%');
  await expect(page.getByTestId('save-status')).toContainText('已保存', { timeout: 15000 });
  await page.reload();
  await expect(page.locator('.editor-canvas svg .gm-text', { hasText: '写周报' })).toBeVisible();
  await expect(page.getByTestId('compact-toggle')).toHaveAttribute('aria-pressed', 'true');
  const nodeAfterReload = page.locator('.editor-canvas svg [data-node-id]', { hasText: '写周报' });
  await expect(nodeAfterReload.locator('text.gm-task-progress-inline')).toHaveText('50%');
  await expect(nodeAfterReload.locator('text.gm-desc')).toHaveCount(0);
  await expect(nodeAfterReload.locator('rect.gm-task-bar')).toHaveCount(0);
});

// 简洁模式下的行内编辑只有标题框（2026-10-01 双框改版的单框形态）：无描述框、
// 标题框 Enter 直接提交（无双框流转）——与详细模式的双框行为互为对照。
test('简洁模式：行内编辑只有标题框（无描述框），Enter 直接提交', async ({ page }) => {
  await openSeedDoc(page, '本周计划');
  await page.getByTestId('compact-toggle').click();
  await expect(page.getByTestId('compact-toggle')).toHaveAttribute('aria-pressed', 'true');
  // root 默认选中：Tab 惰性新建 → 敲字补开编辑框
  await page.keyboard.press('Tab');
  await pressFirstCharToOpen(page);
  await page.keyboard.press('Backspace');
  await page.keyboard.insertText('简洁节点');
  await expect(page.locator('.gm-text-editor')).toBeVisible();
  await expect(page.locator('.gm-desc-editor')).toHaveCount(0); // 单框形态：无描述框
  await page.keyboard.press('Enter'); // 单框：Enter 直接提交（不切描述框）
  await expect(page.locator('.gm-text-editor')).toHaveCount(0);
  await expect(page.locator('.editor-canvas svg .gm-text', { hasText: '简洁节点' })).toBeVisible();
});
