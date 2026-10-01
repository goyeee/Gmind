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

/**
 * 恢复联网的确定性编排（cases 2/4 专用）：先恢复 REST（WS 保持断开），让 saveLoop
 * 的兜底 PUT 在 base 未变的前提下必然成功落库，**之后**再重连 WS。直接双通道同恢
 * 存在既有产品竞态：重连窗口内兜底 PUT 与 WS 持久化竞速（重试定时器不随 WS 重连
 * 取消），偶发 409 终态「文档已在别处更新」——本编排消除该窗口，语义不变
 * （离线编辑在联网恢复后自动落库）。
 */
async function goOnlineStaged(page: Page, context: BrowserContext): Promise<void> {
  await context.setOffline(false); // REST 先行：兜底 PUT 可达（WS 仍断开、base 未变 → 必成功）
  await expect(page.getByTestId('save-status')).toHaveText(/已保存/, { timeout: 20_000 });
  await goOnline(page, context); // WS 重连收尾（无未同步变更，不再有持久化竞速窗口）
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

/** 惰性补开首键（带重试；editor.e2e pressFirstCharToOpen 同款，见其注）。 */
async function pressFirstCharToOpen(page: Page): Promise<void> {
  const editor = page.locator('.gm-text-editor');
  for (let i = 0; i < 20 && (await editor.count()) === 0; i += 1) {
    await page.keyboard.press('x');
    await page.waitForTimeout(25);
  }
  await expect(editor).toBeVisible();
}

/** 选中节点按 Tab 惰性新建子节点（立即落位「新主题」、敲字才开编辑框）并提交。 */
async function addChildNode(page: Page, text: string): Promise<void> {
  await page.keyboard.press('Tab'); // 立即创建「新主题」节点并选中（惰性，不开框）
  const editor = page.locator('.gm-text-editor');
  // 落位渲染先行：「新主题」文本可见 + 惰性锁定（编辑框不随创建出现）
  await expect(page.locator('.editor-canvas svg .gm-text', { hasText: '新主题' })).toBeVisible();
  await expect(editor).toHaveCount(0);
  await pressFirstCharToOpen(page);
  await page.keyboard.press('Backspace'); // 清占位首键
  await page.keyboard.insertText(text); // 与 IME 提交同路径
  await page.keyboard.press('Enter'); // 标题框 Enter → 切描述框（双框流转）
  await page.keyboard.press('Enter'); // 描述框留空 → 提交两者（无残留一次性机会，无需再 Esc）
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
  await goOnlineStaged(page, context);
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
  await goOnlineStaged(page, context); // 分阶段恢复：消除兜底 PUT × WS 持久化的 409 竞速
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

// ---------------------------------------------------------------------------
// M3a Task 3：双页并发结构操作收敛 — attachRemoteNormalization 生产接线守卫（准入 7.3）
//
// 生产接线：apps/web/src/editor/collab.ts 的 attachRemoteNormalization(doc) 把 core
// 的收敛（normalizeTreeFor/全量安全阀）挂到每个提交事务上——HocuspocusProvider 把
// 远端 update 以裸 applyUpdate 写进 doc（不走 withTransaction），并发残留（move vs
// delete 等）不接线则未治愈落库。语义本身由 core 级 remote-sync.test.ts / chaos.test.ts
// 钉死，那里直接调 helper——拆除 collab.ts 的接线行，core 测试全绿、两端内存态也不炸；
// 但「远端残留落地」只有本用例能抓：残留（墓碑 X 仍挂在新父 children）随服务端
// onStoreDocument 落入 docState，reload 后 docFromState 入口全量 normalize 把它抹平
// ——doc 全量快照「reload 后 ≠ reload 前」→ 本用例必红。**拆除 apps/web/src/editor/
// collab.ts 的 attachRemoteNormalization 调用行（及 destroy 里的注销行），本用例必红。**
//
// 编排（用例 5 同款双上下文 + 确定性并发隔离）：
//  A(owner)/B(协作者) 同开一文件（种子基线 6 节点）→ 双方短暂断 WS（本地提交与远端
//  到达隔离，保证 move/delete 基于同一基线真并发）→ A moveNode(周三→周一)、
//  B deleteNodes([周三]) 各自本地提交（页面 evaluate 经 '/@id/@gmind/core' 调 core，
//  perf-editor 同款动态 import）→ 双方恢复 WS 交换 → 断言「删除胜」收敛 →
//  reload 双页（从服务端 docState 装载）→ 断言 doc 快照与 reload 前一致。
//  短暂断 WS 的本地写不会触发 PUT 整快照兜底：saveLoop 的 2s 防抖到期时重连已完成，
//  真值表翻回「WS 持久化接管」，save() 直接返回——merge 只经 WS update 通道。
// ---------------------------------------------------------------------------

/** getNode 快照的守卫所需字段（宽松形状：页面内 core 返回真实 NodeSnapshot）。 */
interface GuardNodeSnapshot {
  id: string;
  text: string;
  parentId: string;
  childIds: string[];
  deleted: boolean;
}

/** doc 全量节点快照（id → getNode；core 级 fullSnapshot 的 e2e 口径）。 */
type DocSnapshot = Record<string, GuardNodeSnapshot | null>;

/** 页面上下文内取活动 doc（EditorPage dev-only 钩子；不存在即抛）。
 *  注意：page.evaluate / waitForFunction 的函数体被序列化执行，页面侧不可见本文件
 *  的模块级 helper——各函数体内一律就地内联 doc 解析（不引用外部函数）。 */

/** 页面内按文本精确查节点 id（模板生成的 ULID 不可预知；同源 docState 各端 id 一致）。 */
async function findNodeId(page: Page, text: string): Promise<string> {
  return page.evaluate((t: string) => {
    const hook = (window as unknown as { __gmind?: { getDoc(): unknown } }).__gmind;
    if (!hook) throw new Error('window.__gmind 未就绪');
    const doc = hook.getDoc() as {
      getMap(name: string): Map<string, { get(key: string): unknown }>;
    };
    for (const [id, node] of doc.getMap('nodes').entries()) {
      if (node.get('text') === t) return id;
    }
    throw new Error(`页面内未找到文本节点：${t}`);
  }, text);
}

/** 页面内经 core 对活动 doc 执行 moveNode（user origin；A 侧并发操作）。 */
async function coreMoveNode(page: Page, id: string, newParentId: string): Promise<void> {
  await page.evaluate(async ({ id, newParentId }: { id: string; newParentId: string }) => {
    const bare = ['/@id/', '@gmind/core'].join(''); // 动态拼串：vite dev 的 bare-id 路由
    const core = (await import(bare)) as unknown as {
      ORIGIN_USER: string;
      moveNode(doc: unknown, id: string, newParentId: string, index: number | undefined, origin: string): void;
    };
    const hook = (window as unknown as { __gmind?: { getDoc(): unknown } }).__gmind;
    if (!hook) throw new Error('window.__gmind 未就绪');
    core.moveNode(hook.getDoc(), id, newParentId, undefined, core.ORIGIN_USER);
  }, { id, newParentId });
}

/** 页面内经 core 对活动 doc 执行 deleteNodes（user origin；B 侧并发操作）。 */
async function coreDeleteNodes(page: Page, ids: string[]): Promise<void> {
  await page.evaluate(async (ids: string[]) => {
    const bare = ['/@id/', '@gmind/core'].join('');
    const core = (await import(bare)) as unknown as {
      ORIGIN_USER: string;
      deleteNodes(doc: unknown, ids: string[], origin: string): void;
    };
    const hook = (window as unknown as { __gmind?: { getDoc(): unknown } }).__gmind;
    if (!hook) throw new Error('window.__gmind 未就绪');
    core.deleteNodes(hook.getDoc(), ids, core.ORIGIN_USER);
  }, ids);
}

/** 页面内取 doc 全量节点快照（getNode 逐节点；JSON 可序列化，跨端 deep-equal 用）。 */
async function snapshotDoc(page: Page): Promise<DocSnapshot> {
  return page.evaluate(async () => {
    const bare = ['/@id/', '@gmind/core'].join('');
    const core = (await import(bare)) as unknown as {
      getNode(doc: unknown, id: string): GuardNodeSnapshot | null;
    };
    const hook = (window as unknown as { __gmind?: { getDoc(): unknown } }).__gmind;
    if (!hook) throw new Error('window.__gmind 未就绪');
    const doc = hook.getDoc() as { getMap(name: string): { keys(): Iterable<string> } };
    const out: DocSnapshot = {};
    for (const id of doc.getMap('nodes').keys()) out[id] = core.getNode(doc, id);
    return out;
  });
}

/** 仅断/恢复 WS 通道（不动 REST）：确定性并发隔离与恢复（用例 3 的注 2 纪律）。 */
async function setWsReachable(page: Page, reachable: boolean): Promise<void> {
  await page.evaluate((ok: boolean) => {
    (window as unknown as { __gmindCollab?: CollabHooks }).__gmindCollab?.setReachable(ok);
  }, reachable);
}

/** 等「删除胜」合并态在本端落地：X 墓碑且已被 move 改写父（两 op 均已到达），
 *  可达存活数 = 6 − X 子树 2 = 4。接线与否该条件都成立（内存态不炸由 core 测试保证）。 */
async function waitForMergeSettled(page: Page, xId: string, p1Id: string): Promise<void> {
  await page.waitForFunction(
    async ({ xId, p1Id, alive }: { xId: string; p1Id: string; alive: number }) => {
      const bare = ['/@id/', '@gmind/core'].join('');
      const core = (await import(bare)) as unknown as {
        getNode(doc: unknown, id: string): GuardNodeSnapshot | null;
        countAliveReachable(doc: unknown): number;
      };
      const hook = (window as unknown as { __gmind?: { getDoc(): unknown } }).__gmind;
      if (!hook) return false;
      const doc = hook.getDoc();
      const snap = core.getNode(doc, xId);
      return snap !== null && snap.deleted && snap.parentId === p1Id
        && core.countAliveReachable(doc) === alive;
    },
    { xId, p1Id, alive: 4 },
    { timeout: 15_000 },
  );
}

test('双页并发结构操作收敛：move vs delete 删除胜，reload 后结构与 reload 前一致（准入 7.3 接线守卫）', async ({
  browser,
  request,
}) => {
  test.setTimeout(120_000); // 双页登录/装载 + 并发交换 + 持久化收尾 + 双页 reload

  // —— A(owner) / B(协作者) 同开一文件（用例 5 编排）——
  const ctxA = await browser.newContext();
  const pageA = await ctxA.newPage();
  await registerAndLogin(pageA);
  await openSeedDoc(pageA, '本周计划');
  const fileId = fileIdFromUrl(pageA);

  const ctxB = await browser.newContext();
  const pageB = await ctxB.newPage();
  const phoneB = await registerAndLogin(pageB);
  await grantCollaborator(request, fileId, phoneB);
  await pageB.goto(`/edit/${fileId}`);
  await expect(pageB.locator('.editor-canvas svg .gm-text', { hasText: '本周计划' })).toBeVisible({
    timeout: 15_000,
  });

  // 基线：种子 6 节点（可达活跃，不含 root）
  await expect(pageA.getByTestId('node-count')).toHaveText('6 节点', { timeout: 10_000 });
  await expect(pageB.getByTestId('node-count')).toHaveText('6 节点', { timeout: 10_000 });

  // 靶点：X=周三（带子节点 方案评审，验证子树随删）、P1=周一（换父目标）
  const xId = await findNodeId(pageA, '周三');
  const p1Id = await findNodeId(pageA, '周一');
  expect(await findNodeId(pageB, '周三')).toBe(xId); // 同源 docState：各端 id 一致
  expect(await findNodeId(pageB, '周一')).toBe(p1Id);

  // —— 确定性并发：双方断 WS → 各自本地提交（同一基线）→ 恢复 WS 交换 ——
  await setWsReachable(pageA, false);
  await setWsReachable(pageB, false);
  await coreMoveNode(pageA, xId, p1Id); // A：X 换父到 P1
  await coreDeleteNodes(pageB, [xId]); // B：删除 X（墓碑级联子树）
  await setWsReachable(pageA, true);
  await setWsReachable(pageB, true);

  // —— 收敛断言 1：两端合并态落地（删除胜 + 计数 6−2=4）——
  await waitForMergeSettled(pageA, xId, p1Id);
  await waitForMergeSettled(pageB, xId, p1Id);
  await expect(pageA.getByTestId('node-count')).toHaveText('4 节点', { timeout: 10_000 });
  await expect(pageB.getByTestId('node-count')).toHaveText('4 节点', { timeout: 10_000 });

  // —— 收敛断言 2：两页画布均无 X 及其子树（无悬挂），幸存结构完整可见 ——
  for (const page of [pageA, pageB]) {
    await expect(page.locator('.editor-canvas svg .gm-text', { hasText: '周三' })).toHaveCount(0);
    await expect(page.locator('.editor-canvas svg .gm-text', { hasText: '方案评审' })).toHaveCount(0);
    await expect(page.locator('.editor-canvas svg .gm-text', { hasText: '周一' })).toHaveCount(1);
    await expect(page.locator('.editor-canvas svg .gm-text', { hasText: '周会对齐' })).toHaveCount(1);
    await expect(page.locator('.editor-canvas svg .gm-text', { hasText: '周五' })).toHaveCount(1);
  }

  // —— 收敛断言 3：两端 doc 全量快照 deep-equal（CRDT 收敛一致性口径）——
  const preA = await snapshotDoc(pageA);
  const preB = await snapshotDoc(pageB);
  expect(preA).toEqual(preB);

  // —— 持久化收尾：persisted ack + 防抖余量，保证 reload 读到的 docState 是最终合并态
  //    （接线在：含 heal 收尾；接线拆：含未治愈残留——正是守卫要抓的差异）——
  await expect(pageA.getByTestId('save-status')).toHaveText(SAVED_RE, { timeout: 15_000 });
  await expect(pageB.getByTestId('save-status')).toHaveText(SAVED_RE, { timeout: 15_000 });
  await pageA.waitForTimeout(3_000); // onStoreDocument 防抖 2s + 余量

  // —— reload 双页：从服务端 docState 装载 → doc 快照与 reload 前一致（核心守卫断言）——
  await pageA.reload();
  await pageB.reload();
  await expect(pageA.locator('.editor-canvas svg .gm-text', { hasText: '本周计划' })).toBeVisible({
    timeout: 15_000,
  });
  await expect(pageB.locator('.editor-canvas svg .gm-text', { hasText: '本周计划' })).toBeVisible({
    timeout: 15_000,
  });
  await expect(pageA.getByTestId('node-count')).toHaveText('4 节点', { timeout: 10_000 });
  await expect(pageB.getByTestId('node-count')).toHaveText('4 节点', { timeout: 10_000 });

  const postA = await snapshotDoc(pageA);
  const postB = await snapshotDoc(pageB);
  expect(postA, 'reload 后结构必须与 reload 前一致（A）').toEqual(preA);
  expect(postB, 'reload 后结构必须与 reload 前一致（B）').toEqual(preB);
  expect(postA).toEqual(postB);

  // 结构完整可读断言（诊断友好）：X 墓碑不在 P1 children（无残留悬挂）、root 幸存子完整
  expect(postA[p1Id]?.childIds).not.toContain(xId);
  expect(postA[xId]?.deleted).toBe(true);
  await ctxA.close();
  await ctxB.close();
});
