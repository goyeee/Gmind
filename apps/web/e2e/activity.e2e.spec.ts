import { expect, test, type Page } from '@playwright/test';
import { registerAndLogin } from './helpers/auth';

/**
 * 文档动态面板 E2E — M6 Task 8（企微对标，FR-COL-007 提前）。
 *
 * 前置：vite dev（/api 代理 → API_ORIGIN）+ 后端（:3001）。
 *
 * 覆盖面：
 * - 打开种子文档 → UI 发评论（comment-input/comment-send 既有链路）→ 工具栏「动态」
 *   打开面板 → 最新条目为「评论」+ 评论者昵称（comment_create 在 POST 响应前已落库，
 *   开面板重拉必见）；种子文档创建时的 doc_create「创建文档」条目同样在列（倒序靠后）；
 * - 条目带相对时间（刚刚/N 分钟前/N 小时前/N 天前/跨周日月）；
 * - 关闭态整棵不渲染；关闭按钮收起。
 */


async function openSeedDoc(page: Page, title: string): Promise<void> {
  await registerAndLogin(page);
  await page.getByTestId('file-card').filter({ hasText: title }).first().click();
  await expect(page).toHaveURL(/\/edit\//);
  await expect(page.locator('.editor-canvas svg .gm-text', { hasText: title })).toBeVisible();
}

/** 当前登录用户的昵称（与动态条目 userName 同源：users.nickname）。 */
async function nicknameOf(page: Page): Promise<string> {
  return page.evaluate(async () => {
    const res = await fetch('/api/users/me', {
      headers: { Authorization: `Bearer ${localStorage.getItem('gmind.token') ?? ''}` },
    });
    const body = (await res.json()) as { nickname?: string };
    if (!body.nickname) throw new Error('users/me 无昵称');
    return body.nickname;
  });
}

/** 选中指定文本的节点并在评论面板顶部输入框发布评论（comments.e2e 同款链路；
 *  评论右列默认不渲染（M7b-R6），2026-10-25 原型顶栏重组后评论入口在「更多」下拉）。 */
async function commentOnNode(page: Page, nodeText: string, content: string): Promise<void> {
  await page.locator('.editor-canvas svg .gm-text', { hasText: nodeText }).first().click();
  await page.getByTestId('more-toggle').click();
  await page.getByTestId('comment-toggle').click();
  await page.getByTestId('comment-input').fill(content);
  await page.getByTestId('comment-send').click();
  await expect(page.locator('[data-testid="comment-thread"]', { hasText: content })).toBeVisible({
    timeout: 10_000,
  });
}

test('动态面板：UI 发评论后开面板，最新条目为「评论」+昵称；doc_create 在列；关闭收起', async ({
  browser,
}) => {
  test.setTimeout(90_000);
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  page.on('pageerror', (err) => console.log('PAGEERROR:', err.message.slice(0, 300)));
  page.on('response', (res) => { if (res.status() >= 400) console.log('HTTP', res.status(), res.url().slice(-80)); });
  page.on('console', (msg) => { if (msg.type() === 'error') console.log('CONSOLE:', msg.text().slice(0, 300)); });
  await openSeedDoc(page, '本周计划');
  const nickname = await nicknameOf(page);

  // 关闭态整棵不渲染（ThemePanel 同款裁决）
  await expect(page.getByTestId('activity-panel')).toHaveCount(0);

  // UI 发一条评论（comment_create 事件在 POST 响应前已落库）
  await commentOnNode(page, '周三', '动态面板用例评论');

  // 打开动态面板：版本历史旁的「动态」入口
  console.log('TOGGLE_ACTIVITY');
  await page.getByTestId('activity-toggle').click({ timeout: 8000 });
  const panel = page.getByTestId('activity-panel');
  await expect(panel).toBeVisible({ timeout: 5000 });
  console.log('ACTIVITY_OPEN');

  // 最新条目（倒序首条）：「评论」类型 + 评论者昵称 + 相对时间
  const firstItem = panel.locator('[data-testid^="activity-item-"]').first();
  await expect(firstItem).toContainText('评论');
  await expect(firstItem).toContainText(nickname);
  await expect(firstItem.locator('.activity-item-time')).toHaveText(
    /^(刚刚|\d+ (分钟|小时|天)前|\d{2}-\d{2} \d{2}:\d{2})$/,
  );

  // 种子文档创建时的 doc_create 条目在列（「创建文档」，时间上早于评论）
  await expect(panel.locator('[data-testid^="activity-item-"]', { hasText: '创建文档' })).toHaveCount(1);

  // 关闭按钮收起
  await page.getByTestId('activity-panel-close').click();
  await expect(page.getByTestId('activity-panel')).toHaveCount(0);

  await ctx.close();
});

/**
 * 任务动态（第二轮 2026-11-21，spec §5.5）：编辑器内用户级任务写（面板指派负责人）
 * → stateless 声明 → 服务端以连接身份盖章落库 → 文档动态抽屉出现任务事件条目
 * （动作文案 + 任务文本 + 操作人）。操作人 = 当前登录用户（盖章不信任客户端声明）。
 */
test('任务动态：面板指派负责人后，文档动态抽屉出现盖章的任务事件', async ({ browser }) => {
  test.setTimeout(90_000);
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  page.on('pageerror', (err) => console.log('PAGEERROR:', err.message.slice(0, 300)));
  page.on('response', (res) => { if (res.status() >= 400) console.log('HTTP', res.status(), res.url().slice(-80)); });
  page.on('console', (msg) => { if (msg.type() === 'error') console.log('CONSOLE:', msg.text().slice(0, 300)); });
  await openSeedDoc(page, '本周计划');
  const nickname = await nicknameOf(page);
  const nodeId = await page.evaluate(async () => {
    const res = await fetch('/api/users/me', {
      headers: { Authorization: `Bearer ${localStorage.getItem('gmind.token') ?? ''}` },
    });
    return ((await res.json()) as { id?: string }).id ?? '';
  });
  expect(nodeId).not.toBe('');

  // 选中节点 → 任务面板 → 点自己 = 指派为总负责人（用户级任务写入口）。
  // 存量怪相（HEAD 已有，本轮登记非回归）：画布节点点击后的第一次工具栏点击会
  // 双触发 onClick——面板闪开即关；这里点开后若面板不在再补一次点击。
  await page.locator('.editor-canvas svg .gm-text').first().click();
  const nodeText = (await page.locator('.editor-canvas svg .gm-text').first().textContent()) ?? '';
  await page.getByTestId('task-toggle').click();
  if ((await page.getByTestId('task-panel').count()) === 0) {
    await page.getByTestId('task-toggle').click();
  }
  await page.getByTestId('task-panel').waitFor({ timeout: 5000 });
  await page.locator(`[data-testid^="task-panel-owner-"]`).first().click({ timeout: 8000 }); // 负责人 chip（task-panel-owner-${userId}，wt-task-model 同款前缀）

  // 文档动态抽屉：任务事件条目出现（面板开合重拉；声明→盖章落库有传输延迟）
  console.log('TOGGLE_ACTIVITY');
  await page.getByTestId('activity-toggle').click({ timeout: 8000 });
  const panel = page.getByTestId('activity-panel');
  await expect(panel).toBeVisible({ timeout: 5000 });
  console.log('ACTIVITY_OPEN');
  const item = panel.locator('[data-testid^="activity-item-"]', { hasText: '指派了负责人' });
  await expect(item.first()).toBeVisible({ timeout: 15_000 });
  await expect(item.first()).toContainText(nodeText); // taskText 服务端文档现值
  await expect(item.first()).toContainText(nickname); // actor=连接身份（盖章）
  await ctx.close();
});
