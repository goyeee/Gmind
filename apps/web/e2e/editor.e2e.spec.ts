import { expect, test, type Page } from '@playwright/test';

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
