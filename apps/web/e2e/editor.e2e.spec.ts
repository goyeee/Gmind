import { expect, test, type Page } from '@playwright/test';
import * as Y from 'yjs';

/**
 * 编辑器页面（/edit/:fileId）E2E — M1b Task 11。
 *
 * 复用 M0 登录模式：新手机号注册即赠 3 个种子文件（登录 helper 内联自
 * m0-acceptance.e2e.spec.ts）；用例直接打开种子文件「本周计划」。
 * 用例 2/3/4 各自自足（先按用例 2 的流程创建「新节点」再断言各自关注点），
 * 互不共享状态、可并行。
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

/** 打开种子文件进入编辑器，等待 root 文本渲染。 */
async function openSeedDoc(page: Page, title: string): Promise<void> {
  await registerAndLogin(page);
  await page.locator('.file-list li', { hasText: title }).click();
  await expect(page).toHaveURL(/\/edit\//);
  await expect(page.locator('.editor-canvas svg .gm-text', { hasText: title })).toBeVisible();
}

/**
 * 惰性补开首键（带重试）：Tab 后布局盒子流水未就绪时，补开按键被保留待重试
 * （openPendingEditor 就绪语义；盒就绪前的按键不产生任何文本插入）——重试按
 * ASCII 首键至编辑框出现，首键即占位字符（随后退格清掉、insertText 写入中文）。
 * Playwright 纪律：非美式键盘字符（中文）经 keyboard.type/insertText 不产生
 * keydown，触发不了惰性补开，首键必须用 ASCII 可打印键。
 */
async function pressFirstCharToOpen(page: Page): Promise<void> {
  const editor = page.locator('.gm-text-editor');
  for (let i = 0; i < 20 && (await editor.count()) === 0; i += 1) {
    await page.keyboard.press('x');
    await page.waitForTimeout(25);
  }
  await expect(editor).toBeVisible();
}

/**
 * 用例 2 的创建流程（2026-09-28 惰性编辑语义）：Tab **立即创建**文本为「新主题」的
 * 节点并选中，但**不**立刻打开行内编辑框；敲下首个可打印字符时编辑框才出现
 * （打开即全选默认文本，首字符替换之、其余追加），Enter 提交。
 */
async function createNewNodeViaKeyboard(page: Page): Promise<void> {
  await page.keyboard.press('Tab'); // root 为默认选中：立即落位「新主题」节点（惰性，不开框）
  const editor = page.locator('.gm-text-editor');
  // 落位渲染先行：「新主题」文本可见 + 惰性锁定（编辑框不随创建出现）
  await expect(page.locator('.editor-canvas svg .gm-text', { hasText: '新主题' })).toBeVisible();
  await expect(editor).toHaveCount(0);
  await pressFirstCharToOpen(page);
  await expect(editor).toBeFocused();
  await page.keyboard.press('Backspace'); // 清占位首键
  await page.keyboard.insertText('新节点'); // 与 IME 提交同路径
  await page.keyboard.press('Enter');
  await expect(editor).toHaveCount(0);
}

// 用例 1：打开种子文件「本周计划」→ root 文本可见、子节点渲染
test('编辑器：打开种子文件后 root 与子节点渲染', async ({ page }) => {
  await openSeedDoc(page, '本周计划');
  await expect(page.locator('.editor-canvas svg .gm-text', { hasText: '周一' })).toBeVisible();
  await expect(page.locator('.editor-canvas svg .gm-text', { hasText: '周三' })).toBeVisible();
  await expect(page.locator('.editor-canvas svg .gm-text', { hasText: '周五' })).toBeVisible();
  // root + 3 子 + 3 孙 = 6 条连接线（mindmap 为 bezier）
  await expect(page.locator('.editor-canvas svg path[data-edge-id]')).toHaveCount(6);
});

// 用例 2：Tab 新建节点进入编辑态 → 提交后画布出现；保存指示「保存中…」→「已保存」
test('编辑器：Tab 新建节点提交后画布出现且自动保存', async ({ page }) => {
  await openSeedDoc(page, '本周计划');
  // 放慢 doc-state PUT，让「保存中…」指示可被稳定观察
  await page.route('**/api/files/*/doc-state', async (route) => {
    await new Promise((resolve) => setTimeout(resolve, 600));
    await route.continue();
  });
  await createNewNodeViaKeyboard(page);
  await expect(page.locator('.editor-canvas svg .gm-text', { hasText: '新节点' })).toBeVisible();
  const status = page.getByTestId('save-status');
  await expect(status).toHaveText(/保存中/);
  await expect(status).toHaveText(/已保存/);
});

// 用例 2b（2026-09-28 惰性创建语义）：Tab 立即落位「新主题」节点、敲字才进编辑、
// Esc 取消回收（待编辑态下按 Esc 直接删掉新建节点，不留空壳）
test('编辑器：惰性创建——Tab 立即落位新主题节点、敲字才进编辑、Esc 取消回收', async ({ page }) => {
  await openSeedDoc(page, '本周计划');
  const groups = page.locator('.editor-canvas svg g[data-node-id]');
  const before = await groups.count();
  await page.keyboard.press('Tab');
  // 节点立即出现在树中（默认文本「新主题」同事务写入，不落空壳）
  await expect(groups).toHaveCount(before + 1);
  await expect(page.locator('.editor-canvas svg .gm-text', { hasText: '新主题' })).toBeVisible();
  // 惰性锁定：编辑框此刻不出现
  await expect(page.locator('.gm-text-editor')).toHaveCount(0);
  // 待编辑态 Esc 取消创建：节点回收不留壳，编辑框始终未出现
  await page.keyboard.press('Escape');
  await expect(page.locator('.gm-text-editor')).toHaveCount(0);
  await expect(groups).toHaveCount(before);
  // 再次新建：敲字补开编辑框 → Enter 提交路径仍工作
  await page.keyboard.press('Tab');
  await expect(groups).toHaveCount(before + 1);
  await expect(page.locator('.editor-canvas svg .gm-text', { hasText: '新主题' })).toBeVisible();
  await pressFirstCharToOpen(page);
  await page.keyboard.press('Backspace');
  await page.keyboard.insertText('落位节点');
  await page.keyboard.press('Enter');
  await expect(page.locator('.gm-text-editor')).toHaveCount(0);
  await expect(page.locator('.editor-canvas svg .gm-text', { hasText: '落位节点' })).toBeVisible();
  await expect(groups).toHaveCount(before + 1);
});

// 用例 2c（2026-10-01 需求方反馈任务 1）：新建提交文本后按 Tab → 描述编辑浮层
// （复用 .gm-text-editor，锚定节点盒下一行；仅非简洁模式）——Enter 写入 Y.Doc
// description；该次 Tab 不再新建子主题（节点数不增，日常 Tab 建子语义不受影响）。
test('编辑器：新建提交后 Tab 打开描述浮层，Enter 写入描述', async ({ page }) => {
  await openSeedDoc(page, '本周计划');
  await expect(page.locator('.editor-canvas svg .gm-text')).toHaveCount(7); // 种子 root+3子+3孙
  // 新建（惰性）→ 敲字补开编辑框 → Enter 提交文本（提交后挂一次「Tab 直填描述」机会）
  await page.keyboard.press('Tab');
  await expect(page.locator('.editor-canvas svg .gm-text', { hasText: '新主题' })).toBeVisible();
  await pressFirstCharToOpen(page);
  await page.keyboard.press('Backspace');
  await page.keyboard.insertText('需求评审');
  await page.keyboard.press('Enter');
  await expect(page.locator('.gm-text-editor')).toHaveCount(0);
  // Tab：打开描述编辑浮层（不是新建子主题——文本总数仍 8）
  await page.keyboard.press('Tab');
  const desc = page.locator('.gm-text-editor');
  await expect(desc).toBeVisible();
  await expect(desc).toBeFocused();
  await expect(page.locator('.editor-canvas svg .gm-text')).toHaveCount(8);
  await page.keyboard.insertText('一句话任务描述');
  await page.keyboard.press('Enter');
  await expect(desc).toHaveCount(0);
  await expect(page.getByTestId('save-status')).toHaveText(/已保存/);
  // Y.Doc description 断言：保存后的 docState 反解，新节点 description 已写入
  const token = await page.evaluate(() => localStorage.getItem('gmind.token'));
  const fileId = page.url().split('/').pop() ?? '';
  const res = await page.request.get(`/api/files/${fileId}`, {
    headers: { Authorization: `Bearer ${token ?? ''}` },
  });
  expect(res.ok()).toBeTruthy();
  const detail = (await res.json()) as { docState: string };
  const doc = new Y.Doc();
  const binary = atob(detail.docState); // web tsconfig 无 node types，不用 Buffer
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  Y.applyUpdate(doc, bytes);
  const nodes = doc.getMap('nodes') as Y.Map<Y.Map<unknown>>;
  const textOf = (id: string): string => String(nodes.get(id)?.get('text') ?? '');
  const rootKids = ((nodes.get('root')?.get('children') as Y.Array<string>)?.toArray() ?? []);
  const newId = rootKids.find((id) => textOf(id) === '需求评审');
  expect(newId).toBeTruthy();
  expect(String(nodes.get(newId as string)?.get('description') ?? '')).toBe('一句话任务描述');
});

// 用例 3：保存后刷新页面，「新节点」仍在（持久化闭环）
test('编辑器：保存后刷新页面新建节点仍在', async ({ page }) => {
  await openSeedDoc(page, '本周计划');
  await createNewNodeViaKeyboard(page);
  await expect(page.getByTestId('save-status')).toHaveText(/已保存/);
  await page.reload();
  await expect(page.locator('.editor-canvas svg .gm-text', { hasText: '本周计划' })).toBeVisible();
  await expect(page.locator('.editor-canvas svg .gm-text', { hasText: '新节点' })).toBeVisible();
});

// 用例 4：Ctrl+Z 撤销新建节点消失；Ctrl+Y 重做回来
test('编辑器：Ctrl+Z 撤销新建节点后 Ctrl+Y 重做恢复', async ({ page }) => {
  await openSeedDoc(page, '本周计划');
  await createNewNodeViaKeyboard(page);
  await expect(page.locator('.editor-canvas svg .gm-text', { hasText: '新节点' })).toBeVisible();
  await page.keyboard.press('Control+Z');
  await expect(page.locator('.editor-canvas svg .gm-text', { hasText: '新节点' })).toHaveCount(0);
  await page.keyboard.press('Control+Y');
  await expect(page.locator('.editor-canvas svg .gm-text', { hasText: '新节点' })).toBeVisible();
});

// 用例 5：结构切换到组织架构图 → 边形态 bezier→elbow；Ctrl+Z 恢复。
// 2026-09-30 任务 3：structure-select 下拉移除，改走 structure-toggle 打开的
// 图形化结构面板（structure-item-org 卡片），应用即收起面板，断言口径不变。
test('编辑器：结构切换为组织架构图后边形态变化且可撤销', async ({ page }) => {
  await openSeedDoc(page, '本周计划');
  const firstEdge = page.locator('.editor-canvas svg path[data-edge-id]').first();
  await expect(firstEdge).toHaveAttribute('d', / C /); // mindmap：bezier
  await page.getByTestId('structure-toggle').click();
  await page.getByTestId('structure-item-org').click();
  await expect(page.getByTestId('structure-panel')).toHaveCount(0); // 应用即收起
  await expect(firstEdge).toHaveAttribute('d', / L /); // org：elbow（正交折线）
  await expect(firstEdge).not.toHaveAttribute('d', / C /);
  // 焦点移出下拉框后再撤销
  await page.locator('.editor-canvas svg').click({ position: { x: 30, y: 30 } });
  await page.keyboard.press('Control+Z');
  await expect(firstEdge).toHaveAttribute('d', / C /);
});

// 用例 5b（2026-09-30 任务 3 新增）：结构面板正向链路——打开面板 → 点「逻辑图
// （向右）」应用并收起 → 重开面板确认当前结构高亮 → Esc 关闭 → 面板切「组织架构
// 图」复用用例 5 边形态断言（logic 与 mindmap 同为 bezier 边、种子树全在根右侧，
// 引擎侧无独立边形态可断言，故应用断言落在 org 的 elbow 上——报告已登记）。
test('编辑器：结构面板应用逻辑图并收起，组织架构图边形态 elbow', async ({ page }) => {
  await openSeedDoc(page, '本周计划');
  const firstEdge = page.locator('.editor-canvas svg path[data-edge-id]').first();
  await page.getByTestId('structure-toggle').click();
  const panel = page.getByTestId('structure-panel');
  await expect(panel).toBeVisible();
  // 当前结构（mindmap）卡片高亮
  await expect(page.getByTestId('structure-item-mindmap')).toHaveAttribute('aria-pressed', 'true');
  await page.getByTestId('structure-item-logic').click();
  await expect(panel).toHaveCount(0); // 应用即收起
  // 重开面板：logic 卡片已高亮（结构已写入 doc meta）
  await page.getByTestId('structure-toggle').click();
  await expect(page.getByTestId('structure-item-logic')).toHaveAttribute('aria-pressed', 'true');
  await page.keyboard.press('Escape'); // Esc 关闭
  await expect(panel).toHaveCount(0);
  // 面板内切组织架构图：边 bezier → elbow（复用用例 5 断言）
  await page.getByTestId('structure-toggle').click();
  await page.getByTestId('structure-item-org').click();
  await expect(panel).toHaveCount(0);
  await expect(firstEdge).toHaveAttribute('d', / L /);
  await expect(firstEdge).not.toHaveAttribute('d', / C /);
});

// 用例 5c（2026-09-30 需求方四条反馈任务 1 新增）：结构面板 = 按钮正下方贴靠的
// 锚定下拉（企微式，不再是 fixed 右上浮层）——几何断言：面板 top 严格大于按钮
// bottom（正下方展开）、面板 left 与按钮 left 差 < 200px（左缘贴靠按钮而非视口
// 右上角）；应用逻辑图后面板收起（开合/写链路不受挂载点迁移影响）。
test('编辑器：结构面板贴靠结构按钮正下方展开（锚定下拉），应用逻辑图后收起', async ({ page }) => {
  await openSeedDoc(page, '本周计划');
  await page.getByTestId('structure-toggle').click();
  const panel = page.getByTestId('structure-panel');
  await expect(panel).toBeVisible();
  const btnBox = await page.getByTestId('structure-toggle').boundingBox();
  const panelBox = await panel.boundingBox();
  expect(btnBox, '结构按钮必须已渲染').toBeTruthy();
  expect(panelBox, '结构面板必须已渲染').toBeTruthy();
  // 面板顶 > 按钮底：面板在按钮正下方（而非视口右上 fixed 浮层）
  expect(panelBox!.y).toBeGreaterThan(btnBox!.y + btnBox!.height);
  // 面板左缘贴靠按钮左缘（差 < 200px；fixed 右上旧形态下差距为数百 px 必挂）
  expect(Math.abs(panelBox!.x - btnBox!.x)).toBeLessThan(200);
  // 贴靠不得溢出视口右缘（1280 视口下按钮左对齐直落，钳制兜底不触发）
  expect(panelBox!.x + panelBox!.width).toBeLessThanOrEqual(1280);
  await page.getByTestId('structure-item-logic').click();
  await expect(panel).toHaveCount(0); // 应用即收起
});

// 用例 6：折叠子节点 →「+N」徽标出现；再展开消失
test('编辑器：折叠 root 后出现 +N 徽标，展开后消失', async ({ page }) => {
  await openSeedDoc(page, '本周计划');
  // root 为默认选中；折叠孙辈文本先确认可见
  await expect(page.locator('.editor-canvas svg .gm-text', { hasText: '周会对齐' })).toBeVisible();
  await page.keyboard.press('Control+/');
  const badge = page.locator('.editor-canvas svg .gm-collapse-badge');
  await expect(badge).toHaveCount(1);
  await expect(badge).toContainText(/\+\d+/);
  await expect(page.locator('.editor-canvas svg .gm-text', { hasText: '周会对齐' })).toHaveCount(0);
  await page.keyboard.press('Control+/');
  await expect(page.locator('.editor-canvas svg .gm-collapse-badge')).toHaveCount(0);
  await expect(page.locator('.editor-canvas svg .gm-text', { hasText: '周会对齐' })).toBeVisible();
});

// ─────────────── fix round 1 新增 ───────────────

// 修复 1：主题切换重建场景后视口变换保留（不回到恒等变换）。
// 主题入口（M7b-W2 #6 裁定）只留面板按钮：theme-select 下拉已移除，走 theme-panel。
test('编辑器：主题切换后视口变换保留', async ({ page }) => {
  await openSeedDoc(page, '本周计划');
  await page.waitForTimeout(300); // 等待初始「适应画布」（rAF 内执行）
  const vpG = page.locator('.editor-canvas svg .gm-viewport');
  const before = await vpG.getAttribute('transform');
  expect(before).toBeTruthy();
  expect(before).not.toBe('translate(0, 0) scale(1)'); // 初始 fit 后必非恒等
  await page.getByTestId('theme-panel-toggle').click();
  await page.getByTestId('theme-item-gmind-warm').click(); // 套用即关闭抽屉
  await expect(page.getByTestId('theme-panel')).toHaveCount(0);
  await expect(vpG).toHaveAttribute('transform', before as string);
});

// 修复 2：编辑后 2s 防抖内立即返回工作台 → 卸载冲刷保存 → 重开文件变更仍在
test('编辑器：编辑后立即返回工作台，卸载冲刷保存持久化', async ({ page }) => {
  await openSeedDoc(page, '本周计划');
  await page.locator('.editor-canvas svg .gm-text', { hasText: '周一' }).dblclick();
  const editor = page.locator('.gm-text-editor');
  await expect(editor).toBeVisible();
  await page.keyboard.type('周一改'); // 覆盖全选文本
  await page.keyboard.press('Enter');
  await page.getByTestId('back-btn').click(); // 2s 防抖窗口内离开 → 触发卸载冲刷
  await expect(page).toHaveURL(/\/workspace/);
  await page.waitForTimeout(800); // 冲刷 PUT 落库
  await page.locator('.file-list li', { hasText: '本周计划' }).click();
  await expect(page.locator('.editor-canvas svg .gm-text', { hasText: '周一改' })).toBeVisible();
});

// 修复 3：Shift+Tab 在节点与父之间插入新父（P→N→C，PRD FR-EDT-001）——按保存后的
// docState 结构断言：原父在原 index 处持有新节点（惰性创建默认文本「新主题」），
// 新节点 children = [原节点]。
test('编辑器：Shift+Tab 在节点与父之间插入新父', async ({ page }) => {
  await openSeedDoc(page, '本周计划');
  await expect(page.locator('.editor-canvas svg .gm-text')).toHaveCount(7);
  await page.locator('.editor-canvas svg .gm-text', { hasText: '周三' }).click(); // 周三有子「方案评审」
  await page.keyboard.press('Shift+Tab');
  await expect(page.locator('.editor-canvas svg .gm-text')).toHaveCount(8); // +1 新节点（默认文本「新主题」）
  await expect(page.getByTestId('save-status')).toHaveText(/已保存/);

  // 从服务端读回 docState 反解结构（避免依赖渲染几何）
  const token = await page.evaluate(() => localStorage.getItem('gmind.token'));
  const fileId = page.url().split('/').pop() ?? '';
  const res = await page.request.get(`/api/files/${fileId}`, {
    headers: { Authorization: `Bearer ${token ?? ''}` },
  });
  expect(res.ok()).toBeTruthy();
  const detail = (await res.json()) as { docState: string };
  const doc = new Y.Doc();
  const binary = atob(detail.docState); // web tsconfig 无 node types，不用 Buffer
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  Y.applyUpdate(doc, bytes);
  const nodes = doc.getMap('nodes') as Y.Map<Y.Map<unknown>>;
  const childIds = (id: string): string[] =>
    ((nodes.get(id)?.get('children') as Y.Array<string> | undefined)?.toArray() ?? []);
  const textOf = (id: string): string => String(nodes.get(id)?.get('text') ?? '');

  const rootKids = childIds('root');
  expect(rootKids.map(textOf)).toEqual(['周一', '新主题', '周五']); // 新节点（默认文本）占据周三原 index
  const newId = rootKids[1] as string;
  expect(childIds(newId).map(textOf)).toEqual(['周三']); // 原节点成为新节点之子
  expect(String(nodes.get(newId)?.get('parentId'))).toBe('root');
  const wedId = childIds(newId)[0] as string;
  expect(String(nodes.get(wedId)?.get('parentId'))).toBe(newId);
  expect(childIds(wedId).map(textOf)).toEqual(['方案评审']); // 原子树跟随
});

// ─────────────── M1 验收修复轮新增 ───────────────

// FR-EDT-005：选中节点按 F2 进入编辑态（双击/Enter 之外的第三入口；M7b-W3 起
// 原 Space 绑定让位给「空格+左拖平移」手势，编辑改绑 F2，keyboardMap 同步）
test('编辑器：选中节点按 F2 进入编辑态并提交生效', async ({ page }) => {
  await openSeedDoc(page, '本周计划');
  await page.locator('.editor-canvas svg .gm-text', { hasText: '周一' }).click();
  await page.keyboard.press('F2');
  const editor = page.locator('.gm-text-editor');
  await expect(editor).toBeVisible();
  await expect(editor).toBeFocused();
  await page.keyboard.type('周一改'); // 打开即全选：键入直接覆盖
  await page.keyboard.press('Enter');
  await expect(page.locator('.editor-canvas svg .gm-text', { hasText: '周一改' })).toBeVisible();
});

// FR-EDT-009（PRD 原文「粘贴目标为当前选中节点的子级」）：复制周三子树 → 选中周一
// 粘贴 → 副本成为周一的子级（推翻旧「同级」实现）。按服务端 docState 反解结构断言。
test('编辑器：复制节点后选中另一节点 Ctrl+V 粘贴为其子级', async ({ page }) => {
  await openSeedDoc(page, '本周计划');
  await page.locator('.editor-canvas svg .gm-text', { hasText: '周三' }).click();
  await page.keyboard.press('Control+C');
  await page.locator('.editor-canvas svg .gm-text', { hasText: '周一' }).click();
  await page.keyboard.press('Control+V');
  await expect(page.getByTestId('save-status')).toHaveText(/已保存/);

  const token = await page.evaluate(() => localStorage.getItem('gmind.token'));
  const fileId = page.url().split('/').pop() ?? '';
  const res = await page.request.get(`/api/files/${fileId}`, {
    headers: { Authorization: `Bearer ${token ?? ''}` },
  });
  expect(res.ok()).toBeTruthy();
  const detail = (await res.json()) as { docState: string };
  const doc = new Y.Doc();
  const binary = atob(detail.docState); // web tsconfig 无 node types，不用 Buffer
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  Y.applyUpdate(doc, bytes);
  const nodes = doc.getMap('nodes') as Y.Map<Y.Map<unknown>>;
  const childIds = (id: string): string[] =>
    ((nodes.get(id)?.get('children') as Y.Array<string> | undefined)?.toArray() ?? []);
  const textOf = (id: string): string => String(nodes.get(id)?.get('text') ?? '');

  const mondayId = childIds('root').find((id) => textOf(id) === '周一');
  expect(mondayId).toBeTruthy();
  const copyId = childIds(mondayId as string).find((id) => textOf(id) === '周三');
  expect(copyId).toBeTruthy(); // 副本出现在周一 children（粘贴为子级）
  expect(String(nodes.get(copyId as string)?.get('parentId'))).toBe(mondayId);
  expect(childIds(copyId as string).map(textOf)).toEqual(['方案评审']); // 子树完整跟随
  // 原「周三」仍在 root 下：复制不动原节点
  expect(childIds('root').map(textOf)).toContain('周三');
});

// ─────────────── Enter 方向矩阵（2026-09-30 需求方） ───────────────

/**
 * 惰性待编辑节点补开编辑框后覆写提交为指定文本：pressFirstCharToOpen 首键（ASCII，
 * 带盒就绪重试）打开即全选，fill 整值覆写（不依赖首键落了几枚占位字符，确定性
 * 文本供 docState 精确断言），Enter 提交（overlay 吞 Enter，画布映射不再响应）。
 */
async function commitLazyNodeText(page: Page, text: string): Promise<void> {
  const editor = page.locator('.gm-text-editor');
  await pressFirstCharToOpen(page);
  await editor.fill(text);
  await page.keyboard.press('Enter');
  await expect(editor).toHaveCount(0);
}

// Enter/Shift+Enter 方向矩阵：mindmap 二级主题按逆时针定侧生长——左列 Enter 向上
// （新节点占当前节点 index，参照节点后移一位）、右列 Shift+Enter 向上；root 级落点
// 同侧保持（addChild 按右列计数自动定侧会给相反侧，openNewNodeEditor 显式
// setNodeSide 覆写）。按服务端 docState 反解结构断言 Y.Doc index + side 持久值
// （与 Shift+Tab 用例同一口径，不依赖渲染几何）。
test('编辑器：Enter 方向矩阵——左列二级主题 Enter 向上建同级且同侧，右列 Shift+Enter 向上', async ({ page }) => {
  await registerAndLogin(page);
  // 空白新文档造「3 右 1 左」：root 默认选中，Tab×4——前 3 个经 addChild 自动定侧
  // 落右（右列计数<配额 3），第 4 个落左（逆时针配额），四个节点均带持久 side。
  await page.getByRole('button', { name: '新建脑图' }).click();
  await page.locator('.file-list li', { hasText: '未命名脑图' }).click();
  await expect(page).toHaveURL(/\/edit\//);
  await expect(page.locator('.editor-canvas svg .gm-text', { hasText: '未命名脑图' })).toBeVisible();
  for (const text of ['右一', '右二', '右三', '左一']) {
    await page.locator('.editor-canvas svg .gm-text', { hasText: '未命名脑图' }).click(); // root 上 Tab 追加
    await page.keyboard.press('Tab');
    await commitLazyNodeText(page, text);
  }
  await expect(page.locator('.editor-canvas svg .gm-text', { hasText: '左一' })).toBeVisible();

  // 左列节点敲 Enter：新节点出现在其**上方**（占据其原 index），且同侧落左
  await page.locator('.editor-canvas svg .gm-text', { hasText: '左一' }).click();
  await page.keyboard.press('Enter');
  await expect(page.locator('.editor-canvas svg .gm-text', { hasText: '新主题' })).toBeVisible();
  // 右列节点敲 Shift+Enter：新节点出现在其**上方**（占其原 index），同侧保持右
  await page.locator('.editor-canvas svg .gm-text', { hasText: '右二' }).click();
  await page.keyboard.press('Shift+Enter');
  await expect(page.getByTestId('save-status')).toHaveText(/已保存/);

  // 从服务端读回 docState 反解结构（避免依赖渲染几何）
  const token = await page.evaluate(() => localStorage.getItem('gmind.token'));
  const fileId = page.url().split('/').pop() ?? '';
  const res = await page.request.get(`/api/files/${fileId}`, {
    headers: { Authorization: `Bearer ${token ?? ''}` },
  });
  expect(res.ok()).toBeTruthy();
  const detail = (await res.json()) as { docState: string };
  const doc = new Y.Doc();
  const binary = atob(detail.docState); // web tsconfig 无 node types，不用 Buffer
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  Y.applyUpdate(doc, bytes);
  const nodes = doc.getMap('nodes') as Y.Map<Y.Map<unknown>>;
  const childIds = (id: string): string[] =>
    ((nodes.get(id)?.get('children') as Y.Array<string> | undefined)?.toArray() ?? []);
  const textOf = (id: string): string => String(nodes.get(id)?.get('text') ?? '');
  const sideOf = (id: string): string => String(nodes.get(id)?.get('side') ?? '');

  // 终序 = [右一, 新主题(Shift+Enter), 右二, 右三, 新主题(Enter), 左一]
  const rootKids = childIds('root');
  expect(rootKids.map(textOf)).toEqual(['右一', '新主题', '右二', '右三', '新主题', '左一']);
  // 右列 Shift+Enter：新主题占右二原 index 1（其上方），右二后移到 2，同侧=right
  expect(sideOf(rootKids[1] as string)).toBe('right');
  expect(sideOf(rootKids[2] as string)).toBe('right'); // 右二（参照节点侧别不变）
  // 左列 Enter：新主题占左一原 index（其上方，左一后移至末位），同侧=left
  expect(sideOf(rootKids[4] as string)).toBe('left');
  expect(sideOf(rootKids[5] as string)).toBe('left'); // 左一（参照节点侧别不变）
  // 造数自证：Tab×4 的 3 右 1 左均带持久 side（右一/右三 right，非计数兜底）
  expect(sideOf(rootKids[0] as string)).toBe('right');
  expect(sideOf(rootKids[3] as string)).toBe('right');
});

// —— 2026-09-28 走查配套锁定：编辑文字时点画布任意处 = 提交并关闭编辑框 ——

test('编辑器：编辑既有节点时点击画布任意处提交并关闭编辑框', async ({ page }) => {
  await openSeedDoc(page, '本周计划');
  await page.locator('.editor-canvas svg .gm-text', { hasText: '周一' }).dblclick();
  const editor = page.locator('.gm-text-editor');
  await expect(editor).toBeVisible(); // 双击编辑既有节点：立即开框（惰性仅限新建）
  await page.keyboard.type('周一改'); // 打开即全选：键入直接覆盖
  await page.locator('.editor-canvas svg').click({ position: { x: 30, y: 30 } }); // 画布点击=提交
  await expect(editor).toHaveCount(0);
  await expect(page.locator('.editor-canvas svg .gm-text', { hasText: '周一改' })).toBeVisible();
  await expect(page.getByTestId('save-status')).toHaveText(/已保存/);
});

// —— M3b 清偿包（FR-FIL-004 编辑器加星入口） ——

// 工具栏星标切换：GET /:id 的 starred 为初始态（☆）；点击 PUT → ★，工作台星标视图
// 同步包含；取消 DELETE → 移出星标视图；刷新后状态保持。
test('编辑器：工具栏加星切换与工作台星标视图同步', async ({ page }) => {
  await openSeedDoc(page, '本周计划');
  const toggle = page.getByTestId('star-toggle');
  await expect(toggle).toHaveText('☆');
  await toggle.click();
  await expect(toggle).toHaveText('★');

  // 工作台星标视图包含该文件
  await page.getByTestId('back-btn').click();
  await expect(page).toHaveURL(/\/workspace/);
  await page.getByTestId('view-tabs').getByRole('button', { name: '星标' }).click();
  await expect(page.locator('.file-list li', { hasText: '本周计划' })).toBeVisible();

  // 编辑器内取消：刷新进编辑器显示 ★（持久化），取消后工作台星标视图移出
  await page.locator('.file-list li', { hasText: '本周计划' }).click();
  await expect(page).toHaveURL(/\/edit\//);
  await expect(page.getByTestId('star-toggle')).toHaveText('★');
  await page.getByTestId('star-toggle').click();
  await expect(page.getByTestId('star-toggle')).toHaveText('☆');
  await page.getByTestId('back-btn').click();
  await page.getByTestId('view-tabs').getByRole('button', { name: '星标' }).click();
  await expect(page.locator('.file-list li', { hasText: '本周计划' })).toHaveCount(0);
});
