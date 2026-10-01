import { expect, test, type Page } from '@playwright/test';

/**
 * 工具栏图标化分组改版 E2E — M6 Task 1（企微对标）+ 历轮改版追平（2026-09-28）：
 * - M7b-R2/R3/R4：样式右列收进「格式」按钮（右列默认隐藏）、企微三按钮
 *   上级主题·子主题·同级主题（复用 Shift+Tab/Tab/Enter 路径）、主题下拉移除只留
 *   theme-panel-toggle 面板按钮、视图切换（脑图|表格）分段控件入列；
 * - M7c-C4：任务面板开关「任务」与格式同组互斥。
 *
 * 结构断言：
 * 1. 单行分组：11 个 .toolbar-group（返回/标题/视图切换/撤销重做格式刷/插入/
 *    上级子级同级/格式任务/结构主题/导出/协作视图/全屏），组间竖线分隔符 9；
 * 2. 图标按钮：全部带内联 svg 的 .toolbar-btn 均含非空 title 提示（16 枚；
 *    上级/子级/同级三按钮为纯文字钮，label+title 单列断言）；
 * 3. 既有 testid 全保留（循环逐个断言可见）；
 * 4. find-toggle：查找入口（启用 + title「查找 (Ctrl+F)」+ 点击打开查找条）；
 * 5. 组序（按 x 坐标）：返回 → 标题 → 视图切换 → 撤销重做格式刷 → 插入 → 上级
 *    子级同级 → 格式任务 → 结构主题 → 导出 → 协作 → 全屏。
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

async function openSeedDoc(page: Page): Promise<void> {
  await registerAndLogin(page);
  await page.locator('.file-list li', { hasText: '本周计划' }).click();
  await expect(page).toHaveURL(/\/edit\//);
  await expect(page.locator('.editor-canvas svg .gm-text', { hasText: '本周计划' })).toBeVisible();
}

/** 既有工具栏 testid 清单（历轮改版后必须全部仍在，mobile-readonly 清单的桌面全集）。
 *  structure-select 已随 2026-09-30 结构面板改版移除（structure-select →
 *  structure-toggle + structure-panel，见 editor.e2e 用例 5 适配）。 */
const EXISTING_TESTIDS = [
  'back-btn',
  'title-input',
  'star-toggle',
  'save-status',
  'undo-btn',
  'redo-btn',
  'structure-toggle',
  'theme-panel-toggle',
  'insert-menu',
  'export-menu',
  'members-btn',
  'versions-toggle',
  'activity-toggle',
  'help-toggle',
  'fullscreen-btn',
  'format-toggle',
  'task-toggle',
  'toolbar-add-parent',
  'toolbar-add-child',
  'toolbar-add-sibling',
  'view-tab-mind',
  'view-tab-table',
] as const;

test('工具栏：单行分组 + 竖线分隔符（11 组 / 9 分隔线）', async ({ page }) => {
  await openSeedDoc(page);
  const toolbar = page.locator('.editor-toolbar');
  await expect(toolbar).toBeVisible();
  // 分组容器：返回 / 标题 / 视图切换 / 撤销重做格式刷 / 插入 / 上级子级同级 /
  // 格式任务 / 结构主题 / 导出 / 协作 / 全屏（导出组与协作组间省略 1 条分隔线）
  await expect(toolbar.locator('> .toolbar-group')).toHaveCount(11);
  // 组间 1px 竖线分隔符
  await expect(toolbar.locator('.toolbar-sep')).toHaveCount(9);
  // 每个分隔符都是 1px 宽的竖线元素（可见）
  const seps = toolbar.locator('.toolbar-sep');
  for (let i = 0; i < (await seps.count()); i++) {
    await expect(seps.nth(i)).toBeVisible();
  }
  // 2026-09-30 需求方反馈任务 2：文字标签所有宽度常显 + e2e 默认视口（1280）恒
  // 单行——全部直接子元素 offsetTop 相等（不换行）、无横向溢出；9 个文字标签
  // （格式刷/插入/三按钮/格式/任务/结构/主题）全部可见（不再随 ≤1536 降级隐藏）。
  const lineTops = await toolbar
    .locator('> *')
    .evaluateAll((els) => [...new Set(els.map((e) => (e as HTMLElement).offsetTop))]);
  expect(lineTops, '工具栏必须单行（全部直接子元素等 offsetTop）').toHaveLength(1);
  const overflow = await toolbar.evaluate((el) => el.scrollWidth > el.clientWidth);
  expect(overflow, '工具栏不得横向溢出').toBe(false);
  const labels = toolbar.locator('.toolbar-btn-label');
  await expect(labels).toHaveCount(9);
  for (let i = 0; i < (await labels.count()); i++) {
    await expect(labels.nth(i)).toBeVisible();
  }
});

test('工具栏：图标按钮均带内联 svg 与 title 提示；上级/子级/同级为文字钮', async ({ page }) => {
  await openSeedDoc(page);
  const iconButtons = page.locator('.editor-toolbar button.toolbar-btn', { has: page.locator('> svg') });
  // 返回/撤销/重做/格式刷/插入/格式/任务/结构/主题面板/导出/成员/版本历史/动态/
  // 快捷键/查找/全屏 = 16 个图标按钮（2026-09-30 结构 toggle 入列：图标+文字标签）
  await expect(iconButtons).toHaveCount(16);
  const count = await iconButtons.count();
  for (let i = 0; i < count; i++) {
    const btn = iconButtons.nth(i);
    await expect(btn.locator('> svg')).toHaveCount(1);
    const title = await btn.getAttribute('title');
    expect(title, '图标按钮必须有非空 title 悬停提示').toBeTruthy();
    expect(title!.trim().length).toBeGreaterThan(0);
  }
  // 企微三按钮（M7b-R3）：纯文字钮 + 快捷键 title
  for (const [tid, label] of [
    ['toolbar-add-parent', '上级主题'],
    ['toolbar-add-child', '子主题'],
    ['toolbar-add-sibling', '同级主题'],
  ] as const) {
    const btn = page.getByTestId(tid);
    await expect(btn).toContainText(label);
    await expect(btn).toHaveAttribute('title', /.+/);
    await expect(btn.locator('> svg')).toHaveCount(0);
  }
});

test('工具栏：既有 testid 全保留且可见', async ({ page }) => {
  await openSeedDoc(page);
  for (const id of EXISTING_TESTIDS) {
    await expect(page.getByTestId(id), `testid ${id} 必须保留`).toBeVisible();
  }
});

test('工具栏：find-toggle 已接线为查找入口（T3 启用，替换 T1 占位断言）', async ({ page }) => {
  await openSeedDoc(page);
  const find = page.getByTestId('find-toggle');
  await expect(find).toBeVisible();
  await expect(find).toBeEnabled();
  await expect(find).toHaveAttribute('title', '查找 (Ctrl+F)');
  await expect(find.locator('> svg')).toHaveCount(1);
  // 点击打开查找条（详细查找替换链路见 find-replace.e2e.spec.ts）
  await find.click();
  await expect(page.getByTestId('find-bar')).toBeVisible();
});

test('工具栏：members-btn 与结构面板钮/主题面板钮可访问名语义正确', async ({ page }) => {
  await openSeedDoc(page);
  // 评审 Important（round 1）：members-btn 内容为 aria-hidden SVG + 角标数字，
  // accname 计算内容先于 title → 名字会退化为「1」；须 aria-label 补语义名。
  await expect(page.getByTestId('members-btn')).toHaveAccessibleName('在线成员');
  // 结构入口（2026-09-30 任务 3）：select 移除后为面板 toggle 按钮，aria-label
  // 同语义保留（accessible-name 契约自 structure-select 平移）
  await expect(page.getByTestId('structure-toggle')).toHaveAccessibleName('结构');
  // 主题入口（M7b-W2 #6）：下拉移除后为面板按钮，aria-label 同语义保留
  await expect(page.getByTestId('theme-panel-toggle')).toHaveAccessibleName('主题');
});

test('工具栏：组序符合企微对标布局（返回|标题|视图|撤销重做刷|插入|三钮|格式任务|结构主题|导出|协作|全屏）', async ({ page }) => {
  await openSeedDoc(page);
  const anchors = [
    'back-btn',
    'title-input',
    'view-tab-mind',
    'undo-btn',
    'insert-menu',
    'toolbar-add-parent',
    'format-toggle',
    'structure-toggle',
    'theme-panel-toggle',
    'export-menu',
    'members-btn',
    'fullscreen-btn',
  ] as const;
  const placed: { id: string; x: number; y: number }[] = [];
  for (const id of anchors) {
    const box = await page.getByTestId(id).boundingBox();
    expect(box, `锚点 ${id} 必须已渲染`).toBeTruthy();
    placed.push({ id, x: box!.x, y: box!.y });
  }
  // M7b-K2R3 起工具栏为 flex-wrap：窄视口下靠后的组换行（行首 x 回落）。断言口径：
  // 相邻锚点同横排（y 差 <16px）则 x 必须递增；跨排（换行）则 y 必须向下递增。
  for (let i = 1; i < placed.length; i++) {
    const prev = placed[i - 1]!;
    const cur = placed[i]!;
    if (Math.abs(prev.y - cur.y) < 16) {
      expect(cur.x, `${cur.id} 必须在 ${prev.id} 右侧（同排）`).toBeGreaterThan(prev.x);
    } else {
      expect(cur.y, `${cur.id} 换行后必须位于 ${prev.id} 下方（跨排向下）`).toBeGreaterThan(prev.y);
    }
  }
  // 企微三按钮组落位钉死：插入 < 上级子级同级 < 格式任务 < 结构主题
  const insertX = (await page.getByTestId('insert-menu').boundingBox())!.x;
  const addX = (await page.getByTestId('toolbar-add-parent').boundingBox())!.x;
  const formatX = (await page.getByTestId('format-toggle').boundingBox())!.x;
  const structX = (await page.getByTestId('structure-toggle').boundingBox())!.x;
  expect(addX).toBeGreaterThan(insertX);
  expect(formatX).toBeGreaterThan(addX);
  expect(structX).toBeGreaterThan(formatX);
  // 同组相邻：撤销 < 重做；成员 < 版本历史 < 动态 < 快捷键 < 查找
  const undoX = (await page.getByTestId('undo-btn').boundingBox())!.x;
  const redoX = (await page.getByTestId('redo-btn').boundingBox())!.x;
  expect(redoX).toBeGreaterThan(undoX);
  const themeX = (await page.getByTestId('theme-panel-toggle').boundingBox())!.x;
  expect(themeX).toBeGreaterThan(structX);
  const membersX = (await page.getByTestId('members-btn').boundingBox())!.x;
  const versionsX = (await page.getByTestId('versions-toggle').boundingBox())!.x;
  const activityX = (await page.getByTestId('activity-toggle').boundingBox())!.x;
  const helpX = (await page.getByTestId('help-toggle').boundingBox())!.x;
  const findX = (await page.getByTestId('find-toggle').boundingBox())!.x;
  expect(versionsX).toBeGreaterThan(membersX);
  expect(activityX).toBeGreaterThan(versionsX); // T8 动态入口在版本历史右侧
  expect(helpX).toBeGreaterThan(activityX);
  expect(findX).toBeGreaterThan(helpX);
});
