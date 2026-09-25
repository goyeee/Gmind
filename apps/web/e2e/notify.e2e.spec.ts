import { expect, test, type APIRequestContext, type Page } from '@playwright/test';

/**
 * 站内通知 UI E2E — M3b Task 8（FR-CMT-005）。
 *
 * 前置：vite dev（/api 代理 → API_ORIGIN）+ 后端（tsx watch，:3001）。
 *
 * 覆盖面（多用户编排：B 先经 POST /api/dev-e2e/grant-collaborator 成为 A 文件协作者，
 * 否则 A 的 @mention 会被服务端过滤）：
 * - A 评论 @B → B 浏览器经 SSE 收到推送 → 工作台铃铛未读角标 +1（data-testid="notify-badge"）；
 * - B 点开铃铛 → 通知下拉（data-testid="notify-list"）显示 mention 条目；
 * - 点击条目 → POST read → 角标清零（badge 消失）→ 跳转 payload.fileId 的编辑页；
 * - M4 清偿：payload 带 nodeId → 深链 /edit/:fileId?node=:nodeId → 装载后定位节点
 *   （.gm-selected，同评论面板 locate 语义）并 replaceState 清参。
 *
 * 评论经页面内 fetch 带 mentions 直发（评论输入框的 @ 选择器不在本任务范围；
 * SSE/铃铛链路是纯端到端断言）。SSE 就绪以 window.__gmindNotifyReady 标记
 * （notify.ts 在 onopen 置位），避免 B 连接建立前触发推送漏收。
 */

async function registerAndLogin(page: Page, phone?: string): Promise<string> {
  await page.goto('/login');
  const target = phone ?? '137' + String(Math.floor(10000000 + Math.random() * 89999999));
  await page.getByPlaceholder('手机号').fill(target);
  await page.getByPlaceholder('验证码（开发环境固定 123456）').fill('123456');
  await page.getByRole('button', { name: '登录', exact: true }).click();
  await expect(page).toHaveURL(/\/workspace/);
  await expect(page.locator('.file-list li')).toHaveCount(3);
  return target;
}

async function grantCollaborator(request: APIRequestContext, fileId: string, phone: string): Promise<void> {
  const res = await request.post('/api/dev-e2e/grant-collaborator', { data: { fileId, phone } });
  if (!res.ok()) throw new Error(`授予协作者失败：${res.status()}`);
}

/** 页面内带 token 的 fetch（复用登录态；返回 JSON）。 */
async function apiInPage<T>(page: Page, path: string, init: { method?: string; body?: unknown } = {}): Promise<T> {
  return page.evaluate(
    async ({ path, method, body }) => {
      const res = await fetch(path, {
        method: method ?? 'GET',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${localStorage.getItem('gmind.token') ?? ''}` },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      if (!res.ok) throw new Error(`${method ?? 'GET'} ${path} → ${res.status}`);
      return (await res.json()) as unknown;
    },
    { path, method: init.method, body: init.body },
  ) as Promise<T>;
}

test('A @B → B 铃铛 +1 → 下拉显示 → 点击已读 → badge 清零并跳转', async ({ browser, request }) => {
  test.setTimeout(90_000);
  const ctxA = await browser.newContext();
  const ctxB = await browser.newContext();
  const pageA = await ctxA.newPage();
  const pageB = await ctxB.newPage();

  await registerAndLogin(pageA);
  const phoneB = await registerAndLogin(pageB);

  // B 的 userId（mention 用）与 A 的种子文件（fileId / ownerId 用）
  const meB = await apiInPage<{ id: string; nickname: string }>(pageB, '/api/users/me');
  const filesA = await apiInPage<Array<{ id: string; title: string; ownerUserId: string }>>(pageA, '/api/files?view=mine');
  const fileId = filesA[0]!.id;
  await grantCollaborator(request, fileId, phoneB);

  // B 的 SSE 连接建立（onopen 置位）后才触发，保证事件不漏收
  await expect
    .poll(() => pageB.evaluate(() => (window as unknown as Record<string, unknown>).__gmindNotifyReady === true), {
      timeout: 15_000,
    })
    .toBe(true);

  // A 评论并 @B（评论 UI 无 @ 选择器，mentions 经 API 直发；其余链路端到端）
  await apiInPage(pageA, `/api/files/${fileId}/comments`, {
    method: 'POST',
    body: { nodeId: 'root', content: `请 @${meB.nickname} 看这一支`, mentions: [meB.id] },
  });

  // B 铃铛未读角标 +1（SSE 推送 → unread-count 重取）
  const badge = pageB.getByTestId('notify-badge');
  await expect(badge).toHaveText('1', { timeout: 15_000 });

  // 点开铃铛 → 下拉列出 mention 条目（含文件标题与提及文案）
  await pageB.getByTestId('notify-bell').click();
  const list = pageB.getByTestId('notify-list');
  await expect(list).toBeVisible();
  const item = pageB.getByTestId('notify-item').first();
  await expect(item).toContainText(filesA[0]!.title);
  await expect(item).toContainText('提到了你');

  // 点击条目 → 标记已读 + 跳转编辑页 + 角标清零
  await item.click();
  await expect(pageB).toHaveURL(new RegExp(`/edit/${fileId}`));
  await expect(pageB.getByTestId('notify-badge')).toHaveCount(0, { timeout: 15_000 });

  // 回工作台再开铃铛：条目为已读态且未读数保持 0（badge 不再出现）
  await pageB.goto('/workspace');
  await pageB.getByTestId('notify-bell').click();
  await expect(pageB.getByTestId('notify-list')).toBeVisible();
  await expect(pageB.getByTestId('notify-item').first()).toContainText(filesA[0]!.title);
  await expect(pageB.getByTestId('notify-badge')).toHaveCount(0);

  await ctxA.close();
  await ctxB.close();
});

test('M4 清偿：通知点击深链 ?node= → 装载后定位对应节点并清参', async ({ browser, request }) => {
  test.setTimeout(90_000);
  const ctxA = await browser.newContext();
  const ctxB = await browser.newContext();
  const pageA = await ctxA.newPage();
  const pageB = await ctxB.newPage();

  await registerAndLogin(pageA);
  const phoneB = await registerAndLogin(pageB);

  const meB = await apiInPage<{ id: string; nickname: string }>(pageB, '/api/users/me');
  const filesA = await apiInPage<Array<{ id: string; title: string }>>(pageA, '/api/files?view=mine');
  // 深链要锚定一个**非 root** 节点（root 是装配默认选中，断言会假阳性）：
  // 用种子文件「欢迎使用 Gmind」的「基本操作」子节点
  const fileId = filesA.find((f) => f.title === '欢迎使用 Gmind')!.id;
  await grantCollaborator(request, fileId, phoneB);

  // A 打开文件取子节点 id（模板生成的 ULID 不可预知；dev-only __gmind 钩子口径同 collab e2e）
  await pageA.goto(`/edit/${fileId}`);
  await expect
    .poll(() => pageA.evaluate(() => (window as unknown as Record<string, unknown>).__gmind !== undefined), {
      timeout: 15_000,
    })
    .toBe(true);
  const childId = await pageA.evaluate(() => {
    const hook = (window as unknown as { __gmind?: { getDoc(): unknown } }).__gmind;
    if (!hook) throw new Error('window.__gmind 未就绪');
    const doc = hook.getDoc() as { getMap(name: string): Map<string, { get(key: string): unknown }> };
    for (const [id, node] of doc.getMap('nodes').entries()) {
      if (node.get('text') === '基本操作') return id;
    }
    throw new Error('页面内未找到「基本操作」节点');
  });

  // B 的 SSE 就绪后，A 在该节点评论并 @B
  await expect
    .poll(() => pageB.evaluate(() => (window as unknown as Record<string, unknown>).__gmindNotifyReady === true), {
      timeout: 15_000,
    })
    .toBe(true);
  await apiInPage(pageA, `/api/files/${fileId}/comments`, {
    method: 'POST',
    body: { nodeId: childId, content: '这一支请看下', mentions: [meB.id] },
  });

  await expect(pageB.getByTestId('notify-badge')).toHaveText('1', { timeout: 15_000 });
  await pageB.getByTestId('notify-bell').click();
  const item = pageB.getByTestId('notify-item').first();
  await expect(item).toContainText('提到了你');
  await item.click();

  // 深链：payload 带 nodeId → 跳 /edit/:fileId?node=:nodeId → 装载后节点 .gm-selected；
  // 随即 history.replaceState 清参（断言最终 URL 无查询串，刷新不重复定位）
  await expect(pageB.locator(`.editor-canvas svg [data-node-id="${childId}"]`)).toHaveClass(/gm-selected/, {
    timeout: 15_000,
  });
  await expect(pageB).toHaveURL(new RegExp(`/edit/${fileId}$`));

  await ctxA.close();
  await ctxB.close();
});
