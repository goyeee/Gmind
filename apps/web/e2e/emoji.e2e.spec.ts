import { expect, test, type Page } from '@playwright/test';

/**
 * emoji 表情区 E2E — M6 Task 5（企微对标）；2026-09-28 标记面板迁移后表情区
 * 位于工具栏「插入」→「标记」右侧层面板内（testid 契约不变：emoji-picker /
 * emoji-tab-{name} / emoji-item-{char}）。
 *
 * 复用 rich-content 的登录/种子文件模式（新手机号注册即赠 3 个种子文件）。
 * 面板语义（冻结）：emoji 为独立图标组——setIcon(doc, id, 'emoji', char) 组内
 * 单选（再点同 emoji=取消 null），与 priority/flag 等并存互不影响；节点渲染
 * emoji 值本身进 .gm-icons（组序末位）。面板常开（选中不收起），Esc / 外点
 * 关闭整个插入层（菜单 + 面板）。
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

/** 打开插入 → 标记面板：返回其中的表情区定位器（emoji-picker testid 不变）。 */
async function openEmojiArea(page: Page) {
  await page.getByTestId('insert-menu').click();
  await page.getByTestId('insert-markers').click();
  const panel = page.getByTestId('marker-panel');
  await expect(panel).toBeVisible();
  const picker = panel.getByTestId('emoji-picker');
  await expect(picker).toBeVisible();
  return picker;
}

// 用例 1（主链路）：选节点 → 标记面板表情区选 😊 → 节点 .gm-icons 含 😊 → 保存
// 已落库 → reload 仍在 → 再点同 emoji = 取消（组内单选 toggle）。
test('表情区：选 😊 渲染进节点图标槽，刷新仍在，再点同 emoji 取消', async ({ page }) => {
  await openSeedDoc(page, '本周计划');
  await selectNodeByText(page, '周一');
  const picker = await openEmojiArea(page);
  // 分类 tab（表情/手势/符号）各 24 个 emoji，切换即时换格
  for (const name of ['表情', '手势', '符号']) {
    await picker.getByTestId(`emoji-tab-${name}`).click();
    await expect(picker.locator('[data-testid^="emoji-item-"]')).toHaveCount(24);
  }
  await picker.getByTestId('emoji-tab-表情').click();
  await picker.getByTestId('emoji-item-😊').click();
  await expect(nodeGroup(page, '周一').locator('.gm-icons')).toHaveText('😊');
  await expect(page.getByTestId('save-status')).toHaveText(/已保存/);
  // 刷新（持久化 + 重连协同）：emoji 仍在节点图标槽；重选该节点再操作
  await page.reload();
  await expect(page.locator('.editor-canvas svg .gm-text', { hasText: '本周计划' })).toBeVisible();
  await expect(nodeGroup(page, '周一').locator('.gm-icons')).toHaveText('😊');
  await selectNodeByText(page, '周一');
  const picker2 = await openEmojiArea(page);
  // 再点同 emoji → 取消：槽位清空（面板常开，选中不收起）
  await expect(picker2.getByTestId('emoji-item-😊')).toHaveAttribute('aria-pressed', 'true');
  await picker2.getByTestId('emoji-item-😊').click();
  await expect(nodeGroup(page, '周一').locator('.gm-icons')).toHaveCount(0);
});

// 用例 2：emoji 与旗帜组并存互不影响（组间独立）+ Esc / 外点关闭整个插入层。
test('表情区：emoji 与旗帜并存互不影响；Esc 与外点关闭', async ({ page }) => {
  await openSeedDoc(page, '本周计划');
  await selectNodeByText(page, '周一');
  const panel = page.getByTestId('marker-panel');
  const picker = await openEmojiArea(page);
  await panel.getByTitle('旗帜-红').click();
  await expect(nodeGroup(page, '周一').locator('.gm-icons')).toHaveText('⚑');
  await picker.getByTestId('emoji-tab-手势').click();
  await picker.getByTestId('emoji-item-👍').click();
  // 组序固定 priority→…→flag→star→emoji：旗帜在前、emoji 在后
  await expect(nodeGroup(page, '周一').locator('.gm-icons')).toHaveText('⚑👍');
  // 取消 emoji（面板常开，直接再点同 emoji）：旗帜仍在
  await picker.getByTestId('emoji-item-👍').click();
  await expect(nodeGroup(page, '周一').locator('.gm-icons')).toHaveText('⚑');
  // Esc 关闭整个插入层（菜单 + 面板）
  await page.keyboard.press('Escape');
  await expect(page.getByTestId('marker-panel')).toHaveCount(0);
  await expect(page.getByTestId('insert-markers')).toHaveCount(0);
  // 外点关闭（点底栏「适应画布」：插入层之外，不改变选中；右列样式标题在视口
  // 内可能被 340px 宽的标记面板覆盖，不选它作外点目标）
  const picker2 = await openEmojiArea(page);
  await expect(picker2).toBeVisible();
  await page.getByTestId('fit-btn').click();
  await expect(page.getByTestId('marker-panel')).toHaveCount(0);
  // 关闭后选中未丢：旗帜角标仍在
  await expect(nodeGroup(page, '周一').locator('.gm-icons')).toHaveText('⚑');
});
