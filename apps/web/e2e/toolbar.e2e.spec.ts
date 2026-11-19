import { expect, test, type Page } from '@playwright/test';
import { registerAndLogin } from './helpers/auth';

/**
 * 工具栏图标化分组改版 E2E — M6 Task 1（企微对标）+ 历轮改版追平（2026-09-28）：
 * - M7b-R2/R3/R4：样式右列收进「格式」按钮（右列默认隐藏）、企微三按钮
 *   上级主题·子主题·同级主题（复用 Shift+Tab/Tab/Enter 路径）、主题下拉移除只留
 *   theme-panel-toggle 面板按钮、视图切换（脑图|表格）分段控件入列；
 * - M7c-C4：任务面板开关「任务」与格式同组互斥；
 * - M7b 补课：简洁模式切换「简洁」（任务钮旁，账号级显示偏好，激活蓝描边）。
 *
 * 结构断言：
 * 1. 单行分组：11 个 .toolbar-group（返回/标题/视图切换/撤销重做格式刷/插入/
 *    上级子级同级/格式任务简洁/结构主题/导出/协作视图/全屏），组间竖线分隔符 9；
 * 2. 图标按钮：全部带内联 svg 的 .toolbar-btn 均含非空 title 提示（17 枚；
 *    上级/子级/同级三按钮为纯文字钮，label+title 单列断言）；
 * 3. 既有 testid 全保留（循环逐个断言可见）；
 * 4. find-toggle：查找入口（启用 + title「查找 (Ctrl+F)」+ 点击打开查找条）；
 * 5. 组序（按 x 坐标）：返回 → 标题 → 视图切换 → 撤销重做格式刷 → 插入 → 上级
 *    子级同级 → 格式任务 → 结构主题 → 导出 → 协作 → 全屏。
 *
 * 登录走公共 helper helpers/auth（邮箱注册即赠 3 个种子文件）。
 */


async function openSeedDoc(page: Page): Promise<void> {
  await registerAndLogin(page);
  await page.getByTestId('file-card').filter({ hasText: '本周计划' }).first().click();
  await expect(page).toHaveURL(/\/edit\//);
  await expect(page.locator('.editor-canvas svg .gm-text', { hasText: '本周计划' })).toBeVisible();
}

/** 既有工具栏 testid 清单（历轮改版后必须全部仍在，mobile-readonly 清单的桌面全集）。
 *  structure-select 已随 2026-09-30 结构面板改版移除（structure-select →
 *  structure-toggle + structure-panel，见 editor.e2e 用例 5 适配）。
 *  insert-menu 已随 2026-10-10 需求方裁定整体删除（菜单连条目全删）。
 *  2026-10-25 原型顶栏重组：comment-toggle/help-toggle 移入「更多」下拉
 *  （more-toggle），默认不渲染故移出本清单——见下方「更多菜单」用例。 */
const EXISTING_TESTIDS = [
  'back-btn',
  'title-display',
  'title-edit',
  'star-toggle',
  'save-status',
  'undo-btn',
  'redo-btn',
  'structure-toggle',
  'theme-panel-toggle',
  'members-btn',
  // avatar-me 已随 2026-11-16 需求方裁定整体删除（个人中心入口退役）
  'activity-toggle',
  'more-toggle',
  // fullscreen-btn 2026-10-09 迁至底栏右侧（.editor-bottombar），testid 保留
  'fullscreen-btn',
  'format-toggle',
  'task-toggle',
  'compact-toggle',
  'toolbar-add-parent',
  'toolbar-add-child',
  'toolbar-add-sibling',
  'view-tab-mind',
  'view-tab-table',
] as const;

test('工具栏：原型单行分组（8 组 / 7 分隔线），1512/1440/1280 均不换行不横滚', async ({ page }) => {
  await openSeedDoc(page);
  const toolbar = page.locator('.editor-toolbar');
  await expect(toolbar).toBeVisible();
  await expect(toolbar.locator('> .toolbar-group')).toHaveCount(8);
  await expect(toolbar.locator('.toolbar-sep')).toHaveCount(7);
  for (const width of [1512, 1440, 1280]) {
    await page.setViewportSize({ width, height: 800 });
    await expect(toolbar).toHaveCSS('height', '52px');
    const lineCenters = await toolbar
      .locator('> *')
      .evaluateAll((els) => els.map((e) => {
        const rect = (e as HTMLElement).getBoundingClientRect();
        return rect.top + rect.height / 2;
      }));
    expect(Math.max(...lineCenters) - Math.min(...lineCenters), `${width}px 工具栏必须单行`).toBeLessThanOrEqual(1);
    const { scrollWidth, clientWidth } = await toolbar.evaluate((el) => ({ scrollWidth: el.scrollWidth, clientWidth: el.clientWidth }));
    expect(scrollWidth, `${width}px 工具栏不得横向溢出（${scrollWidth} > ${clientWidth}）`).toBeLessThanOrEqual(clientWidth);
    const shareBox = await page.getByTestId('share-btn').boundingBox();
    expect(shareBox!.x + shareBox!.width, `${width}px 分享按钮必须完整可见`).toBeLessThanOrEqual(width);
  }
  const labels = toolbar.locator('.toolbar-btn-label');
  await expect(labels).toHaveCount(11);
  for (let i = 0; i < (await labels.count()); i++) {
    await expect(labels.nth(i)).toBeVisible();
  }
});

test('800px 窄窗口进入简化分支，成员与分享完整可点且不横向溢出', async ({ page }) => {
  await page.setViewportSize({ width: 800, height: 800 });
  await openSeedDoc(page);
  await expect(page.getByTestId('toolbar-add-child')).toHaveCount(0);
  await expect(page.getByTestId('members-btn')).toBeVisible();
  await expect(page.getByTestId('share-btn')).toBeVisible();
  const toolbar = page.locator('.editor-toolbar');
  expect(await toolbar.evaluate((el) => el.scrollWidth <= el.clientWidth)).toBe(true);
  const share = await page.getByTestId('share-btn').boundingBox();
  expect(share!.x + share!.width).toBeLessThanOrEqual(800);
  await page.getByTestId('members-btn').click();
  await expect(page.getByTestId('share-tab-members')).toHaveAttribute('aria-selected', 'true');
});

test('顶部品牌与右侧按钮按原型呈现，顶部导出入口已删除', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await openSeedDoc(page);
  await expect(page.getByTestId('back-btn').locator('svg')).toHaveCount(1);
  await expect(page.getByTestId('toolbar-brand-name')).toHaveText('Gmind');
  await expect(page.getByTestId('title-edit')).toBeVisible();
  await expect(page.getByTestId('title-display')).toBeVisible();
  expect((await page.getByTestId('title-display').boundingBox())!.width).toBeGreaterThanOrEqual(120);
  await expect(page.getByTestId('share-btn').locator('svg')).toHaveCount(1);
  expect((await page.getByTestId('share-btn').boundingBox())!.height).toBe(40);
  expect((await page.getByTestId('members-btn').boundingBox())!.height).toBe(40);
  expect((await page.locator('.members-stack-avatar').first().boundingBox())!.height).toBe(28);
  await expect(page.getByTestId('export-menu')).toHaveCount(0);
});

test('工具栏：图标按钮均带内联 svg 与 title 提示；上级/子级/同级为文字钮', async ({ page }) => {
  await openSeedDoc(page);
  const iconButtons = page.locator('.editor-toolbar button.toolbar-btn', { has: page.locator('> svg') });
  // 返回/撤销/重做/格式刷/格式/任务/待办/简洁/结构/主题面板/导出/版本历史/动态/
  // 查找 = 14 个图标按钮（插入钮 2026-10-10 随菜单删除出列；全屏 2026-10-09 迁至
  // 底栏右侧，testid 保留；「待办」2026-10-24 入列；快捷键图标钮 2026-10-25 原型
  // 顶栏重组移入「更多」菜单——菜单项不带 toolbar-btn class 出列；members 图标
  // 随同日头像堆形态出列——头像堆为 span 结构非 svg 图标钮）
  await expect(iconButtons).toHaveCount(11);
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
  await page.setViewportSize({ width: 1600, height: 800 });
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
  await expect(page.getByTestId('members-btn')).toHaveAccessibleName('协作成员，共 1 人，1 人在线');
  // 结构入口（2026-09-30 任务 3）：select 移除后为面板 toggle 按钮，aria-label
  // 同语义保留（accessible-name 契约自 structure-select 平移）
  await expect(page.getByTestId('structure-toggle')).toHaveAccessibleName('结构');
  // 主题入口（M7b-W2 #6）：下拉移除后为面板按钮，aria-label 同语义保留
  await expect(page.getByTestId('theme-panel-toggle')).toHaveAccessibleName('主题');
});

test('工具栏：组序符合原型布局（品牌|标题|视图|历史|主题操作|动态查找|成员分享）', async ({ page }) => {
  await openSeedDoc(page);
  const anchors = [
    'back-btn',
    'title-display',
    'view-tab-mind',
    'undo-btn',
    'toolbar-add-parent',
    'format-toggle',
    'structure-toggle',
    'theme-panel-toggle',
    'activity-toggle',
    'find-toggle',
    'members-btn',
    'share-btn',
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
  // 企微三按钮组落位钉死：撤销重做刷 < 上级子级同级 < 格式任务 < 结构主题
  // （插入组 2026-10-10 删除后，三钮组左邻为撤销重做格式刷组）
  const redoX0 = (await page.getByTestId('redo-btn').boundingBox())!.x;
  const addX = (await page.getByTestId('toolbar-add-parent').boundingBox())!.x;
  const formatX = (await page.getByTestId('format-toggle').boundingBox())!.x;
  const structX = (await page.getByTestId('structure-toggle').boundingBox())!.x;
  expect(addX).toBeGreaterThan(redoX0);
  expect(formatX).toBeGreaterThan(addX);
  expect(structX).toBeGreaterThan(formatX);
  // 同组相邻：撤销 < 重做；版本历史 < 动态 < 查找 < 更多（2026-10-25 原型顶栏
  // 重组：快捷键/评论收进「更多」下拉；成员入口 2026-10-11 迁至顶栏最右本人
  // 头像左侧，不在本组——见下方 members-btn 断言）
  const undoX = (await page.getByTestId('undo-btn').boundingBox())!.x;
  const redoX = (await page.getByTestId('redo-btn').boundingBox())!.x;
  expect(redoX).toBeGreaterThan(undoX);
  const themeX = (await page.getByTestId('theme-panel-toggle').boundingBox())!.x;
  expect(themeX).toBeGreaterThan(structX);
  const activityX = (await page.getByTestId('activity-toggle').boundingBox())!.x;
  const findX = (await page.getByTestId('find-toggle').boundingBox())!.x;
  const moreX = (await page.getByTestId('more-toggle').boundingBox())!.x;
  expect(activityX).toBeGreaterThan(themeX); // 版本历史收进“更多”，动态保持原位
  expect(findX).toBeGreaterThan(activityX);
  expect(moreX).toBeGreaterThan(findX);
  // 2026-11-16：本人头像 avatar-me 删除后，members-btn 为顶栏最右入口，在查找右侧
  const membersX = (await page.getByTestId('members-btn').boundingBox())!.x;
  expect(membersX).toBeGreaterThan(findX);
  const membersBox = (await page.getByTestId('members-btn').boundingBox())!;
  const shareBox = (await page.getByTestId('share-btn').boundingBox())!;
  expect(shareBox.x).toBeGreaterThanOrEqual(membersBox.x + membersBox.width);
  await expect(page.getByTestId('avatar-me')).toHaveCount(0);
});

test('文件名弹窗：打开全选、空名禁用、取消不写、组合输入 Enter 不误提交', async ({ page }) => {
  await openSeedDoc(page);
  const original = await page.getByTestId('title-display').textContent();
  await page.getByTestId('title-edit').click();
  const dialog = page.getByTestId('rename-dialog');
  const input = page.getByTestId('title-input');
  await expect(dialog).toBeVisible();
  await expect(input).toBeFocused();
  expect(await input.evaluate((el: HTMLInputElement) => [el.selectionStart, el.selectionEnd])).toEqual([0, original!.length]);

  await input.fill('   ');
  await expect(page.getByTestId('rename-confirm')).toBeDisabled();
  await input.fill('不应保存');
  await page.getByTestId('rename-cancel').click();
  await expect(dialog).toHaveCount(0);
  await expect(page.getByTestId('title-display')).toHaveText(original!);

  await page.getByTestId('title-edit').click();
  await input.fill('组合输入新名称');
  await input.dispatchEvent('compositionstart');
  await input.evaluate((el: HTMLInputElement) => el.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', isComposing: true, bubbles: true })));
  await expect(dialog).toBeVisible();
  await expect(page.getByTestId('title-display')).toHaveText(original!);
  await input.dispatchEvent('compositionend');
  await page.getByTestId('rename-confirm').click();
  await expect(page.getByTestId('title-display')).toHaveText('组合输入新名称');
});

test('文件名弹窗：Enter 确认后返回工作台，刷新仍保留新名称', async ({ page }) => {
  await openSeedDoc(page);
  const title = `顶部弹窗改名-${Date.now()}`;
  await page.getByTestId('title-edit').click();
  await page.getByTestId('title-input').fill(title);
  await page.getByTestId('title-input').press('Enter');
  await expect(page.getByTestId('rename-dialog')).toHaveCount(0);
  await expect(page.getByTestId('title-display')).toHaveText(title);
  await page.getByTestId('back-btn').click();
  await page.goto('/workspace?view=files');
  await expect(page.getByTestId('file-card').filter({ hasText: title })).toBeVisible();
  await page.reload();
  await expect(page.getByTestId('file-card').filter({ hasText: title })).toBeVisible();
});

test('改名弹窗 Escape 只关闭弹窗，不回收正在创建的空白节点', async ({ page }) => {
  await openSeedDoc(page);
  const groups = page.locator('.editor-canvas svg g[data-node-id]');
  const before = await groups.count();
  await page.keyboard.press('Tab');
  await expect(groups).toHaveCount(before + 1);
  await expect(page.locator('.gm-text-editor')).toHaveCount(0); // 惰性创建：落位但尚未敲字
  await page.getByTestId('title-edit').click();
  await expect(page.getByTestId('rename-dialog')).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.getByTestId('rename-dialog')).toHaveCount(0);
  await expect(groups).toHaveCount(before + 1);
  await expect(page.locator('.editor-canvas svg .gm-text', { hasText: '分支主题 1' })).toBeVisible();
});

test('更多菜单：版本历史/评论/快捷键均可打开真实面板并自动收起', async ({ page }) => {
  await openSeedDoc(page);
  await expect(page.getByTestId('more-menu')).toHaveCount(0);
  await expect(page.getByTestId('comment-toggle')).toHaveCount(0);
  await expect(page.getByTestId('help-toggle')).toHaveCount(0);
  await expect(page.getByTestId('versions-toggle')).toHaveCount(0);
  await page.getByTestId('more-toggle').click();
  const menu = page.getByTestId('more-menu');
  await expect(menu).toBeVisible();
  await expect(menu.getByRole('menuitem', { name: '评论' })).toBeVisible();
  await expect(menu.getByRole('menuitem', { name: '快捷键' })).toBeVisible();
  await expect(menu.getByRole('menuitem', { name: '版本历史' })).toBeVisible();
  await menu.getByRole('menuitem', { name: '版本历史' }).click();
  await expect(page.getByTestId('version-panel')).toBeVisible();
  await expect(menu).toHaveCount(0);
  await page.getByTestId('version-panel-close').click();
  await page.getByTestId('more-toggle').click();
  await menu.getByRole('menuitem', { name: '快捷键' }).click();
  await expect(page.getByTestId('help-panel')).toBeVisible();
  await expect(menu).toHaveCount(0);
  // 外点关闭：重新展开后点画布空白收起
  await page.getByTestId('more-toggle').click();
  await expect(page.getByTestId('more-menu')).toBeVisible();
  await page.locator('.editor-canvas').click({ position: { x: 30, y: 30 } });
  await expect(page.getByTestId('more-menu')).toHaveCount(0);
});
