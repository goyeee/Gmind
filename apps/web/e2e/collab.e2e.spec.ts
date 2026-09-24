import { expect, test, type APIRequestContext, type BrowserContext, type Page } from '@playwright/test';

/**
 * 客户端协同接入与三态/离线 E2E — M2 Task 3（FR-EDT-034/035）。
 *
 * 前置：vite dev（/collab ws 代理 → API_ORIGIN）+ 后端（tsx watch，:3001）。
 * 「已保存」由 WS persisted ack（服务端 onStoreDocument 防抖默认 2s）驱动，
 * 断言窗口放宽到 10s；恢复联网用例统一给 10s 轮询容忍（显式重连 + 服务端 2s
 * 持久化防抖）。
 *
 * 断网编排（两通道分别、确定性断开）：
 * - REST：context.setOffline(true)——CDP 网络栈对 HTTP 的拦截是确定性的；
 * - WS：window.__gmindCollab.setReachable(false)（collab.ts 的 dev-only 钩子，
 *   纪律同 EditorPage 的 window.__gmind.getDoc；生产构建剔除）——provider.disconnect()
 *   确定性关闭且不重连。不依赖 CDP setOffline 对「已建立 WS」的拆除：实测那是
 *   竞态的（会出现代理上游已死而页面侧 socket 存活的僵尸态）。
 */

const OFFLINE_STATUS_RE = /离线编辑中/;
const SAVED_RE = /已保存/;

/** collab.ts 的 dev-only 断连钩子（见文件头「断网编排」）。 */
interface CollabHooks {
  setReachable(reachable: boolean): void;
}

/** 双通道断网（REST + WS），等断开事件落地。 */
async function goOffline(
  page: Page,
  context: BrowserContext,
): Promise<void> {
  await context.setOffline(true);
  await page.evaluate(() => {
    (window as unknown as { __gmindCollab?: CollabHooks }).__gmindCollab?.setReachable(false);
  });
  await page.waitForTimeout(300); // close 事件落地窗口
}

/** 双通道恢复。 */
async function goOnline(page: Page, context: BrowserContext): Promise<void> {
  await context.setOffline(false);
  await page.evaluate(() => {
    (window as unknown as { __gmindCollab?: CollabHooks }).__gmindCollab?.setReachable(true);
  });
}

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

/** 选中节点按 Tab 新建子节点并键入文本提交。 */
async function addChildNode(page: Page, text: string): Promise<void> {
  await page.keyboard.press('Tab');
  const editor = page.locator('.gm-text-editor');
  await expect(editor).toBeVisible();
  await page.keyboard.type(text);
  await page.keyboard.press('Enter');
  await expect(editor).toHaveCount(0);
}

// 用例 1 三态：编辑 →「保存中」→「已保存 HH:MM」（WS persisted ack 驱动；与 M1 的
// PUT 驱动并存——server 会持久化，无论 ack 还是 PUT 收尾，状态都必须到「已保存」）
test('协同三态：编辑后状态「保存中」→「已保存 HH:MM」', async ({ page }) => {
  await openSeedDoc(page, '本周计划');
  await addChildNode(page, '新节点');
  await expect(page.locator('.editor-canvas svg .gm-text', { hasText: '新节点' })).toBeVisible();
  const status = page.getByTestId('save-status');
  await expect(status).toHaveText(/保存中/);
  await expect(status).toHaveText(/已保存 \d{2}:\d{2}/, { timeout: 10_000 });
});

// 用例 2 断网编辑恢复：断网编辑（「离线编辑中」）→ 恢复联网 → 自动同步回「已保存」
// 且编辑内容仍在画布
test('断网编辑显示离线编辑中，恢复联网后自动同步', async ({ page, context }) => {
  await openSeedDoc(page, '本周计划');
  await goOffline(page, context);
  await addChildNode(page, '离线节点');
  await expect(page.getByTestId('save-status')).toHaveText(OFFLINE_STATUS_RE, { timeout: 10_000 });
  await expect(page.locator('.editor-canvas svg .gm-text', { hasText: '离线节点' })).toBeVisible();
  await goOnline(page, context);
  await expect(page.getByTestId('save-status')).toHaveText(SAVED_RE, { timeout: 10_000 });
  await expect(page.locator('.editor-canvas svg .gm-text', { hasText: '离线节点' })).toBeVisible();
});

// 用例 3 离线刷新兜底：断网编辑 → reload（页面可达、REST 中断、WS 主动断开）→
// 内容从 IndexedDB 恢复可见 → 恢复可达 →「已保存」。
// 注 1：CDP setOffline 下 reload 导航本身报 ERR_INTERNET_DISCONNECTED（导航无法
// 完成，工具限制），离线刷新阶段用路由中断 /api/** 模拟「应用可达、REST 不可达」，
// 应用内代码路径（GET 失败 → IndexedDB 兜底）与全断网一致。
// 注 2：**不可用 page.route('**/collab**') 模拟 WS 中断**——vite dev 下应用自身
// 模块 /src/editor/collab.ts 的 URL 同样命中该模式，路由中断会让整个模块图加载
// 失败（页面空 body）。WS 断开用 __gmindCollab.setReachable(false) 确定性编排。
// 注 3：REST 中断的路由必须按 pathname 精确匹配——glob '**/api/**' 会误伤 vite
// dev 的 /@fs/.../shared/src/api/*.ts 模块 URL（含 /api/ 字样），整个模块图加载
// 失败（页面空 body，React 不启动）。
async function abortRest(page: Page): Promise<void> {
  await page.route('**/*', (route) => {
    const pathname = new URL(route.request().url()).pathname;
    if (pathname.startsWith('/api/')) void route.abort();
    else void route.fallback();
  });
}

test('离线刷新后内容从 IndexedDB 恢复，后端恢复可达后落库', async ({ page, context }) => {
  await openSeedDoc(page, '本周计划');
  await goOffline(page, context);
  await addChildNode(page, '离线刷新节点');
  await expect(page.getByTestId('save-status')).toHaveText(OFFLINE_STATUS_RE, { timeout: 10_000 });
  await expect(
    page.locator('.editor-canvas svg .gm-text', { hasText: '离线刷新节点' }),
  ).toBeVisible();

  // 切到「页面可达、REST 不可达」并刷新：GET /api/files/:id 失败 → 本地副本恢复
  await context.setOffline(false);
  await abortRest(page);
  await page.reload();
  await expect(
    page.locator('.editor-canvas svg .gm-text', { hasText: '本周计划' }),
  ).toBeVisible({ timeout: 15_000 });
  await expect(
    page.locator('.editor-canvas svg .gm-text', { hasText: '离线刷新节点' }),
  ).toBeVisible();

  // 刷新页面的 provider 会自行重连真实后端（Playwright 不拦截 WS）——先同步编排
  // 回离线（等离线指示落地），保证「仅 IndexedDB 路径」的断言语义
  await expect(page.getByTestId('save-status')).toHaveText(/离线编辑中|已保存/, { timeout: 10_000 });
  await page.evaluate(() => {
    (window as unknown as { __gmindCollab?: CollabHooks }).__gmindCollab?.setReachable(false);
  });
  await expect(page.getByTestId('save-status')).toHaveText(OFFLINE_STATUS_RE, { timeout: 10_000 });

  // 离线态下继续可编辑（PUT/WS 均不可达，仅 IndexedDB 路径）
  await addChildNode(page, '离线二节点');
  await expect(page.getByTestId('save-status')).toHaveText(OFFLINE_STATUS_RE, { timeout: 10_000 });

  // 恢复后端可达 → provider 重连 → 同步落库
  await page.unroute('**/*');
  await page.evaluate(() => {
    (window as unknown as { __gmindCollab?: CollabHooks }).__gmindCollab?.setReachable(true);
  });
  await expect(page.getByTestId('save-status')).toHaveText(SAVED_RE, { timeout: 15_000 });
  await expect(
    page.locator('.editor-canvas svg .gm-text', { hasText: '离线刷新节点' }),
  ).toBeVisible();
  await expect(
    page.locator('.editor-canvas svg .gm-text', { hasText: '离线二节点' }),
  ).toBeVisible();
});

// 用例 4 无重复：断网编辑 3 个节点 → 恢复联网 → 画布节点数正确（CRDT 合并无重复）
test('断网编辑 3 个节点恢复联网后无重复', async ({ page, context }) => {
  await openSeedDoc(page, '本周计划');
  await goOffline(page, context);
  for (const text of ['离线甲', '离线乙', '离线丙']) {
    await addChildNode(page, text);
  }
  await expect(page.getByTestId('save-status')).toHaveText(OFFLINE_STATUS_RE, { timeout: 10_000 });
  // 种子 6（可达活跃，不含 root）+ 3 离线新增 = 9
  await expect(page.getByTestId('node-count')).toHaveText('9 节点');
  await goOnline(page, context);
  await expect(page.getByTestId('save-status')).toHaveText(SAVED_RE, { timeout: 10_000 });
  await expect(page.getByTestId('node-count')).toHaveText('9 节点');
  await expect(page.locator('.editor-canvas svg .gm-text', { hasText: '离线甲' })).toHaveCount(1);
  await expect(page.locator('.editor-canvas svg .gm-text', { hasText: '离线乙' })).toHaveCount(1);
  await expect(page.locator('.editor-canvas svg .gm-text', { hasText: '离线丙' })).toHaveCount(1);
});

// ---------------------------------------------------------------------------
// M2 Task 5/6：Awareness 身份/选区广播 + 在线成员面板（FR-COL-002/005）
//
// 多用户编排：B/C 对 A 的文件没有权限（REST assertCanRead 与 WS canOpen 同口径），
// 需要先经开发编排端点 POST /api/dev-e2e/grant-collaborator（NODE_ENV=production
// 一律 404）补 file_collaborators 行。 Awareness 消失路径：页面关闭 → provider
// destroy/pagehide 广播 removeAwarenessStates（或 WS 断开由服务端按连接清理），
// 即时移除（不依赖 30s 超时），断言给 6s 轮询容忍。
// ---------------------------------------------------------------------------

function fileIdFromUrl(page: Page): string {
  const m = /\/edit\/([0-9A-Za-z]+)/.exec(page.url());
  if (!m || !m[1]) throw new Error(`URL 中无 fileId：${page.url()}`);
  return m[1];
}

/** 当前登录用户的昵称（collab.ts 身份广播同源：GET /api/users/me）。 */
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

// 用例 5 双端光标：A/B 同开一文件 → 互见昵称标签；A 选中「周三」→ B 出现 A 的
// 选区框；A 关闭页面 → B 的 A 光标元素 6s 内消失
test('双上下文远端光标：互见昵称标签与选区框，页面关闭即消失', async ({ browser, request }) => {
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
  const nickB = await nicknameOf(pageB);

  // 初始装配即默认选中 root → 双方互见对方昵称标签
  await expect(pageA.locator('.editor-canvas svg .gm-remote-cursor text')).toHaveText(nickB, {
    timeout: 10_000,
  });
  await expect(pageB.locator('.editor-canvas svg .gm-remote-cursor text')).toHaveText(nickA, {
    timeout: 10_000,
  });

  // A 选中「周三」节点 → B 侧该节点出现 A 的远端选区框
  await pageA.locator('.editor-canvas svg .gm-text', { hasText: '周三' }).click();
  await expect(
    pageB
      .locator('.editor-canvas svg [data-node-id]', { hasText: '周三' })
      .locator('.gm-remote-selection[data-cursor-user]'),
  ).toHaveCount(1, { timeout: 10_000 });

  // A 关闭页面 → B 侧 A 的标签与选区框即时移除（provider destroy/pagehide 广播）
  await ctxA.close();
  await expect(pageB.locator('.editor-canvas svg .gm-remote-cursor')).toHaveCount(0, {
    timeout: 6_000,
  });
  await expect(pageB.locator('.editor-canvas svg .gm-remote-selection')).toHaveCount(0, {
    timeout: 6_000,
  });
});

// 用例 6 成员面板：A(owner) 编辑 / B(协作者) 编辑 / C(协作者) 只看 → A 面板
// 「正在编辑」= {A, B}、「正在查看」= {C}、A 行带「创建者」；C 关闭 → 6s 内从面板消失
test('成员面板：编辑/查看分组、创建者标识与离线即时移除', async ({ browser, request }) => {
  const ctxA = await browser.newContext();
  const pageA = await ctxA.newPage();
  await registerAndLogin(pageA);
  await openSeedDoc(pageA, '本周计划');
  const fileId = fileIdFromUrl(pageA);
  const nickA = await nicknameOf(pageA);
  await addChildNode(pageA, '甲的编辑'); // A 编辑 → editing=true（60s 静默窗内断言）

  const ctxB = await browser.newContext();
  const pageB = await ctxB.newPage();
  const phoneB = await registerAndLogin(pageB);
  await grantCollaborator(request, fileId, phoneB);
  await pageB.goto(`/edit/${fileId}`);
  await expect(pageB.locator('.editor-canvas svg .gm-text', { hasText: '本周计划' })).toBeVisible({
    timeout: 15_000,
  });
  const nickB = await nicknameOf(pageB);
  await addChildNode(pageB, '乙的编辑'); // B 编辑 → B 进「正在编辑」

  const ctxC = await browser.newContext();
  const pageC = await ctxC.newPage();
  const phoneC = await registerAndLogin(pageC);
  await grantCollaborator(request, fileId, phoneC);
  await pageC.goto(`/edit/${fileId}`);
  await expect(pageC.locator('.editor-canvas svg .gm-text', { hasText: '本周计划' })).toBeVisible({
    timeout: 15_000,
  });
  const nickC = await nicknameOf(pageC); // C 只看不编辑 → editing=false

  await pageA.getByTestId('members-btn').click();
  const panel = pageA.getByTestId('member-panel');
  await expect(panel).toBeVisible();
  await expect(pageA.getByTestId('members-count')).toHaveText('3');
  await expect(panel.getByTestId('member-group-editing')).toContainText(nickA, { timeout: 10_000 });
  await expect(panel.getByTestId('member-group-editing')).toContainText(nickB);
  await expect(panel.getByTestId('member-group-viewing')).toContainText(nickC);

  // 创建者标识：owner（A 自己）行带「创建者」，B/C 行不带
  const rowA = panel.locator('[data-testid="member-row"]', { hasText: nickA });
  await expect(rowA.getByTestId('owner-badge')).toHaveText('创建者');
  const rowB = panel.locator('[data-testid="member-row"]', { hasText: nickB });
  await expect(rowB.getByTestId('owner-badge')).toHaveCount(0);

  // C 关闭页面 → A 面板内 C 行即时移除（在线数回落 2）
  await ctxC.close();
  await expect(
    panel.locator('[data-testid="member-row"]', { hasText: nickC }),
  ).toHaveCount(0, { timeout: 6_000 });
  await expect(pageA.getByTestId('members-count')).toHaveText('2');
});
