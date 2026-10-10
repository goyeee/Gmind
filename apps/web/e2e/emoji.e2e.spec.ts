import { expect, test, type Page } from '@playwright/test';

/**
 * emoji 表情区 E2E — M6 Task 5（企微对标）；M7b-W3/W1 起表情区位于工具栏「插入」
 * →「表情」锚定弹出层 marker-panel 的表情页签（testid 契约：marker-panel /
 * emoji-picker / marker-emoji-{char}；旧 emoji-tab-{name} 三页签已并入单页 28 枚）。
 *
 * 复用 rich-content 的登录/种子文件模式（新手机号注册即赠 3 个种子文件）。
 * 面板语义（M7b-W1/W3 冻结）：emoji 为独立 multi 组——点 emoji = 批量「全含则移除
 * 否则设置」（再点同 emoji = 取消），与 flag 等组并存互不影响；画布渲染层为
 * .gm-markers 容器内逐值 g.gm-marker-badge[data-marker-value]（组序 emoji 在末位）。
 * Esc / 外点关闭整个插入层（菜单 + 面板）。
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

async function selectNodeByText(page: Page, text: string): Promise<void> {
  await page.locator('.editor-canvas svg .gm-text', { hasText: text }).click();
}

function nodeGroup(page: Page, text: string) {
  return page.locator('.editor-canvas svg g[data-node-id]').filter({ hasText: text });
}

function markerBadgeByValue(page: Page, text: string, value: string) {
  return nodeGroup(page, text).locator(`.gm-markers .gm-marker-badge[data-marker-value="${value}"]`);
}

/** 打开 TaskPanel →「在标记面板中编辑」→ 表情页签（2026-10-10 插入菜单删除后入口），
 *  返回表情页签下的 emoji 网格定位器（emoji-picker testid 不变）。
 *  TaskPanel 已开时跳过 task-toggle（toggle 语义，再点会收面板）。 */
async function openEmojiArea(page: Page) {
  const editBtn = page.getByTestId('task-panel-markers-edit');
  if ((await editBtn.count()) === 0) await page.getByTestId('task-toggle').click();
  await editBtn.click();
  const panel = page.getByTestId('marker-panel');
  await expect(panel).toBeVisible();
  await panel.getByTestId('marker-tab-emoji').click();
  const picker = panel.getByTestId('emoji-picker');
  await expect(picker).toBeVisible();
  return picker;
}

// 用例 1（主链路）：选节点 → 表情面板选 😊 → 节点 .gm-markers 出现 😊 徽标 → 保存
// 已落库 → reload 仍在 → 再点同 emoji = 取消（批量「全含则移除」）。
test('表情区：选 😊 渲染进节点标记徽标，刷新仍在，再点同 emoji 取消', async ({ page }) => {
  await openSeedDoc(page, '本周计划');
  await selectNodeByText(page, '周一');
  const picker = await openEmojiArea(page);
  // 表情页 28 枚单页平铺（旧 表情/手势/符号 三页签已并入）
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

// 用例 2：emoji 与旗帜并存互不影响（组间独立）+ Esc / 外点关闭整个插入层。
test('表情区：emoji 与旗帜并存互不影响；Esc 与外点关闭', async ({ page }) => {
  await openSeedDoc(page, '本周计划');
  await selectNodeByText(page, '周一');
  const panel = page.getByTestId('marker-panel');
  const picker = await openEmojiArea(page);
  // 旗帜在图标页签（插入菜单「图标」入口同面板）：页签内切换，不需重开插入层
  await panel.getByTestId('marker-tab-icon').click();
  await panel.getByTestId('marker-flag-flag').click();
  await expect(markerBadgeByValue(page, '周一', 'flag')).toHaveCount(1);
  await panel.getByTestId('marker-tab-emoji').click();
  await picker.getByTestId('marker-emoji-👍').click();
  // 组序固定（emoji 在末位）：旗帜在前、emoji 在后
  await expect(markerBadgesOf(page, '周一')).toHaveCount(2);
  // 取消 emoji（面板常开，直接再点同 emoji）：旗帜仍在
  await picker.getByTestId('marker-emoji-👍').click();
  await expect(markerBadgesOf(page, '周一')).toHaveCount(1);
  await expect(markerBadgeByValue(page, '周一', 'flag')).toHaveCount(1);
  // Esc 关闭整个插入层（菜单 + 面板）
  await page.keyboard.press('Escape');
  await expect(page.getByTestId('marker-panel')).toHaveCount(0);
  // 外点关闭（点底栏左侧计数区：标记面板之外，不改变选中；2026-10-10 面板改右列
  // 锚定后会盖住右下「适应画布」钮，故改点左下计数区）
  const picker2 = await openEmojiArea(page);
  await expect(picker2).toBeVisible();
  await page.getByTestId('node-count').click();
  await expect(page.getByTestId('marker-panel')).toHaveCount(0);
  // 关闭后选中未丢：旗帜徽标仍在
  await expect(markerBadgeByValue(page, '周一', 'flag')).toHaveCount(1);
});
