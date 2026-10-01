import { expect, test, type Page } from '@playwright/test';

/**
 * 查找替换 E2E — M6 Task 3（企微对标）。
 *
 * 契约（testid 冻结）：find-bar / find-input / find-next / find-prev /
 * find-replace-input / find-replace-btn / find-replace-all / find-close /
 * find-count（`n/m` 式，n=当前第几个（1 起），m=匹配总数；空查询与无匹配均 `0/0`）。
 *
 * 匹配集 = 全部存活可达节点 text 的大小写不敏感包含（root 计入；先序文档序）。
 * 种子「本周计划」树：本周计划 → 周一(周会对齐) / 周三(方案评审) / 周五(周报复盘)
 * —— 查「周」= 6 处（root + 5 个子孙）。
 *
 * 覆盖：
 * - Ctrl+F 打开（画布焦点态）+ 空查询 0/0 + 四动作钮禁用；
 * - 新建 3 个含「节点」的子节点 → 查「节点」3/3；next/prev 循环定位（.gm-selected
 *   文本随计数推进变化）；
 * - 无匹配查询 0/0 + 禁用；
 * - 替换当前 = 当前定位节点 text 内首个匹配被替换，匹配集重算（丙移出 → 2/2）；
 * - 全部替换 = 每节点全部出现替换，count 0/0 且画布文本更新；
 * - 全部替换为单用户事务：一次撤销整体恢复（若逐节点拆事务则只回一个 → 红）；
 * - Esc 关闭查找条；Ctrl+F 重开（查询保留、计数重算定位回第 1 个）；
 * - 标题输入框内 Ctrl+F 不劫持（isEditableTarget 让路）；find-toggle 点击打开；
 * - 定位复用 locateNode：折叠 root 后 next 定位到深层节点时自动展开祖先。
 *
 * 登录 helper 内联自 editor.e2e.spec.ts（新手机号注册即赠 3 个种子文件）。
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

/** 当前唯一选中节点的文本元素（selectOnly 语义下恰一个 .gm-selected）。 */
function selectedText(page: Page): ReturnType<Page['locator']> {
  return page.locator('.editor-canvas svg g.gm-selected .gm-text');
}

test('查找替换：Ctrl+F 打开 → 计数/循环定位 → 替换当前 → 全部替换单事务撤销 → Esc 关闭', async ({
  page,
}) => {
  test.setTimeout(60_000);
  await openSeedDoc(page, '本周计划');

  // 建 3 个含「节点」的子节点（每次先选 root 再 Tab——惰性创建落位「新主题」节点，
  // 敲字才开编辑框；选中态由双框 Enter×2 提交后消费，避免上一次新建的选中串位）。
  // 补开首键纪律见 editor.e2e pressFirstCharToOpen：ASCII 首键带重试，退格清占位、
  // insertText 写入中文。
  for (const label of ['节点甲', '节点乙', '节点丙']) {
    await page.locator('.editor-canvas svg .gm-text', { hasText: '本周计划' }).click();
    await page.keyboard.press('Tab');
    const editor = page.locator('.gm-text-editor');
    await expect(page.locator('.editor-canvas svg .gm-text', { hasText: '新主题' })).toBeVisible();
    await expect(editor).toHaveCount(0); // 惰性锁定：编辑框不随创建出现
    for (let i = 0; i < 20 && (await editor.count()) === 0; i += 1) {
      await page.keyboard.press('x');
      await page.waitForTimeout(25);
    }
    await expect(editor).toBeVisible();
    await page.keyboard.press('Backspace');
    await page.keyboard.insertText(label);
    await page.keyboard.press('Enter'); // 标题框 → 描述框（双框流转）
    await page.keyboard.press('Enter'); // 描述框留空 → 提交两者
    await expect(editor).toHaveCount(0);
  }
  await expect(page.locator('.editor-canvas svg .gm-text', { hasText: '节点丙' })).toBeVisible();

  // Ctrl+F（焦点在页面/画布，非输入控件）→ 打开查找条并聚焦查询输入
  await page.keyboard.press('Control+F');
  const bar = page.getByTestId('find-bar');
  await expect(bar).toBeVisible();
  await expect(page.getByTestId('find-input')).toBeFocused();

  // 空查询：0/0 + 导航/替换钮全禁用
  await expect(page.getByTestId('find-count')).toHaveText('0/0');
  for (const testid of ['find-next', 'find-prev', 'find-replace-btn', 'find-replace-all']) {
    await expect(page.getByTestId(testid)).toBeDisabled();
  }

  // 查「节点」：3 处（种子树无「节点」字样），当前 1/3 且定位第 1 个
  await page.getByTestId('find-input').fill('节点');
  await expect(page.getByTestId('find-count')).toHaveText('1/3');
  await expect(selectedText(page)).toHaveText('节点甲');

  // next 循环推进：1→2→3→回 1；prev 再回 3
  await page.getByTestId('find-next').click();
  await expect(page.getByTestId('find-count')).toHaveText('2/3');
  await expect(selectedText(page)).toHaveText('节点乙');
  await page.getByTestId('find-next').click();
  await expect(page.getByTestId('find-count')).toHaveText('3/3');
  await expect(selectedText(page)).toHaveText('节点丙');
  await page.getByTestId('find-next').click();
  await expect(page.getByTestId('find-count')).toHaveText('1/3');
  await expect(selectedText(page)).toHaveText('节点甲');
  await page.getByTestId('find-prev').click();
  await expect(page.getByTestId('find-count')).toHaveText('3/3');
  await expect(selectedText(page)).toHaveText('节点丙');

  // 无匹配：0/0 + 禁用
  await page.getByTestId('find-input').fill('不存在的查询词xyz');
  await expect(page.getByTestId('find-count')).toHaveText('0/0');
  await expect(page.getByTestId('find-next')).toBeDisabled();
  await expect(page.getByTestId('find-replace-all')).toBeDisabled();

  // 替换当前（节点丙 → 改丙）：当前节点首个匹配被替换，匹配集重算 → 2/2
  await page.getByTestId('find-input').fill('节点');
  await expect(page.getByTestId('find-count')).toHaveText('1/3');
  await page.getByTestId('find-next').click();
  await page.getByTestId('find-next').click();
  await expect(page.getByTestId('find-count')).toHaveText('3/3');
  await page.getByTestId('find-replace-input').fill('改');
  await page.getByTestId('find-replace-btn').click();
  await expect(page.getByTestId('find-count')).toHaveText('2/2');
  await expect(page.locator('.editor-canvas svg .gm-text', { hasText: '改丙' })).toBeVisible();
  await expect(page.locator('.editor-canvas svg .gm-text', { hasText: '节点丙' })).toHaveCount(0);

  // 全部替换（节点甲/节点乙 → 改甲/改乙）：count 0/0，画布再无「节点」文本。
  // 先等 Yjs UndoManager captureTimeout（500ms）过窗：替换事务独立成撤销项，
  // 下一步「一次撤销」恢复的是替换文本而非连建节点事务一起回滚。
  await page.waitForTimeout(600);
  await page.getByTestId('find-replace-all').click();
  await expect(page.getByTestId('find-count')).toHaveText('0/0');
  await expect(page.locator('.editor-canvas svg .gm-text', { hasText: '节点' })).toHaveCount(0);
  await expect(page.locator('.editor-canvas svg .gm-text', { hasText: '改甲' })).toBeVisible();
  await expect(page.locator('.editor-canvas svg .gm-text', { hasText: '改乙' })).toBeVisible();

  // 单用户事务：一次撤销整体恢复甲乙（若逐节点拆事务，只回一个即红）；
  // 撤销后匹配集重算 → 1/2（定位回第 1 个）。用 Ctrl+Z 键撤销：2026-09-28 外点
  // 关闭语义下，点击工具栏 undo-btn 的 pointerdown 会把查找条当「外点」收起。
  await page.keyboard.press('Control+Z');
  await expect(page.getByTestId('find-count')).toHaveText('1/2');
  await expect(page.locator('.editor-canvas svg .gm-text', { hasText: '节点甲' })).toBeVisible();
  await expect(page.locator('.editor-canvas svg .gm-text', { hasText: '节点乙' })).toBeVisible();

  // Esc 关闭查找条（清空定位）；Ctrl+F 重开：查询保留、重算定位回第 1 个
  await page.keyboard.press('Escape');
  await expect(bar).toHaveCount(0);
  await page.keyboard.press('Control+F');
  await expect(page.getByTestId('find-bar')).toBeVisible();
  await expect(page.getByTestId('find-count')).toHaveText('1/2');
  await expect(selectedText(page)).toHaveText('节点甲');
});

test('查找：find-toggle 打开，查「周」6 处；定位展开折叠祖先；输入框内 Ctrl+F 不劫持', async ({
  page,
}) => {
  test.setTimeout(60_000);
  await openSeedDoc(page, '本周计划');

  // 标题输入框聚焦时 Ctrl+F 不劫持（isEditableTarget 让路原生查找）
  await page.getByTestId('title-input').click();
  await page.keyboard.press('Control+F');
  await expect(page.getByTestId('find-bar')).toHaveCount(0);

  // 工具栏 find-toggle 点击打开
  await page.getByTestId('find-toggle').click();
  await expect(page.getByTestId('find-bar')).toBeVisible();

  // 查「周」：全文 6 处（本周计划/周一/周会对齐/周三/周五/周报复盘），当前 1/6 = root
  await page.getByTestId('find-input').fill('周');
  await expect(page.getByTestId('find-count')).toHaveText('1/6');
  await expect(selectedText(page)).toHaveText('本周计划');

  // 折叠 root：子树从画布消失（匹配集按数据层全量计，count 不变）。
  // 右键点击画布命中「弹层外点」语义 → 查找条自动收起（2026-09-28 走查行为），
  // 折叠后 Ctrl+F 重开：查询保留、计数重算定位回第 1 个。
  await page
    .locator('.editor-canvas svg .gm-text', { hasText: '本周计划' })
    .click({ button: 'right' });
  await page.getByTestId('context-menu').getByRole('button', { name: '折叠/展开' }).click();
  await expect(page.locator('.editor-canvas svg .gm-text', { hasText: '周一' })).toHaveCount(0);
  await expect(page.getByTestId('find-bar')).toHaveCount(0); // 画布外点已收起查找条
  await page.keyboard.press('Control+F');
  await expect(page.getByTestId('find-bar')).toBeVisible();
  await expect(page.getByTestId('find-input')).toHaveValue('周');
  await expect(page.getByTestId('find-count')).toHaveText('1/6');

  // next → 2/6 = 周一：定位展开折叠祖先，节点重新可见并选中（locateNode 复用）
  await page.getByTestId('find-next').click();
  await expect(page.getByTestId('find-count')).toHaveText('2/6');
  const monday = page.locator('.editor-canvas svg g[data-node-id]', { hasText: '周一' });
  await expect(monday).toBeVisible();
  await expect(monday).toHaveClass(/gm-selected/);

  // prev 循环回 1/6；Esc 关闭（焦点在查找输入内）
  await page.getByTestId('find-prev').click();
  await expect(page.getByTestId('find-count')).toHaveText('1/6');
  await page.keyboard.press('Escape');
  await expect(page.getByTestId('find-bar')).toHaveCount(0);
});
