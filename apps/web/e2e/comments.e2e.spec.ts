import { expect, test, type APIRequestContext, type Page } from '@playwright/test';

/**
 * 评论 UI 与双向定位 E2E — M3b Task 7（FR-CMT-002）。
 *
 * 前置：vite dev（/collab ws 代理 → API_ORIGIN）+ 后端（tsx watch，:3001）。
 *
 * 覆盖面（多用户编排：B 对 A 的文件无权限，先经开发编排端点
 * POST /api/dev-e2e/grant-collaborator 补 file_collaborators 行，collab.e2e 同款）：
 * - A 选中节点评论 → B 角标出现（comment-updated 无状态广播 → 再拉取）→ B 面板见
 *   线程 → B 回复 → A 面板见回复（角标计数 1→2 双端一致）；
 * - 角标点击 → 面板过滤到该节点线程（「查看全部」返回），且不改变画布选区；
 * - 面板条目点击 → 画布定位：selectOnly + 展开折叠祖先（折叠 root 后深层节点
 *   从画布消失，定位后祖先展开、节点重新可见并带 .gm-selected）；
 * - 节点删除：线程保留全文并标记「原节点已删除」；刷新后评论仍在。
 *
 * 时序纪律：节点删除的 nodeDeleted 由服务端按 docState 判定——删除后等「已保存」
 * + onStoreDocument 防抖余量（3s）再刷新，避免 GET /comments 读到旧快照。
 */

async function registerAndLogin(page: Page, phone?: string): Promise<string> {
  await page.goto('/login');
  const target = phone ?? '138' + String(Math.floor(10000000 + Math.random() * 89999999));
  await page.getByPlaceholder('手机号').fill(target);
  await page.getByPlaceholder('验证码（开发环境固定 123456）').fill('123456');
  await page.getByRole('button', { name: '登录', exact: true }).click();
  await expect(page).toHaveURL(/\/workspace/);
  await expect(page.locator('.file-list li')).toHaveCount(3);
  return target;
}

/** 打开种子文件进入编辑器，等待 root 文本渲染。 */
async function openSeedDoc(page: Page, title: string): Promise<void> {
  await registerAndLogin(page);
  await page.locator('.file-list li', { hasText: title }).click();
  await expect(page).toHaveURL(/\/edit\//);
  await expect(page.locator('.editor-canvas svg .gm-text', { hasText: title })).toBeVisible();
}

function fileIdFromUrl(page: Page): string {
  const m = /\/edit\/([0-9A-Za-z]+)/.exec(page.url());
  if (!m || !m[1]) throw new Error(`URL 中无 fileId：${page.url()}`);
  return m[1];
}

/** 当前登录用户的昵称（与评论 author.nickname 同源：GET /api/users/me）。 */
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

async function grantCollaborator(
  request: APIRequestContext,
  fileId: string,
  phone: string,
): Promise<void> {
  const res = await request.post('/api/dev-e2e/grant-collaborator', { data: { fileId, phone } });
  if (!res.ok()) throw new Error(`授予协作者失败：${res.status()}`);
}

/** 打开评论右列（M7b-R6：右列默认不渲染，插入菜单「评论」项开启）。 */
async function openComments(page: Page): Promise<void> {
  await page.getByTestId('insert-menu').click();
  await page.getByTestId('insert-comment').click();
  await expect(page.getByTestId('comment-pane')).toBeVisible();
}

/** 选中指定文本的节点并在评论面板顶部输入框发布评论。 */
async function commentOnNode(page: Page, nodeText: string, content: string): Promise<void> {
  await page.locator('.editor-canvas svg .gm-text', { hasText: nodeText }).first().click();
  await openComments(page);
  await page.getByTestId('comment-input').fill(content);
  await page.getByTestId('comment-send').click();
  // 自身 POST 的广播路径回流：面板出现线程即发布成功
  await expect(page.locator('[data-testid="comment-thread"]', { hasText: content })).toBeVisible({
    timeout: 10_000,
  });
}

/** 节点 g 内的评论角标（hasText 按节点文本定位 g；SVG 文本直读）。 */
function badgeOf(page: Page, nodeText: string): ReturnType<Page['locator']> {
  return page
    .locator('.editor-canvas svg [data-node-id]', { hasText: nodeText })
    .locator('.gm-comment-badge');
}

test('A 评论 → B 角标出现并回复 → A 面板见回复（comment-updated 广播）', async ({
  browser,
  request,
}) => {
  test.setTimeout(90_000);
  const ctxA = await browser.newContext();
  const pageA = await ctxA.newPage();
  await registerAndLogin(pageA);
  await openSeedDoc(pageA, '本周计划');
  const fileId = fileIdFromUrl(pageA);
  const nickA = await nicknameOf(pageA);

  const ctxB = await browser.newContext();
  const pageB = await ctxB.newPage();
  const phoneB = await registerAndLogin(pageB);
  await grantCollaborator(request, fileId, phoneB);
  await pageB.goto(`/edit/${fileId}`);
  await expect(pageB.locator('.editor-canvas svg .gm-text', { hasText: '本周计划' })).toBeVisible({
    timeout: 15_000,
  });

  // A 选中「周三」评论 → B 角标出现（comment-updated 广播 → B 再拉取 → 场景协调）
  await commentOnNode(pageA, '周三', '请确认周三方案');
  await expect(badgeOf(pageB, '周三')).toHaveText('1', { timeout: 10_000 });

  // B 面板（评论右列，M7b-R6 起插入菜单「评论」项开启）见线程：作者昵称 + 内容 + 节点快照
  await openComments(pageB);
  const threadB = pageB.locator('[data-testid="comment-thread"]', { hasText: '请确认周三方案' });
  await expect(threadB.getByTestId('comment-author')).toHaveText(nickA);
  await expect(threadB.getByTestId('comment-node-snap')).toHaveText('周三');
  await expect(threadB.getByTestId('comment-node-deleted')).toHaveCount(0);

  // B 回复 → A 面板见回复，双端角标计数 1→2
  await threadB.getByTestId('reply-input').fill('收到，我来跟进');
  await threadB.getByTestId('reply-send').click();
  await expect(badgeOf(pageA, '周三')).toHaveText('2', { timeout: 10_000 });
  await expect(
    pageA.locator('[data-testid="comment-thread"]', { hasText: '请确认周三方案' }),
  ).toContainText('收到，我来跟进');
  const threadBAfter = pageB.locator('[data-testid="comment-thread"]', {
    hasText: '请确认周三方案',
  });
  await expect(threadBAfter.getByTestId('comment-reply')).toHaveText(/收到，我来跟进/);

  await ctxA.close();
  await ctxB.close();
});

test('角标点击过滤线程且不改选区；面板条目定位选中并展开折叠祖先', async ({ browser }) => {
  test.setTimeout(90_000);
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  await openSeedDoc(page, '本周计划');

  // 两条线程：周三 / 周五
  await commentOnNode(page, '周三', '周三评论');
  await commentOnNode(page, '周五', '周五评论');
  await expect(page.getByTestId('comment-thread')).toHaveCount(2);

  // 折叠 root（右键 → 折叠/展开）：深层节点从画布消失；画布右键命中「弹层外点」
  // 语义 → 评论右列自动收起（2026-09-28 走查行为），操作后重开
  await page.locator('.editor-canvas svg .gm-text', { hasText: '本周计划' }).click({ button: 'right' });
  await page.getByTestId('context-menu').getByRole('button', { name: '折叠/展开' }).click();
  await expect(page.locator('.editor-canvas svg .gm-text', { hasText: '周三' })).toHaveCount(0);
  await expect(page.getByTestId('comment-pane')).toHaveCount(0);
  await openComments(page);

  // 面板条目点击 → 定位：折叠祖先展开、节点重新可见并带 .gm-selected
  await page
    .locator('[data-testid="comment-thread"]', { hasText: '周三评论' })
    .getByTestId('comment-content')
    .click();
  const gZhou3 = page.locator('.editor-canvas svg [data-node-id]', { hasText: '周三' });
  await expect(gZhou3).toBeVisible({ timeout: 5_000 });
  await expect(gZhou3).toHaveClass(/gm-selected/);

  // 角标点击 → 过滤到该节点线程（查看全部返回）；角标在画布上，点击按「弹层外点」
  // 语义收起评论右列（过滤态保留）——重开面板为过滤视图；不改变画布选区（仍选中周三）
  await badgeOf(page, '周五').click();
  await expect(page.getByTestId('comment-pane')).toHaveCount(0);
  await openComments(page);
  await expect(page.getByTestId('comment-back-all')).toBeVisible();
  await expect(page.getByTestId('comment-thread')).toHaveCount(1);
  await expect(page.getByTestId('comment-thread').first()).toContainText('周五评论');
  await expect(gZhou3).toHaveClass(/gm-selected/);
  await page.getByTestId('comment-back-all').click();
  await expect(page.getByTestId('comment-thread')).toHaveCount(2);

  await ctx.close();
});

test('节点删除后线程保留全文并标记原节点已删除；刷新后评论仍在', async ({ browser }) => {
  test.setTimeout(90_000);
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  await openSeedDoc(page, '本周计划');

  await commentOnNode(page, '周三', '周三待办评论');
  await commentOnNode(page, '周五', '周五待办评论');

  // 删除「周三」（选中 → Delete）：画布消失；周五角标不受影响
  await page.locator('.editor-canvas svg .gm-text', { hasText: '周三' }).first().click();
  await page.keyboard.press('Delete');
  await expect(page.locator('.editor-canvas svg .gm-text', { hasText: '周三' })).toHaveCount(0);
  await expect(badgeOf(page, '周五')).toHaveText('1', { timeout: 10_000 });

  // 等删除落库（已保存 + onStoreDocument 防抖余量）→ 刷新：nodeDeleted 按新快照判定
  await expect(page.getByTestId('save-status')).toHaveText(/已保存/, { timeout: 10_000 });
  await page.waitForTimeout(3_000);
  await page.reload();
  await expect(page.locator('.editor-canvas svg .gm-text', { hasText: '本周计划' })).toBeVisible({
    timeout: 15_000,
  });

  // 已删节点线程：全文保留 + 「原节点已删除」标记；存活线程与角标不受影响
  // （刷新后评论右列默认收起：重开面板读取）
  await openComments(page);
  const deletedThread = page.locator('[data-testid="comment-thread"]', { hasText: '周三待办评论' });
  await expect(deletedThread).toBeVisible({ timeout: 10_000 });
  await expect(deletedThread.getByTestId('comment-node-deleted')).toHaveText('原节点已删除');
  await expect(deletedThread.getByTestId('comment-node-snap')).toHaveText('周三');
  await expect(deletedThread).toContainText('周三待办评论');
  await expect(badgeOf(page, '周五')).toHaveText('1', { timeout: 10_000 });

  await ctx.close();
});
