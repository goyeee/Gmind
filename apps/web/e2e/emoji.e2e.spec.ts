import { expect, test, type Page } from '@playwright/test';

/**
 * emoji 表情面板 E2E — M6 Task 5（企微对标）。
 *
 * 复用 rich-content 的登录/种子文件模式（新手机号注册即赠 3 个种子文件）。
 * 面板语义（冻结）：emoji 为独立图标组——setIcon(doc, id, 'emoji', char) 组内
 * 单选（再点同 emoji=取消 null），与 priority/flag 等并存互不影响；节点渲染
 * emoji 值本身进 .gm-icons（组序末位）；testid emoji-picker / emoji-item-{char}。
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

// 用例 1（主链路）：选节点 → 表情面板选 😊 → 节点 .gm-icons 含 😊 → 保存已落库 →
// reload 仍在 → 再点同 emoji = 取消（组内单选 toggle）。
test('表情面板：选 😊 渲染进节点图标槽，刷新仍在，再点同 emoji 取消', async ({ page }) => {
  await openSeedDoc(page, '本周计划');
  await selectNodeByText(page, '周一');
  const panel = page.getByTestId('rich-panel');
  await panel.getByTestId('emoji-trigger').click();
  const picker = page.getByTestId('emoji-picker');
  await expect(picker).toBeVisible();
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
  // 再点同 emoji → 取消：槽位清空
  await page.getByTestId('rich-panel').getByTestId('emoji-trigger').click();
  const picker2 = page.getByTestId('emoji-picker');
  await expect(picker2.getByTestId('emoji-item-😊')).toHaveAttribute('aria-pressed', 'true');
  await picker2.getByTestId('emoji-item-😊').click();
  await expect(nodeGroup(page, '周一').locator('.gm-icons')).toHaveCount(0);
});

// 用例 2：emoji 与旗帜组并存互不影响（组间独立）+ Esc / 外点关闭。
test('表情面板：emoji 与旗帜并存互不影响；Esc 与外点关闭', async ({ page }) => {
  await openSeedDoc(page, '本周计划');
  await selectNodeByText(page, '周一');
  const panel = page.getByTestId('rich-panel');
  await panel.getByTitle('旗帜-红').click();
  await expect(nodeGroup(page, '周一').locator('.gm-icons')).toHaveText('⚑');
  await panel.getByTestId('emoji-trigger').click();
  const picker = page.getByTestId('emoji-picker');
  await expect(picker).toBeVisible();
  await picker.getByTestId('emoji-tab-手势').click();
  await picker.getByTestId('emoji-item-👍').click();
  // 组序固定 priority→…→flag→star→emoji：旗帜在前、emoji 在后
  await expect(nodeGroup(page, '周一').locator('.gm-icons')).toHaveText('⚑👍');
  // 取消 emoji（选中即收起，重开→回手势 tab→再点同 emoji）：旗帜仍在
  await panel.getByTestId('emoji-trigger').click();
  const picker2 = page.getByTestId('emoji-picker');
  await picker2.getByTestId('emoji-tab-手势').click();
  await picker2.getByTestId('emoji-item-👍').click();
  await expect(nodeGroup(page, '周一').locator('.gm-icons')).toHaveText('⚑');
  // Esc 关闭
  await panel.getByTestId('emoji-trigger').click();
  await expect(page.getByTestId('emoji-picker')).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.getByTestId('emoji-picker')).toHaveCount(0);
  // 外点关闭（点面板标题区：弹层与锚点之外，且不改变选中）
  await panel.getByTestId('emoji-trigger').click();
  await expect(page.getByTestId('emoji-picker')).toBeVisible();
  await panel.getByRole('heading', { name: '样式' }).click();
  await expect(page.getByTestId('emoji-picker')).toHaveCount(0);
  // 关闭后选中未丢：旗帜角标与触发钮仍在
  await expect(nodeGroup(page, '周一').locator('.gm-icons')).toHaveText('⚑');
  await expect(panel.getByTestId('emoji-trigger')).toBeVisible();
});
