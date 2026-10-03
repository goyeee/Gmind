import { expect, test, type Page } from '@playwright/test';
import * as Y from 'yjs';

/**
 * 表格列体系升级 E2E（需求方 2026-10-01「排序/自定义列挪进固定列中间/隐藏列/固定列」）。
 *
 * 统一列模型：meta.tableView（order/hidden/pinned/sort）持久化，内置列与自定义列
 * 同一有序清单。覆盖四条主链路：
 * 1. 表头点击三态排序（升→降→取消）+ 行序断言（同父分组内排序、取消恢复树序）
 *    + tableView.sort 持久化落库；
 * 2. 自定义列经列头菜单「左移」挪到「状态」列前（DOM 序 + tableView.order 双断言）；
 * 3. 隐藏负责人列（列头菜单「隐藏」→ 列头/单元格消失 + tableView.hidden 落库）
 *    → 列设置浮层勾选恢复；
 * 4. 固定任务名（列头菜单「固定到左侧」）+ 多列横向滚动 sticky 视觉断言：
 *    滚动后任务名列头/单元格视口 x 不变，未固定列左移出视口 + tableView.pinned 落库。
 *
 * docState 断言模式沿用 custom-columns.e2e.spec.ts（GET /api/files/:id 反解 + 轮询）。
 */

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

/** 打开种子文件并切到表格视图。 */
async function openSeedDocTable(page: Page, title: string): Promise<void> {
  await registerAndLogin(page);
  await page.locator('.file-list li', { hasText: title }).click();
  await expect(page).toHaveURL(/\/edit\//);
  await expect(page.locator('.editor-canvas svg .gm-text', { hasText: title })).toBeVisible();
  await page.getByTestId('view-tab-table').click();
  await expect(page.locator('.task-table-root')).toBeVisible();
}

/** 加列全流程（+ 钮 → 浮层填名选类型 → 添加 → 新列头可见）。 */
async function addColumn(
  page: Page,
  name: string,
  type: 'text' | 'person' | 'progress' | 'date',
): Promise<void> {
  await page.getByTestId('table-col-add').click();
  await page.getByTestId('table-col-add-name').fill(name);
  await page.getByTestId(`table-col-add-type-${type}`).click();
  await page.getByTestId('table-col-add-submit').click();
  await expect(page.locator('.tt-table thead th', { hasText: name })).toBeVisible();
}

/** 服务端 docState → Y.Doc（custom-columns.e2e.spec.ts 同款反解）。 */
async function fetchDoc(page: Page): Promise<Y.Doc> {
  const token = await page.evaluate(() => localStorage.getItem('gmind.token'));
  const fileId = page.url().split('/').pop() ?? '';
  const res = await page.request.get(`/api/files/${fileId}`, {
    headers: { Authorization: `Bearer ${token ?? ''}` },
  });
  expect(res.ok()).toBeTruthy();
  const detail = (await res.json()) as { docState: string };
  const doc = new Y.Doc();
  const binary = atob(detail.docState);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  Y.applyUpdate(doc, bytes);
  return doc;
}

/** 轮询等待自动保存落库后条件满足（≤9s）。 */
async function waitForDoc(page: Page, check: (doc: Y.Doc) => boolean): Promise<Y.Doc> {
  for (let i = 0; i < 30; i += 1) {
    const doc = await fetchDoc(page);
    if (check(doc)) return doc;
    await page.waitForTimeout(300);
  }
  throw new Error('waitForDoc: 自动保存落库超时（条件未满足）');
}

/** 落库的 meta.tableView（plain 形状；无键文档 undefined）。 */
interface DocTableView {
  order?: string[];
  hidden?: string[];
  pinned?: string[];
  sort?: { key: string; dir: number } | null;
}

function tableViewOf(doc: Y.Doc): DocTableView | undefined {
  const raw = doc.getMap('meta').get('tableView');
  return (raw ?? undefined) as DocTableView | undefined;
}

/** 当前表格行序（标题文本数组，树序/排序态断言共用）。 */
async function rowTitles(page: Page): Promise<string[]> {
  return page.locator('.tt-table tbody .tt-title-text').allInnerTexts();
}

test('表头三态排序：升→降→取消恢复树序，行序（同父分组内）随动且 sort 持久化落库', async ({ page }) => {
  test.setTimeout(90_000);
  await openSeedDocTable(page, '本周计划');

  // 种子树序：周一>周会对齐 / 周三>方案评审 / 周五>周报复盘
  expect(await rowTitles(page)).toEqual(['周一', '周会对齐', '周三', '方案评审', '周五', '周报复盘']);

  // 第一次点击「任务」列名（.tt-col-name 命中，避开 ⋯ 菜单钮）：升序
  const titleHead = page.locator('.tt-table thead th[data-col-key="title"]');
  await titleHead.locator('.tt-col-name').click();
  await expect(titleHead).toContainText('↑');
  // 同父分组内排序：顶层按拼音 周三<周五<周一，子行随父行
  expect(await rowTitles(page)).toEqual(['周三', '方案评审', '周五', '周报复盘', '周一', '周会对齐']);

  // 排序态落库：meta.tableView.sort = {key:'title', dir:1}
  const asc = await waitForDoc(page, (d) => tableViewOf(d)?.sort?.key === 'title');
  expect(tableViewOf(asc)!.sort).toEqual({ key: 'title', dir: 1 });

  // 第二次点击：降序（空行恒排尾的逆序即整组反转）
  await titleHead.locator('.tt-col-name').click();
  await expect(titleHead).toContainText('↓');
  expect(await rowTitles(page)).toEqual(['周一', '周会对齐', '周五', '周报复盘', '周三', '方案评审']);

  // 第三次点击：取消排序 → 恢复树序 + sort 清空落库
  await titleHead.locator('.tt-col-name').click();
  await expect(titleHead).not.toContainText('↑');
  await expect(titleHead).not.toContainText('↓');
  expect(await rowTitles(page)).toEqual(['周一', '周会对齐', '周三', '方案评审', '周五', '周报复盘']);
  const neutral = await waitForDoc(page, (d) => tableViewOf(d)?.sort == null);
  expect(tableViewOf(neutral)!.sort).toBeNull();
});

test('自定义列左移到「状态」列前：DOM 列序与 tableView.order 双断言（统一列模型）', async ({ page }) => {
  test.setTimeout(90_000);
  await openSeedDocTable(page, '本周计划');
  await addColumn(page, '备注', 'text');

  const customHead = page.getByTestId('table-custom-col-header');
  const colId = (await customHead.getAttribute('data-col-id')) ?? '';
  expect(colId).not.toBe('');

  // 列头菜单「左移」循环：直至自定义列头位于「状态」列头左侧（新列初始在最末，
  // 需越过 updatedAt/doneDate/dueDate/startDate/progress/status 共 6 步）
  const statusHead = page.locator('.tt-table thead th[data-col-key="status"]');
  for (let i = 0; i < 8; i += 1) {
    const [cx, sx] = await Promise.all([customHead.boundingBox(), statusHead.boundingBox()]);
    if (cx && sx && cx.x < sx.x) break;
    await customHead.click({ button: 'right' });
    await page.getByTestId('table-col-menu-left').click();
    await expect(page.getByTestId('table-col-menu')).toHaveCount(0); // 菜单收起后再走下一轮
  }
  const headers = await page
    .locator('.tt-table thead th[data-col-key]')
    .evaluateAll((els) => els.map((e) => e.dataset.colKey ?? ''));
  expect(headers.indexOf(colId)).toBeGreaterThan(0);
  expect(headers.indexOf(colId)).toBeLessThan(headers.indexOf('status'));

  // 落库：meta.tableView.order 中 colId 位于 'status' 前（自定义列挪进内置列中间）
  const doc = await waitForDoc(page, (d) => {
    const order = tableViewOf(d)?.order;
    return Array.isArray(order) && order.indexOf(colId) >= 0 && order.indexOf(colId) < order.indexOf('status');
  });
  const order = tableViewOf(doc)!.order!;
  // canonical 完整排列：内置 8 列 + 1 自定义列全在序
  expect(order).toHaveLength(9);
});

test('隐藏负责人列：列头/单元格消失 + hidden 落库 → 列设置浮层勾选恢复', async ({ page }) => {
  test.setTimeout(90_000);
  await openSeedDocTable(page, '本周计划');

  // 列头菜单「隐藏」：负责人列头与全部单元格消失
  await page.locator('.tt-table thead th[data-col-key="owner"]').click({ button: 'right' });
  await page.getByTestId('table-col-menu-hide').click();
  await expect(page.locator('.tt-table thead th[data-col-key="owner"]')).toHaveCount(0);
  await expect(page.locator('[data-testid$="-owners"]')).toHaveCount(0);

  // 落库：meta.tableView.hidden = ['owner']
  const doc = await waitForDoc(page, (d) => tableViewOf(d)?.hidden?.includes('owner') === true);
  expect(tableViewOf(doc)!.hidden).toEqual(['owner']);

  // 列设置浮层：负责人复选未勾 → 勾选恢复
  await page.getByTestId('table-col-settings').click();
  const ownerToggle = page.getByTestId('table-col-toggle-owner').locator('input');
  await expect(ownerToggle).not.toBeChecked();
  // 任务名复选恒选中且禁用（不可隐藏裁定）
  const titleToggle = page.getByTestId('table-col-toggle-title').locator('input');
  await expect(titleToggle).toBeChecked();
  await expect(titleToggle).toBeDisabled();
  await ownerToggle.check();
  await expect(page.locator('.tt-table thead th[data-col-key="owner"]')).toBeVisible();
  await expect(page.locator('[data-testid$="-owners"]').first()).toBeVisible();

  // 恢复落库：hidden 清空
  const restored = await waitForDoc(page, (d) => (tableViewOf(d)?.hidden?.length ?? 0) === 0);
  expect(tableViewOf(restored)!.hidden).toEqual([]);
});

test('固定任务名 + 多列横向滚动：sticky 列滚动后视口位置不变，未固定列左移出视口', async ({ page }) => {
  test.setTimeout(90_000);
  await openSeedDocTable(page, '本周计划');
  // 多列场景：4 个自定义列使表格超宽（minWidth 1120+4×130=1640 > 1280 视口）
  for (const name of ['列甲', '列乙', '列丙', '列丁']) {
    await addColumn(page, name, 'text');
  }

  // 列头菜单「固定到左侧」
  await page.locator('.tt-table thead th[data-col-key="title"]').click({ button: 'right' });
  await page.getByTestId('table-col-menu-pin').click();
  await expect(page.getByTestId('table-col-menu')).toHaveCount(0);

  const scroll = page.locator('.tt-scroll');
  const titleHead = page.locator('.tt-table thead th[data-col-key="title"]');
  const titleCell = page.locator('.tt-table tbody tr').first().locator('td[data-col-key="title"]');
  const updatedHead = page.locator('.tt-table thead th[data-col-key="updatedAt"]');

  // 前置：横向滚动确实存在（自定义列撑宽）
  const scrollable = await scroll.evaluate((el) => el.scrollWidth > el.clientWidth);
  expect(scrollable).toBe(true);

  const beforeHead = await titleHead.boundingBox();
  const beforeCell = await titleCell.boundingBox();
  const beforeUpdated = await updatedHead.boundingBox();
  expect(beforeHead && beforeCell && beforeUpdated).toBeTruthy();
  await scroll.evaluate((el) => {
    el.scrollLeft = el.scrollWidth; // 滚到最右
  });
  await page.waitForTimeout(200); // 粘附重排（含 sticky 偏移测量帧）

  const afterHead = await titleHead.boundingBox();
  const afterCell = await titleCell.boundingBox();
  const afterUpdated = await updatedHead.boundingBox();
  expect(afterHead && afterCell && afterUpdated).toBeTruthy();
  // 视觉断言：固定列头/单元格滚动后 x 不变（sticky 生效）
  expect(Math.abs(afterHead!.x - beforeHead!.x)).toBeLessThanOrEqual(1);
  expect(Math.abs(afterCell!.x - beforeCell!.x)).toBeLessThanOrEqual(1);
  // 未固定列被滚出视口（x 左移）
  expect(afterUpdated!.x).toBeLessThan(beforeUpdated!.x);

  // 落库：meta.tableView.pinned = ['title']
  const doc = await waitForDoc(page, (d) => tableViewOf(d)?.pinned?.includes('title') === true);
  expect(tableViewOf(doc)!.pinned).toEqual(['title']);
});
