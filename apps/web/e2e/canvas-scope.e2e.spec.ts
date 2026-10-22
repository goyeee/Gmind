import { expect, test, type Page } from '@playwright/test';

/**
 * 当前画布口径 E2E — 多画布 web 计划三 Task 4（12 点位 EditorPage 侧验收）。
 *
 * 覆盖（多画布 doc 下计数/查找/全选/导出范围断言）：
 * - node-count 底栏脚标 = 当前画布可达存活数（画布B 建 1 节点 → 1；切回画布 1 → 6）；
 * - 画布B root 直接子级默认命名「分支主题 1」（nextChildText 画布根口径，非「子主题」）；
 * - 查找替换匹配集 = 当前画布子树：画布B 查「周」0/0，切回画布 1 同查询 6/6；
 * - Ctrl+A 全选范围 = 当前画布子树（画布B 2 个选中：root+子；画布 1 7 个）；
 * - PNG 导出文件名多画布 = 文件标题＋画布名（「本周计划-画布B.png」）；
 * - XMind 导出文件名保持「本周计划.xmind」（中间态只改范围不改文件名）。
 *
 * 前置编排复用 canvas-tabs.e2e.spec.ts（页签条 UI 新建画布）；登录 helper 内联
 * 自 editor.e2e.spec.ts（新手机号注册即赠 3 个种子文件）。
 */

async function registerAndLogin(page: Page): Promise<void> {
  await page.goto('/login');
  const phone = '138' + String(Math.floor(10000000 + Math.random() * 89999999));
  await page.getByPlaceholder('手机号').fill(phone);
  await page.getByPlaceholder('验证码（开发环境固定 123456）').fill('123456');
  await page.getByRole('button', { name: '登录', exact: true }).click();
  await expect(page).toHaveURL(/\/workspace/);
  await expect(page.getByTestId('mine-grid').getByTestId('file-card')).toHaveCount(3);
}

async function openSeedDoc(page: Page, title: string): Promise<void> {
  await registerAndLogin(page);
  await page.getByTestId('file-card').filter({ hasText: title }).first().click();
  await expect(page).toHaveURL(/\/edit\//);
  await expect(page.locator('.editor-canvas svg .gm-text', { hasText: title })).toBeVisible();
}

/** ➕ 新建画布（行内输入提交；自动切换到新画布）。 */
async function addCanvasViaUi(page: Page, name: string): Promise<void> {
  await page.getByTestId('canvas-add').click();
  const input = page.getByTestId('canvas-rename-input');
  await expect(input).toBeVisible();
  await input.fill(name);
  await page.keyboard.press('Enter');
  await expect(input).toHaveCount(0);
}

/** 惰性补开首键（ASCII 带重试，editor.e2e 同款纪律）。 */
async function pressFirstCharToOpen(page: Page): Promise<void> {
  const editor = page.locator('.gm-text-editor');
  for (let i = 0; i < 20 && (await editor.count()) === 0; i += 1) {
    await page.keyboard.press('x');
    await page.waitForTimeout(25);
  }
  await expect(editor).toBeVisible();
}

/** 当前选中 root 建子节点并命名（惰性创建 → 首键开框 → 中文 insertText → Enter×2）。 */
async function addChildNamed(page: Page, parentText: string, label: string): Promise<void> {
  await page.locator('.editor-canvas svg .gm-text', { hasText: parentText }).first().click();
  await page.keyboard.press('Tab');
  await expect(page.locator('.editor-canvas svg .gm-text', { hasText: '分支主题 1' })).toBeVisible();
  await expect(page.locator('.gm-text-editor')).toHaveCount(0); // 惰性锁定
  await pressFirstCharToOpen(page);
  await page.keyboard.press('Backspace');
  await page.keyboard.insertText(label);
  await page.keyboard.press('Enter'); // 标题框 → 描述框
  await page.keyboard.press('Enter'); // 描述框留空 → 提交
  await expect(page.locator('.gm-text-editor')).toHaveCount(0);
}

/** 点击页签（canvas-tabbar 内按文本匹配）。 */
async function switchTab(page: Page, name: string): Promise<void> {
  await page.locator('[data-testid="canvas-tabbar"] [data-testid^="canvas-tab-"]', { hasText: name }).click();
  await expect(page.locator('.canvas-tab-active')).toHaveText(name);
}

test('脚标口径：画布B 建 1 节点 → 1 节点；root 子级默认命名分支主题 1；切回画布 1 → 6 节点', async ({
  page,
}) => {
  test.setTimeout(90_000);
  await openSeedDoc(page, '本周计划');
  await expect(page.getByTestId('node-count')).toHaveText('6 节点'); // 种子 6（可达活跃，不含 root）

  await addCanvasViaUi(page, '画布B'); // 自动切换：新画布空树
  await expect(page.locator('.editor-canvas svg .gm-text', { hasText: '中心主题' })).toBeVisible();
  await expect(page.getByTestId('node-count')).toHaveText('0 节点');

  // 画布B root 直接子级默认命名 = 「分支主题 1」（root 判定按画布根，非字面 'root'）
  await addChildNamed(page, '中心主题', '画布B任务');
  await expect(page.locator('.editor-canvas svg .gm-text', { hasText: '画布B任务' })).toBeVisible();
  await expect(page.getByTestId('node-count')).toHaveText('1 节点');

  // 页签切换：脚标随当前画布口径往返
  await switchTab(page, '画布 1');
  await expect(page.getByTestId('node-count')).toHaveText('6 节点');
  await switchTab(page, '画布B');
  await expect(page.getByTestId('node-count')).toHaveText('1 节点');
});

test('查找/全选口径：画布B 查「周」0/0，切回画布 1 同查询 6/6；Ctrl+A 只选当前画布子树', async ({
  page,
}) => {
  test.setTimeout(90_000);
  await openSeedDoc(page, '本周计划');
  await addCanvasViaUi(page, '画布B');
  await addChildNamed(page, '中心主题', '画布B任务');

  // 查找范围 = 当前画布：画布B 无「周」（root 中心主题 + 画布B任务）
  await page.keyboard.press('Control+f');
  await expect(page.getByTestId('find-bar')).toBeVisible();
  await page.getByTestId('find-input').fill('周');
  await expect(page.getByTestId('find-count')).toHaveText('0/0');
  await page.getByTestId('find-input').fill('画布B任务');
  await expect(page.getByTestId('find-count')).toHaveText('1/1');

  // 切回画布 1：点页签关查找条（外点即关既有先例）——Ctrl+F 重开（查询串保留，
  // find-replace spec 先例），重算计数 = 当前画布口径 6/6
  await switchTab(page, '画布 1');
  await page.keyboard.press('Control+f');
  await expect(page.getByTestId('find-bar')).toBeVisible();
  await expect(page.getByTestId('find-input')).toHaveValue('画布B任务');
  await expect(page.getByTestId('find-count')).toHaveText('0/0'); // 画布 1 无该文本
  await page.getByTestId('find-input').fill('周');
  await expect(page.getByTestId('find-count')).toHaveText('1/6'); // n/m 式：第 1/共 6（root+5 子孙含「周」）

  // 再切回画布B：同查询「周」重算 = 0/0（匹配集不越画布）
  await switchTab(page, '画布B');
  await page.keyboard.press('Control+f');
  await expect(page.getByTestId('find-input')).toHaveValue('周');
  await expect(page.getByTestId('find-count')).toHaveText('0/0');

  // 全选范围 = 当前画布子树：画布 1 = root+6 节点；画布B = root+1 节点
  await page.keyboard.press('Escape'); // 关查找条（Esc），避免输入框吞 Ctrl+A
  await switchTab(page, '画布 1'); // 此刻在画布B（上方查找断言后），先切回画布 1
  await page.keyboard.press('Control+a');
  await expect(page.locator('.editor-canvas svg g.gm-selected')).toHaveCount(7);
  await switchTab(page, '画布B');
  await page.keyboard.press('Control+a');
  await expect(page.locator('.editor-canvas svg g.gm-selected')).toHaveCount(2);
});

test('导出口径：画布B PNG 文件名 = 文件标题＋画布名；XMind 文件名保持文件标题', async ({
  page,
}) => {
  test.setTimeout(90_000);
  page.on('dialog', (dialog) => void dialog.accept()); // 折叠展开 confirm 兜底（本用例无折叠）
  await openSeedDoc(page, '本周计划');
  await addCanvasViaUi(page, '画布B');
  await addChildNamed(page, '中心主题', '画布B任务');

  await page.getByTestId('export-menu').click();
  const [png] = await Promise.all([
    page.waitForEvent('download'),
    page.getByTestId('export-png-1x').click(),
  ]);
  expect(png.suggestedFilename()).toBe('本周计划-画布B.png');

  await page.getByTestId('export-menu').click();
  const [xmind] = await Promise.all([
    page.waitForEvent('download'),
    page.getByTestId('export-xmind').click(),
  ]);
  expect(xmind.suggestedFilename()).toBe('本周计划.xmind');
});
