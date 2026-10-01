import { expect, test, type Page } from '@playwright/test';

/**
 * 前端埋点 E2E — M5 Task 4（PRD 6.4：node_add/node_delete/perf_metric/error_occur）。
 *
 * 拦截口径（M2 教训，collab.e2e.spec.ts 注 2/3）：只拦 pathname 恰为 /api/events 的
 * POST——通配后缀的 glob 会误伤 vite dev 的模块 URL（如本任务新增的
 * /src/api/events.ts 模块请求），路由层再按 pathname.endsWith('/api/events') 双保险。
 * 事件经 page.route 收集后放行（真实端点 204 即落库，同时被服务端 e2e 的直查断言覆盖）。
 *
 * error_occur 编排裁定：save-fail 的确定性路径要求「WS 自认在线但 REST 持续失败」的
 * 错位窗口，无法稳定编排（setReachable(false) 是受支持的离线态，走离线文案而非失败
 * 事件）；改用 load-fail 形态——登录后直接访问不存在的文件 id：GET 404 且 IndexedDB
 * 无本地副本 → 错误态（编辑器渲染 editor-error），error_occur {kind:'load-fail',
 * recovered:false} 确定性到达。
 */

/** POST /api/events 的 body 形状（payload 内含公共参数 clientVersion/sessionId）。 */
type EventBody = {
  type: string;
  fileId?: string;
  payload: { clientVersion?: string; sessionId?: string } & Record<string, unknown>;
};

/** 拦截并收集 POST /api/events（放行真实请求），按需过滤类型。 */
async function collectEvents(page: Page): Promise<EventBody[]> {
  const events: EventBody[] = [];
  await page.route('**/api/events', (route) => {
    const url = new URL(route.request().url());
    // pathname 精确匹配（双保险）：vite dev 模块 URL 形如 /src/api/events.ts 不得误入
    if (route.request().method() === 'POST' && url.pathname.endsWith('/api/events')) {
      events.push(route.request().postDataJSON() as EventBody);
    }
    void route.continue();
  });
  return events;
}

/** 公共参数断言：clientVersion/sessionId 均为非空字符串，且与 sessionStorage 一致。 */
async function expectCommonParams(page: Page, body: EventBody): Promise<void> {
  expect(typeof body.payload.clientVersion).toBe('string');
  expect((body.payload.clientVersion as string).length).toBeGreaterThan(0);
  expect(typeof body.payload.sessionId).toBe('string');
  expect((body.payload.sessionId as string).length).toBeGreaterThan(0);
  await expect
    .poll(() => page.evaluate(() => sessionStorage.getItem('gmind.sid')))
    .toBe(body.payload.sessionId);
}

async function registerAndLogin(page: Page): Promise<string> {
  await page.goto('/login');
  const phone = '138' + String(Math.floor(10000000 + Math.random() * 89999999));
  await page.getByPlaceholder('手机号').fill(phone);
  await page.getByPlaceholder('验证码（开发环境固定 123456）').fill('123456');
  await page.getByRole('button', { name: '登录', exact: true }).click();
  await expect(page).toHaveURL(/\/workspace/);
  await expect(page.locator('.file-list li')).toHaveCount(3);
  return phone;
}

/** 打开种子文件进入编辑器，返回 fileId（URL 尾段）。 */
async function openSeedDoc(page: Page, title: string): Promise<string> {
  await page.locator('.file-list li', { hasText: title }).click();
  await expect(page).toHaveURL(/\/edit\//);
  await expect(page.locator('.editor-canvas svg .gm-text', { hasText: title })).toBeVisible();
  return page.url().split('/edit/')[1] ?? '';
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

/** 选中节点按 Tab 惰性新建子节点并键入文本提交（collab.e2e.spec.ts 同款）。
 *  埋点时机不变：node_add 在 Tab 创建瞬间即上报，编辑框只是延迟到首字符。 */
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
  await page.keyboard.press('Enter'); // 描述框留空 → 提交两者
  await expect(editor).toHaveCount(0);
}

test('键盘增删节点：node_add/node_delete 各上报一次，via=keyboard 且公共参数齐全', async ({ page }) => {
  const events = await collectEvents(page);
  await registerAndLogin(page);
  const fileId = await openSeedDoc(page, '本周计划');

  await addChildNode(page, '埋点新节点');
  await expect(page.locator('.editor-canvas svg .gm-text', { hasText: '埋点新节点' })).toBeVisible();

  // 新节点提交后即为选中态：Delete 删除 → node_delete
  await page.keyboard.press('Delete');
  await expect(page.locator('.editor-canvas svg .gm-text', { hasText: '埋点新节点' })).toHaveCount(0);

  const added = events.filter((e) => e.type === 'node_add');
  await expect.poll(() => added.length).toBe(1);
  expect(added[0].fileId).toBe(fileId);
  expect(added[0].payload.via).toBe('keyboard');
  expect(typeof added[0].payload.nodeCount).toBe('number');
  await expectCommonParams(page, added[0]);

  const deleted = events.filter((e) => e.type === 'node_delete');
  await expect.poll(() => deleted.length).toBe(1);
  expect(deleted[0].fileId).toBe(fileId);
  expect(deleted[0].payload.via).toBe('keyboard');
  expect(typeof deleted[0].payload.nodeCount).toBe('number');
  // 同一页面会话：两事件共享 sessionId
  expect(deleted[0].payload.sessionId).toBe(added[0].payload.sessionId);
});

test('剪切（Ctrl+X）删除节点同样上报 node_delete via=keyboard（cut 复合操作计入删除流）', async ({ page }) => {
  const events = await collectEvents(page);
  await registerAndLogin(page);
  await openSeedDoc(page, '本周计划');

  await addChildNode(page, '待剪切节点');
  await page.keyboard.press('Control+X');
  await expect(page.locator('.editor-canvas svg .gm-text', { hasText: '待剪切节点' })).toHaveCount(0);

  // 评审修复轮 Important #2：cut 的删除侧此前绕过 handleDelete 不上报——粘贴回来时
  // +1 node_add(paste) 而删除流为 0，事件流不对称
  const deleted = events.filter((e) => e.type === 'node_delete');
  await expect.poll(() => deleted.length).toBe(1);
  expect(deleted[0].payload.via).toBe('keyboard');
  expect(typeof deleted[0].payload.nodeCount).toBe('number');
  await expectCommonParams(page, deleted[0]);
});

test('右键菜单增删节点：node_add/node_delete 的 via=context', async ({ page }) => {
  const events = await collectEvents(page);
  await registerAndLogin(page);
  await openSeedDoc(page, '本周计划');

  // root 节点上右键 → 插入子级 → 输入提交（惰性：插入即落位「新主题」，敲字才开框）
  const rootText = page.locator('.editor-canvas svg .gm-text', { hasText: '本周计划' });
  await rootText.click({ button: 'right' });
  await page.getByRole('menu').getByRole('button', { name: '插入子级' }).click();
  const editor = page.locator('.gm-text-editor');
  // 落位渲染先行：「新主题」文本可见 + 惰性锁定（右键插入也不立即开框）
  await expect(page.locator('.editor-canvas svg .gm-text', { hasText: '新主题' })).toBeVisible();
  await expect(editor).toHaveCount(0);
  await pressFirstCharToOpen(page);
  await page.keyboard.press('Backspace');
  await page.keyboard.insertText('右键新节点'); // 与 IME 提交同路径
  await page.keyboard.press('Enter'); // 标题框 → 描述框（双框流转）
  await page.keyboard.press('Enter'); // 描述框留空 → 提交两者
  await expect(page.locator('.editor-canvas svg .gm-text', { hasText: '右键新节点' })).toBeVisible();

  const added = events.filter((e) => e.type === 'node_add');
  await expect.poll(() => added.length).toBe(1);
  expect(added[0].payload.via).toBe('context');
  await expectCommonParams(page, added[0]);

  // 新节点上右键 → 删除。右键菜单（含「任务设置」等 9 项）锚定点击点向下展开、
  // 无视口钳制：新节点落位偏下时「删除」项会越出视口底缘（产品挂账：菜单越界），
  // 沿用 versions spec 的 DOM click 直发模式触发同一 React onClick 路径。
  await page.locator('.editor-canvas svg .gm-text', { hasText: '右键新节点' }).click({ button: 'right' });
  await page
    .getByRole('menu')
    .getByRole('button', { name: '删除', exact: true })
    .dispatchEvent('click');
  await expect(page.locator('.editor-canvas svg .gm-text', { hasText: '右键新节点' })).toHaveCount(0);

  const deleted = events.filter((e) => e.type === 'node_delete');
  await expect.poll(() => deleted.length).toBe(1);
  expect(deleted[0].payload.via).toBe('context');
});

test('装载完成上报 perf_metric 恰一次（firstInteractionMs 数值）', async ({ page }) => {
  const events = await collectEvents(page);
  await registerAndLogin(page);
  await openSeedDoc(page, '本周计划');

  const perfs = events.filter((e) => e.type === 'perf_metric');
  await expect.poll(() => perfs.length, { timeout: 10_000 }).toBe(1);
  expect(typeof perfs[0].payload.firstInteractionMs).toBe('number');
  expect(perfs[0].payload.firstInteractionMs as number).toBeGreaterThanOrEqual(0);
  await expectCommonParams(page, perfs[0]);
});

test('装载失败上报 error_occur {kind:"load-fail",recovered:false}', async ({ page }) => {
  const events = await collectEvents(page);
  await registerAndLogin(page);
  // 26 字符 ULID 形状但不存在：GET 404 且 IndexedDB 无本地副本 → 错误态
  await page.goto('/edit/01ZZZZZZZZZZZZZZZZZZZZZZZZZ');
  await expect(page.locator('.editor-error')).toBeVisible();

  const errors = events.filter((e) => e.type === 'error_occur');
  await expect.poll(() => errors.length, { timeout: 10_000 }).toBe(1);
  expect(errors[0].payload).toMatchObject({ kind: 'load-fail', recovered: false });
  await expectCommonParams(page, errors[0]);
});
