import { expect, test, type Page } from '@playwright/test';
import * as Y from 'yjs';

/**
 * 表格自定义列 E2E（M7c 消费侧：TaskTable 动态列 + 表头管理 + 任务面板自定义属性）。
 *
 * 覆盖链路：
 * 1. 加列（文本类型）→ 表头出现新列 → 单元格点击填写 → 服务端 docState 断言
 *    （meta.customColumns schema + 节点 custom 值）；
 * 2. 加人员列 + 日期列 → 人员弹层选成员（复用 MemberMultiSelect）、日期格填值 →
 *    docState 断言 person 数组与 'YYYY-MM-DD'；
 * 3. TaskPanel（2026-10-10 起替代已删除的右键「任务设置」快速卡/`,` 快捷键）：
 *    自定义属性小节按列可见 → 修改文本列值 → 切回表格回显（双视图同源 doc）；
 * 4. 删列：列头右键菜单 confirm → 列消失 + 节点值被清除（core 同事务孤儿清理）。
 *
 * docState 断言模式沿用 editor.e2e.spec.ts：GET /api/files/:id 反解 docState，
 * 以轮询等待自动保存落库（避免依赖「已保存」指示的时序竞态）。
 */

async function registerAndLogin(page: Page): Promise<string> {
  await page.goto('/login');
  const phone = '138' + String(Math.floor(10000000 + Math.random() * 89999999));
  await page.getByPlaceholder('手机号').fill(phone);
  await page.getByPlaceholder('验证码（开发环境固定 123456）').fill('123456');
  await page.getByRole('button', { name: '登录', exact: true }).click();
  await expect(page).toHaveURL(/\/workspace/);
  await expect(page.locator('.file-list li')).toHaveCount(3);
  return phone; // 手机号回传：注册用户昵称 = `用户${phone 后 4 位}`（人员列断言用）
}

/** 打开种子文件并切到表格视图；返回注册手机号。 */
async function openSeedDocTable(page: Page, title: string): Promise<string> {
  const phone = await registerAndLogin(page);
  await page.locator('.file-list li', { hasText: title }).click();
  await expect(page).toHaveURL(/\/edit\//);
  await expect(page.locator('.editor-canvas svg .gm-text', { hasText: title })).toBeVisible();
  await page.getByTestId('view-tab-table').click();
  await expect(page.locator('.task-table-root')).toBeVisible();
  return phone;
}

/** 加列全流程：+ 钮 → 浮层填名选类型 → 添加 → 新列头可见（提交后浮层自动收起）。 */
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

/** 服务端 docState → Y.Doc（editor.e2e.spec.ts 同款反解）。 */
async function fetchDoc(page: Page): Promise<Y.Doc> {
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
  return doc;
}

/** 轮询等待自动保存落库后条件满足（≤9s），返回满足条件的 doc 快照。 */
async function waitForDoc(page: Page, check: (doc: Y.Doc) => boolean): Promise<Y.Doc> {
  for (let i = 0; i < 30; i += 1) {
    const doc = await fetchDoc(page);
    if (check(doc)) return doc;
    await page.waitForTimeout(300);
  }
  throw new Error('waitForDoc: 自动保存落库超时（条件未满足）');
}

/** 按文本精确查节点 id（模板 ULID 不可预知）。 */
function findNodeByText(doc: Y.Doc, text: string): string {
  const nodes = doc.getMap('nodes') as Y.Map<Y.Map<unknown>>;
  for (const [id, node] of nodes.entries()) {
    if (String(node.get('text') ?? '') === text) return id;
  }
  throw new Error(`docState 中未找到节点：${text}`);
}

/** 节点 custom Y.Map（无则 undefined）。 */
function customOf(doc: Y.Doc, nodeId: string): Y.Map<unknown> | undefined {
  const node = (doc.getMap('nodes') as Y.Map<Y.Map<unknown>>).get(nodeId);
  const custom = node?.get('custom');
  return custom instanceof Y.Map ? custom : undefined;
}

/** custom 值普通化：Yjs 存 person 数组时转码为 Y.Array（core 读取侧快照才归一为
 *  plain 数组），断言前统一拍平。 */
function plainCustomValues(doc: Y.Doc, nodeId: string): unknown[] {
  const custom = customOf(doc, nodeId);
  if (custom === undefined) return [];
  return [...custom.values()].map((v) => (v instanceof Y.Array ? v.toArray() : v));
}

test('加文本列 → 表头出现新列，单元格填写后 docState 落库 schema 与节点值', async ({ page }) => {
  test.setTimeout(90_000);
  await openSeedDocTable(page, '本周计划');

  // 无列文档零噪音：无自定义列表头/单元格，只有「+」钮
  await expect(page.getByTestId('table-custom-col-header')).toHaveCount(0);
  await expect(page.getByTestId('table-custom-cell')).toHaveCount(0);
  await expect(page.getByTestId('table-col-add')).toBeVisible();

  await addColumn(page, '备注', 'text');

  // 种子 6 行（周一/周三/周五 + 3 孙）各出一个自定义单元格
  await expect(page.getByTestId('table-custom-cell')).toHaveCount(6);

  // 周一行单元格：点击变输入框 → 填值 → blur 提交（点行号表头脱焦）
  const row = page.locator('.tt-table tbody tr', { hasText: '周一' });
  await row.getByTestId('table-custom-text').click();
  const input = page.getByTestId('table-custom-text-input');
  await expect(input).toBeVisible();
  await input.fill('重要事项');
  await page.locator('.tt-table thead th.tt-rownum').click();
  await expect(page.getByTestId('table-custom-text-input')).toHaveCount(0);
  await expect(row.getByTestId('table-custom-text')).toHaveText('重要事项');

  // docState：meta.customColumns schema（1 列 text/备注）+ 周一节点 custom 值
  const doc = await waitForDoc(page, (d) => {
    const cols = d.getMap('meta').get('customColumns');
    return Array.isArray(cols) && cols.length === 1;
  });
  const cols = doc.getMap('meta').get('customColumns') as { id: string; name: string; type: string }[];
  expect(cols[0].name).toBe('备注');
  expect(cols[0].type).toBe('text');
  expect(customOf(doc, findNodeByText(doc, '周一'))?.get(cols[0].id)).toBe('重要事项');
});

test('加人员列+日期列 → 弹层选成员、日期格填值，docState 落库', async ({ page }) => {
  test.setTimeout(90_000);
  const phone = await openSeedDocTable(page, '本周计划');

  await addColumn(page, '复核人', 'person');
  await addColumn(page, '截止', 'date');
  await expect(page.getByTestId('table-custom-col-header')).toHaveCount(2);

  const row = page.locator('.tt-table tbody tr', { hasText: '周一' });
  const cells = row.getByTestId('table-custom-cell');

  // 人员格（第 1 自定义列）：点击开弹层 → 选第一个成员（文档 owner）→ 回显昵称
  await cells.nth(0).getByRole('button').click();
  const chip = page.locator('.tt-popover [data-testid^="table-custom-member-"]').first();
  await expect(chip).toBeVisible();
  const chipId = (await chip.getAttribute('data-testid')) ?? '';
  const memberId = chipId.replace('table-custom-member-', '');
  expect(memberId).not.toBe('');
  await chip.click();
  await page.locator('.tt-overlay').click(); // 弹层遮罩即「外点收起」的命中层（盖住整表）
  await expect(page.locator('.tt-overlay')).toHaveCount(0);
  await expect(cells.nth(0)).toContainText(`用户${phone.slice(-4)}`);

  // 日期格（第 2 自定义列）：SmartDateInput 直接填值即提交
  const dateInput = cells.nth(1).locator('input[data-smart-date]');
  await dateInput.fill('2026-10-15');
  await expect(dateInput).toHaveValue('2026-10-15');

  // docState：person = 用户ID 数组、date = 'YYYY-MM-DD'（按值形状断言——colId 生成不可预知）
  const nodeId = findNodeByText(await fetchDoc(page), '周一'); // 前置：节点已可见（同步读）
  const doc = await waitForDoc(
    page,
    (d) => {
      const vals = plainCustomValues(d, nodeId);
      return vals.some((v) => Array.isArray(v) && v.includes(memberId)) && vals.includes('2026-10-15');
    },
  );
  const vals = plainCustomValues(doc, nodeId);
  expect(vals.some((v) => Array.isArray(v) && (v as string[]).includes(memberId))).toBeTruthy();
  expect(vals).toContain('2026-10-15');
});

test('任务面板：自定义属性三列可见，修改文本列值后表格回显（2026-10-10 快速卡退役后路径）', async ({ page }) => {
  test.setTimeout(90_000);
  await openSeedDocTable(page, '本周计划');

  await addColumn(page, '备注', 'text');
  await addColumn(page, '复核人', 'person');
  await addColumn(page, '截止', 'date');

  // 切脑图 → 选周一 → 工具栏「任务」开 TaskPanel（右键「任务设置」/`,` 快速卡已随
  // 2026-10-10 裁定删除，自定义属性小节由 TaskPanel 承接）
  await page.getByTestId('view-tab-mind').click();
  await expect(page.locator('.editor-canvas svg .gm-text', { hasText: '周一' })).toBeVisible();
  await page.locator('.editor-canvas svg .gm-text', { hasText: '周一' }).click();
  await page.getByTestId('task-toggle').click();
  const panel = page.getByTestId('task-panel');
  await expect(panel).toBeVisible();

  // 自定义属性小节：三列逐行渲染（text 输入 / person 占位「选择成员」/ date 日期框）
  const section = panel.getByTestId('task-panel-custom-section');
  await expect(section).toBeVisible();
  const textRow = panel.locator('[data-testid="task-panel-custom-row"]', { hasText: '备注' });
  await expect(textRow).toBeVisible();
  await expect(panel.locator('[data-testid="task-panel-custom-row"]', { hasText: '复核人' })).toContainText(
    '选择成员',
  );
  await expect(
    panel.locator('[data-testid="task-panel-custom-row"]', { hasText: '截止' }).locator('input[data-smart-date]'),
  ).toBeVisible();

  // 修改文本列值（失焦即改即存）→ 切回表格回显（双视图同源 doc）
  await textRow.locator('input').fill('面板填写');
  await panel.locator('.task-panel-head').click();
  await page.getByTestId('view-tab-table').click();
  const row = page.locator('.tt-table tbody tr', { hasText: '周一' });
  await expect(row.getByTestId('table-custom-text')).toHaveText('面板填写');
});

test('删列：confirm 后列消失，节点值被清除（docState 断言孤儿清理）', async ({ page }) => {
  test.setTimeout(90_000);
  await openSeedDocTable(page, '本周计划');

  await addColumn(page, '备注', 'text');
  const row = page.locator('.tt-table tbody tr', { hasText: '周一' });
  await row.getByTestId('table-custom-text').click();
  await page.getByTestId('table-custom-text-input').fill('将被清除');
  await page.locator('.tt-table thead th.tt-rownum').click();
  await expect(row.getByTestId('table-custom-text')).toHaveText('将被清除');

  // 值先落库（删列断言的对照前置）
  const nodeId = findNodeByText(await fetchDoc(page), '周一');
  await waitForDoc(page, (d) => [...(customOf(d, nodeId)?.values() ?? [])].includes('将被清除'));

  // 右键列头 → 列管理菜单 → 删除 → confirm 接受
  await page.getByTestId('table-custom-col-header').click({ button: 'right' });
  await expect(page.getByTestId('table-col-menu')).toBeVisible();
  page.once('dialog', (dialog) => void dialog.accept());
  await page.getByTestId('table-col-menu-delete').click();

  // 列消失：表头/单元格全部回收（无列文档零噪音，只剩 + 钮）
  await expect(page.getByTestId('table-custom-col-header')).toHaveCount(0);
  await expect(page.getByTestId('table-custom-cell')).toHaveCount(0);
  await expect(page.getByTestId('table-col-add')).toBeVisible();

  // docState：schema 清空 + 周一 custom 无任何键（core 同事务孤儿清理）
  const doc = await waitForDoc(page, (d) => {
    const cols = d.getMap('meta').get('customColumns');
    return Array.isArray(cols) && cols.length === 0;
  });
  const custom = customOf(doc, nodeId);
  expect(custom === undefined || custom.size === 0).toBeTruthy();
});
