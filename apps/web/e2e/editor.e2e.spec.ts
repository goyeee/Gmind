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

/** 用例 2 的创建流程：选中 root 按 Tab → 键入 → Enter 提交。 */
async function createNewNodeViaKeyboard(page: Page): Promise<void> {
  await page.keyboard.press('Tab'); // root 为默认选中：新建子节点并进入编辑态
  const editor = page.locator('.gm-text-editor');
  await expect(editor).toBeVisible();
  await expect(editor).toBeFocused();
  await page.keyboard.type('新节点');
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

// 用例 2b（2026-09-27 GUI 走查修复）：Tab 按下即出现空节点盒（输入框锚定其上），
// 输入前节点已在树中落位；Esc 取消回收空节点不留壳
test('编辑器：新建先落位空节点再输入，Esc 取消不留空壳', async ({ page }) => {
  await openSeedDoc(page, '本周计划');
  const groups = page.locator('.editor-canvas svg g[data-node-id]');
  const before = await groups.count();
  await page.keyboard.press('Tab');
  // 空节点盒立即出现（minNodeWidth 下限保证可见），编辑器锚定其上
  await expect(groups).toHaveCount(before + 1);
  await expect(page.locator('.gm-text-editor')).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.locator('.gm-text-editor')).toHaveCount(0);
  await expect(groups).toHaveCount(before); // 取消回收，不留空壳
  // 再次新建：完整输入路径仍工作
  await page.keyboard.press('Tab');
  await expect(groups).toHaveCount(before + 1);
  await page.keyboard.type('落位节点');
  await page.keyboard.press('Enter');
  await expect(page.locator('.editor-canvas svg .gm-text', { hasText: '落位节点' })).toBeVisible();
  await expect(groups).toHaveCount(before + 1);
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

// 用例 5：结构切换到组织架构图 → 边形态 bezier→elbow；Ctrl+Z 恢复
test('编辑器：结构切换为组织架构图后边形态变化且可撤销', async ({ page }) => {
  await openSeedDoc(page, '本周计划');
  const firstEdge = page.locator('.editor-canvas svg path[data-edge-id]').first();
  await expect(firstEdge).toHaveAttribute('d', / C /); // mindmap：bezier
  await page.getByTestId('structure-select').selectOption('org');
  await expect(firstEdge).toHaveAttribute('d', / L /); // org：elbow（正交折线）
  await expect(firstEdge).not.toHaveAttribute('d', / C /);
  // 焦点移出下拉框后再撤销
  await page.locator('.editor-canvas svg').click({ position: { x: 30, y: 30 } });
  await page.keyboard.press('Control+Z');
  await expect(firstEdge).toHaveAttribute('d', / C /);
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

// 修复 1：主题切换重建场景后视口变换保留（不回到恒等变换）
test('编辑器：主题切换后视口变换保留', async ({ page }) => {
  await openSeedDoc(page, '本周计划');
  await page.waitForTimeout(300); // 等待初始「适应画布」（rAF 内执行）
  const vpG = page.locator('.editor-canvas svg .gm-viewport');
  const before = await vpG.getAttribute('transform');
  expect(before).toBeTruthy();
  expect(before).not.toBe('translate(0, 0) scale(1)'); // 初始 fit 后必非恒等
  await page.getByTestId('theme-select').selectOption('gmind-warm');
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
// docState 结构断言：原父在原 index 处持有新空节点，新节点 children = [原节点]。
test('编辑器：Shift+Tab 在节点与父之间插入新父', async ({ page }) => {
  await openSeedDoc(page, '本周计划');
  await expect(page.locator('.editor-canvas svg .gm-text')).toHaveCount(7);
  await page.locator('.editor-canvas svg .gm-text', { hasText: '周三' }).click(); // 周三有子「方案评审」
  await page.keyboard.press('Shift+Tab');
  await expect(page.locator('.editor-canvas svg .gm-text')).toHaveCount(8); // +1 空新节点
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
  expect(rootKids.map(textOf)).toEqual(['周一', '', '周五']); // 新空节点占据周三原 index
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
