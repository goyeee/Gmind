import { expect, test, type Page } from '@playwright/test';

/**
 * emoji 表情区 E2E — M6 Task 5（企微对标）；2026-10-10 标记内嵌化起表情区为
 * 任务面板「优先级 / 标记」区块的「表情」折叠组（testid 契约：
 * task-panel-marker-group-emoji / marker-emoji-{char}，单页 28 枚）。
 *
 * 复用 rich-content 的登录/种子文件模式（新手机号注册即赠 3 个种子文件）。
 * 面板语义（M7b-W1/W3 冻结）：emoji 为独立 multi 组——点 emoji = core toggle
 * （再点同 emoji = 取消），与 flag 等组并存互不影响；画布渲染层为
 * .gm-markers 容器内逐值 g.gm-marker-badge[data-marker-value]（组序 emoji 在末位）。
 */

async function registerAndLogin(page: Page): Promise<void> {
  await page.goto('/login');
  const phone = '138' + String(Math.floor(10000000 + Math.random() * 89999999));
  await page.getByPlaceholder('手机号').fill(phone);
  await page.getByPlaceholder('验证码（开发环境固定 123456）').fill('123456');
  await page.getByRole('button', { name: '登录', exact: true }).click();
  await expect(page).toHaveURL(/\/workspace/);
  await expect(page.getByTestId('mine-grid').getByTestId('file-card')).toHaveCount(3);
}

async function openSeedDoc(page: Page, title: string): Promise<void> {
  await registerAndLogin(page);
  await page.getByTestId('file-card').filter({ hasText: title }).first().click();
  await expect(page).toHaveURL(/\/edit\//);
  await expect(page.locator('.editor-canvas svg .gm-text', { hasText: title })).toBeVisible();
}

async function selectNodeByText(page: Page, text: string): Promise<void> {
  await page.locator('.editor-canvas svg .gm-text', { hasText: text }).click();
}

function nodeGroup(page: Page, text: string) {
  return page.locator('.editor-canvas svg g[data-node-id]').filter({ hasText: text });
}

function markerBadgeByValue(page: Page, text: string, value: string) {
  return nodeGroup(page, text).locator(`.gm-markers .gm-marker-badge[data-marker-value="${value}"]`);
}

/** 打开 TaskPanel 并展开「表情」折叠组（2026-10-10 标记内嵌化），返回表情组网格。
 *  TaskPanel 已开时跳过 task-toggle（toggle 语义，再点会收面板）。 */
async function openEmojiArea(page: Page) {
  if ((await page.getByTestId('task-panel').count()) === 0) await page.getByTestId('task-toggle').click();
  const toggle = page.getByTestId('task-panel-marker-toggle-emoji');
  await expect(toggle).toBeVisible();
  if ((await toggle.getAttribute('aria-expanded')) === 'false') await toggle.click();
  const grid = page.getByTestId('task-panel-marker-group-emoji');
  await expect(grid.locator('[data-testid^="marker-emoji-"]').first()).toBeVisible();
  return grid;
}

// 用例 1（主链路）：选节点 → 表情折叠组选 😊 → 节点 .gm-markers 出现 😊 徽标 →
// 保存已落库 → reload 仍在 → 再点同 emoji = 取消（multi 组 core toggle）。
test('表情区：选 😊 渲染进节点标记徽标，刷新仍在，再点同 emoji 取消', async ({ page }) => {
  await openSeedDoc(page, '本周计划');
  await selectNodeByText(page, '周一');
  const picker = await openEmojiArea(page);
  // 表情组 28 枚平铺（旧 表情/手势/符号 三页签已并入）
  await expect(picker.locator('[data-testid^="marker-emoji-"]')).toHaveCount(28);
  await picker.getByTestId('marker-emoji-😊').click();
  await expect(markerBadgeByValue(page, '周一', '😊')).toHaveCount(1);
  await expect(page.getByTestId('save-status')).toHaveText(/已保存/);
  // 刷新（持久化 + 重连协同）：emoji 仍在节点标记槽；重选该节点再操作
  await page.reload();
  await expect(page.locator('.editor-canvas svg .gm-text', { hasText: '本周计划' })).toBeVisible();
  await expect(markerBadgeByValue(page, '周一', '😊')).toHaveCount(1);
  await selectNodeByText(page, '周一');
  const picker2 = await openEmojiArea(page);
  // 再点同 emoji → 取消：槽位清空（面板常开，选中不收起）
  await expect(picker2.getByTestId('marker-emoji-😊')).toHaveAttribute('aria-pressed', 'true');
  await picker2.getByTestId('marker-emoji-😊').click();
  await expect(markerBadgesOf(page, '周一')).toHaveCount(0);
});

/** 节点标记徽标集合。 */
function markerBadgesOf(page: Page, text: string) {
  return nodeGroup(page, text).locator('.gm-markers .gm-marker-badge');
}

// 用例 2：emoji 与旗帜并存互不影响（组间独立）；收起折叠组不影响已写标记与选中。
test('表情区：emoji 与旗帜并存互不影响，收起折叠组不清标记', async ({ page }) => {
  await openSeedDoc(page, '本周计划');
  await selectNodeByText(page, '周一');
  const picker = await openEmojiArea(page);
  // 旗帜：展开旗帜折叠组（与表情异组）
  const flagToggle = page.getByTestId('task-panel-marker-toggle-flag');
  await flagToggle.click();
  await page.getByTestId('marker-flag-flag').click();
  await expect(markerBadgeByValue(page, '周一', 'flag')).toHaveCount(1);
  await picker.getByTestId('marker-emoji-👍').click();
  // 组序固定（emoji 在末位）：旗帜在前、emoji 在后
  await expect(markerBadgesOf(page, '周一')).toHaveCount(2);
  // 取消 emoji（面板常开，直接再点同 emoji）：旗帜仍在
  await picker.getByTestId('marker-emoji-👍').click();
  await expect(markerBadgesOf(page, '周一')).toHaveCount(1);
  await expect(markerBadgeByValue(page, '周一', 'flag')).toHaveCount(1);
  // 收起/重开表情组：已写标记不受影响、选中未丢
  await page.getByTestId('task-panel-marker-toggle-emoji').click(); // 收起
  await expect(picker.getByTestId('marker-emoji-😊')).toHaveCount(0);
  await expect(markerBadgeByValue(page, '周一', 'flag')).toHaveCount(1);
});
