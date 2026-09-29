import { expect, test, type Page } from '@playwright/test';

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
 *  评论右列默认不渲染（M7b-R6），经插入菜单「评论」项开启）。 */
async function commentOnNode(page: Page, nodeText: string, content: string): Promise<void> {
  await page.locator('.editor-canvas svg .gm-text', { hasText: nodeText }).first().click();
  await page.getByTestId('insert-menu').click();
  await page.getByTestId('insert-comment').click();
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
  await openSeedDoc(page, '本周计划');
  const nickname = await nicknameOf(page);

  // 关闭态整棵不渲染（ThemePanel 同款裁决）
  await expect(page.getByTestId('activity-panel')).toHaveCount(0);

  // UI 发一条评论（comment_create 事件在 POST 响应前已落库）
  await commentOnNode(page, '周三', '动态面板用例评论');

  // 打开动态面板：版本历史旁的「动态」入口
  await page.getByTestId('activity-toggle').click();
  const panel = page.getByTestId('activity-panel');
  await expect(panel).toBeVisible();

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
