import { expect, test, type Page } from '@playwright/test';

/**
 * 节点属性快捷面板 E2E（2026-10-10 需求方裁定，mindgrid「单击选中 · 再击开属性」
 * 同款，spec 2026-10-10-node-props-and-task-visual-design §三）：
 *
 * - 选中节点后**再次点击**同一节点 → 打开右侧 TaskPanel（取代已删除的右键
 *   「任务设置」/`,` 快速卡；只开不 toggle——开着再点保持开）；
 * - 多选中的点击先收敛为单选，不当场开面板；
 * - 点其他节点：面板不收（跟随选中切换内容，同 mindgrid）；
 * - 点**空白**画布：面板关闭（同裁定改判 10-09「点空白转空态不关闭」——格式/
 *   任务面板恢复外点即关；格式面板侧断言在 format-panel.e2e.spec.ts 用例 1）。
 *
 * 复用 M0 登录模式：新手机号注册即赠 3 个种子文件。
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

async function clickNode(page: Page, text: string): Promise<void> {
  await page.locator('.editor-canvas svg .gm-text', { hasText: text }).click();
}

test('再点已选中节点 → 开 TaskPanel（只开不 toggle）；点其他节点跟随；点空白关闭', async ({
  page,
}) => {
  await openSeedDoc(page, '本周计划');

  // 第一次点击 = 选中（不开面板）
  await clickNode(page, '周一');
  await expect(page.getByTestId('task-panel')).toHaveCount(0);

  // 再点同一节点（已是唯一选中）→ 开 TaskPanel，标题跟随选中节点
  await clickNode(page, '周一');
  const panel = page.getByTestId('task-panel');
  await expect(panel).toBeVisible();
  await expect(page.getByTestId('task-panel-title')).toHaveText('周一');

  // 只开不 toggle：开着再点同一节点 → 保持开
  await clickNode(page, '周一');
  await expect(panel).toBeVisible();

  // 点其他节点：面板不收（点节点不关——跟随选中切换内容，同 mindgrid）
  await clickNode(page, '周三');
  await expect(panel).toBeVisible();
  await expect(page.getByTestId('task-panel-title')).toHaveText('周三');

  // 点空白画布（角落，远离自适应居中的内容）→ 面板关闭（外点即关改判）
  await page.locator('.editor-canvas svg').click({ position: { x: 6, y: 6 } });
  await expect(panel).toHaveCount(0);
});

test('多选中点击先收敛为单选，不当场开 TaskPanel', async ({ page }) => {
  await openSeedDoc(page, '本周计划');
  // 框选多选：空白按下拖出覆盖 周一/周三 的矩形（无修饰左拖 = 框选，M7b-W3 裁定）
  const svg = page.locator('.editor-canvas svg');
  const box = (await svg.boundingBox())!;
  await page.mouse.move(box.x + 6, box.y + 6);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width - 6, box.y + box.height - 6, { steps: 8 });
  await page.mouse.up();
  // 多选形成后点其中任一节点 → 收敛为单选，不开面板
  await clickNode(page, '周一');
  await expect(page.getByTestId('task-panel')).toHaveCount(0);
  // 再点（已是唯一选中）→ 开
  await clickNode(page, '周一');
  await expect(page.getByTestId('task-panel')).toBeVisible();
});
