import { expect, test, type Page } from '@playwright/test';

/**
 * 工具栏图标化分组改版 E2E — M6 Task 1（企微对标）；2026-09-28 标记面板任务
 * 追加「插入」组（标记/备注/链接/图片，位于结构主题与导出之间）。
 *
 * 结构断言（不改既有用例、只新增）：
 * 1. 单行分组：8 个 .toolbar-group（返回/标题/撤销重做格式刷/结构主题/插入/导出/
 *    协作视图/全屏），组间竖线分隔符 .toolbar-sep ≥7；
 * 2. 图标按钮：全部 .toolbar-btn 均含内联 svg 子元素 + 非空 title 提示；
 * 3. 既有 testid 全保留（循环逐个断言可见）；
 * 4. find-toggle：T3 起已接线为查找入口（启用 + title「查找 (Ctrl+F)」+ 点击打开查找条）；
 * 5. 组序与目标布局一致（按 x 坐标：返回 → 标题 → 撤销重做 → 结构主题 → 插入 →
 *    导出 → 协作 → 全屏）。
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

/** 既有工具栏 testid 清单（改版后必须全部仍在，mobile-readonly 清单的桌面全集）。 */
const EXISTING_TESTIDS = [
  'back-btn',
  'title-input',
  'star-toggle',
  'save-status',
  'undo-btn',
  'redo-btn',
  'structure-select',
  'theme-select',
  'insert-menu',
  'export-menu',
  'members-btn',
  'versions-toggle',
  'activity-toggle',
  'help-toggle',
  'fullscreen-btn',
] as const;

test('工具栏：单行分组 + 竖线分隔符（8 组 / ≥7 分隔线）', async ({ page }) => {
  await openSeedDoc(page);
  const toolbar = page.locator('.editor-toolbar');
  await expect(toolbar).toBeVisible();
  // 分组容器：返回 / 标题 / 撤销重做格式刷 / 结构主题 / 插入 / 导出 / 成员·版本·快捷键·查找 / 全屏
  await expect(toolbar.locator('> .toolbar-group')).toHaveCount(8);
  // 组间 1px 竖线分隔符
  await expect(toolbar.locator('.toolbar-sep')).toHaveCount(7);
  // 每个分隔符都是 1px 宽的竖线元素（可见）
  const seps = toolbar.locator('.toolbar-sep');
  for (let i = 0; i < await seps.count(); i++) {
    await expect(seps.nth(i)).toBeVisible();
  }
});

test('工具栏：图标按钮均带内联 svg 与 title 提示', async ({ page }) => {
  await openSeedDoc(page);
  const iconButtons = page.locator('.editor-toolbar button.toolbar-btn');
  // 返回/撤销/重做/格式刷/导出/成员/版本历史/动态/快捷键/查找/全屏/主题面板/插入 = 13 个
  // 图标按钮（T8 activity-toggle，T7 format-painter，T4 theme-panel-toggle，
  // 标记面板任务 insert-menu）
  await expect(iconButtons).toHaveCount(13);
  const count = await iconButtons.count();
  for (let i = 0; i < count; i++) {
    const btn = iconButtons.nth(i);
    await expect(btn.locator('> svg')).toHaveCount(1);
    const title = await btn.getAttribute('title');
    expect(title, '图标按钮必须有非空 title 悬停提示').toBeTruthy();
    expect(title!.trim().length).toBeGreaterThan(0);
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

test('工具栏：members-btn 与结构/主题下拉可访问名语义正确', async ({ page }) => {
  await openSeedDoc(page);
  // 评审 Important（round 1）：members-btn 内容为 aria-hidden SVG + 角标数字，
  // accname 计算内容先于 title → 名字会退化为「1」；须 aria-label 补语义名。
  await expect(page.getByTestId('members-btn')).toHaveAccessibleName('在线成员');
  // 外包 div 的 title 不下传给 <select>，读屏得到空名 → 各补 aria-label。
  await expect(page.getByTestId('structure-select')).toHaveAccessibleName('结构');
  await expect(page.getByTestId('theme-select')).toHaveAccessibleName('主题');
});

test('工具栏：组序符合企微对标布局（返回|标题|撤销重做|结构主题|插入|导出|协作|全屏）', async ({ page }) => {
  await openSeedDoc(page);
  const anchors = [
    page.getByTestId('back-btn'),
    page.getByTestId('title-input'),
    page.getByTestId('undo-btn'),
    page.getByTestId('structure-select'),
    page.getByTestId('insert-menu'),
    page.getByTestId('export-menu'),
    page.getByTestId('members-btn'),
    page.getByTestId('fullscreen-btn'),
  ];
  const xs: number[] = [];
  for (const anchor of anchors) {
    const box = await anchor.boundingBox();
    expect(box, '锚点必须已渲染').toBeTruthy();
    xs.push(box!.x);
  }
  for (let i = 1; i < xs.length; i++) {
    expect(xs[i], `第 ${i + 1} 组必须在第 ${i} 组右侧（x 单调递增）`).toBeGreaterThan(xs[i - 1]);
  }
  // 插入组落位钉死：结构主题 < 插入 < 导出（标记面板任务新增组）
  const structX = (await page.getByTestId('structure-select').boundingBox())!.x;
  const insertX = (await page.getByTestId('insert-menu').boundingBox())!.x;
  const exportX = (await page.getByTestId('export-menu').boundingBox())!.x;
  expect(insertX).toBeGreaterThan(structX);
  expect(exportX).toBeGreaterThan(insertX);
  // 同组相邻：撤销 < 重做、结构 < 主题、成员 < 版本历史 < 动态 < 快捷键 < 查找
  const undoX = (await page.getByTestId('undo-btn').boundingBox())!.x;
  const redoX = (await page.getByTestId('redo-btn').boundingBox())!.x;
  expect(redoX).toBeGreaterThan(undoX);
  const themeX = (await page.getByTestId('theme-select').boundingBox())!.x;
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
