import { expect, test, type Page } from '@playwright/test';
import * as Y from 'yjs';
import { canvasNodesMap } from '@gmind/core';

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
  await expect(page.getByTestId('mine-grid').getByTestId('file-card')).toHaveCount(3);
  return phone; // 手机号回传：注册用户昵称 = `用户${phone 后 4 位}`（人员列断言用）
}

/** 打开种子文件并切到表格视图；返回注册手机号。 */
async function openSeedDocTable(page: Page, title: string): Promise<string> {
  const phone = await registerAndLogin(page);
  await page.getByTestId('file-card').filter({ hasText: title }).first().click();
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
  type: 'text' | 'progress' | 'date' | 'assignee',
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

/** 多画布读取路径：经 core 画布访问器取节点子图——单画布文档与旧顶层 nodes 完全等价。 */
function nodesMapOf(doc: Y.Doc): Y.Map<Y.Map<unknown>> {
  return canvasNodesMap(doc);
}

/** 按文本精确查节点 id（模板 ULID 不可预知）。 */
function findNodeByText(doc: Y.Doc, text: string): string {
  const nodes = nodesMapOf(doc);
  for (const [id, node] of nodes.entries()) {
    if (String(node.get('text') ?? '') === text) return id;
  }
  throw new Error(`docState 中未找到节点：${text}`);
}

/** 节点 custom Y.Map（无则 undefined）。 */
function customOf(doc: Y.Doc, nodeId: string): Y.Map<unknown> | undefined {
  const node = nodesMapOf(doc).get(nodeId);
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

  await addColumn(page, '复核人', 'assignee');
  await addColumn(page, '截止', 'date');
  await expect(page.getByTestId('table-custom-col-header')).toHaveCount(2);

  const row = page.locator('.tt-table tbody tr', { hasText: '周一' });
  const cells = row.getByTestId('table-custom-cell');

  // 人员格（第 1 自定义列）：点击开弹层 → 选第一个成员（文档 owner）→ 回显「昵称 0%」
  await cells.nth(0).getByRole('button').click();
  const chip = page
    .locator('.tt-popover [data-testid^="table-custom-assignee-editor-member-"]')
    .first();
  await expect(chip).toBeVisible();
  const chipId = (await chip.getAttribute('data-testid')) ?? '';
  const memberId = chipId.replace('table-custom-assignee-editor-member-', '');
  expect(memberId).not.toBe('');
  await chip.click();
  await page.locator('.tt-overlay').click(); // 弹层遮罩即「外点收起」的命中层（盖住整表）
  await expect(page.locator('.tt-overlay')).toHaveCount(0);
  await expect(cells.nth(0)).toContainText(`用户${phone.slice(-4)} 0%`);

  // 日期格（第 2 自定义列）：SmartDateInput 直接填值即提交
  const dateInput = cells.nth(1).locator('input[data-smart-date]');
  await dateInput.fill('2026-10-15');
  await expect(dateInput).toHaveValue('2026-10-15');

  // docState：assignee = Record<userId, {progress}> 对象、date = 'YYYY-MM-DD'
  //（按值形状断言——colId 生成不可预知）
  const nodeId = findNodeByText(await fetchDoc(page), '周一'); // 前置：节点已可见（同步读）
  const doc = await waitForDoc(
    page,
    (d) => {
      const vals = plainCustomValues(d, nodeId);
      return (
        vals.some(
          (v) =>
            typeof v === 'object' &&
            v !== null &&
            typeof (v as Record<string, unknown>)[memberId] === 'object',
        ) && vals.includes('2026-10-15')
      );
    },
  );
  const vals = plainCustomValues(doc, nodeId);
  expect(
    vals.some((v) => {
      if (typeof v !== 'object' || v === null) return false;
      const entry = (v as Record<string, unknown>)[memberId] as { progress?: unknown } | undefined;
      return typeof entry?.progress === 'number';
    }),
  ).toBeTruthy();
  expect(vals).toContain('2026-10-15');
});

test('任务面板：自定义属性三列可见，修改文本列值后表格回显（2026-10-10 快速卡退役后路径）', async ({ page }) => {
  test.setTimeout(90_000);
  await openSeedDocTable(page, '本周计划');

  await addColumn(page, '备注', 'text');
  await addColumn(page, '复核人', 'assignee');
  await addColumn(page, '截止', 'date');

  // 切脑图 → 选周一 → 工具栏「任务」开 TaskPanel（右键「任务设置」/`,` 快速卡已随
  // 2026-10-10 裁定删除，自定义属性小节由 TaskPanel 承接）
  await page.getByTestId('view-tab-mind').click();
  await expect(page.locator('.editor-canvas svg .gm-text', { hasText: '周一' })).toBeVisible();
  await page.locator('.editor-canvas svg .gm-text', { hasText: '周一' }).click();
  await page.getByTestId('task-toggle').click();
  const panel = page.getByTestId('task-panel');
  await expect(panel).toBeVisible();

  // 自定义属性按类型拆入各组：text/progress 留在进度下方无标题区；assignee 紧跟
  // 负责人；date 并入日期组。三列逐行渲染，通过 data-testid="task-panel-custom-row" 定位。
  const textRow = panel.locator('[data-testid="task-panel-custom-row"]', { hasText: '备注' });
  await expect(textRow).toBeVisible();
  await expect(panel.locator('[data-testid="task-panel-custom-row"]', { hasText: '复核人' })).toContainText(
    '选择成员并更新进度',
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

// 用例 5：人员进度列全链路（需求方 2026-10-11 裁定，第 5 种自定义列类型）——
// 加列 → 单元格弹层分配成员（新人默认 0%）→ 更新进度 → 表格进度列显示合成值 →
// 标完成被 done 门禁拦截（两段式 toast：原因+下一步）→ 全 100% 后放行。
test('人员进度列：分配成员/更新进度/合成显示/done 门禁拦截与放行', async ({ page }) => {
  await openSeedDocTable(page, '本周计划');
  await addColumn(page, '测试', 'assignee');
  // 选真叶子行「方案评审」（周一等有子级节点的有效进度=子级均值，人员列只在叶子生效）
  const mondayRow = page.locator('tr', { hasText: '方案评审' }).first();

  // 弹层分配成员（chip 候选含文档 owner=注册用户自己；选中即默认 0%）
  await mondayRow.getByTestId('table-custom-assignee').click();
  await page.locator('[data-testid^="table-custom-assignee-editor-member-"]').first().click();
  await expect(mondayRow.getByTestId('table-custom-assignee')).toContainText('0%');

  // 更新进度 30%（弹层内该行进度输入，Enter 提交）
  const progressInput = page.locator('[data-testid^="table-custom-assignee-editor-progress-"]');
  await progressInput.fill('30');
  await progressInput.press('Enter');
  await expect(mondayRow.getByTestId('table-custom-assignee')).toContainText('30%');
  // 表格进度列叶子显示合成有效进度（owners 空 → 仅条目均值 30%）
  await expect(mondayRow.locator('td[data-col-key="progress"] .tt-bar-num')).toHaveText('30%');

  // docState 落库：方案评审 custom 含 {userId: {progress: 30}}
  await waitForDoc(page, (d) => {
    const id = findNodeByText(d, '方案评审');
    const custom = customOf(d, id);
    if (!custom) return false;
    for (const v of custom.values()) {
      if (typeof v !== 'object' || v === null) continue;
      for (const entry of Object.values(v as Record<string, unknown>)) {
        if (typeof entry === 'object' && entry !== null && (entry as { progress?: unknown }).progress === 30) {
          return true;
        }
      }
    }
    return false;
  });
  await page.locator('.tt-overlay').click(); // 关成员弹层（Esc 未接该弹层，overlay 点击关闭）

  // done 门禁：状态列选「已完成」→ 拦截 toast（两段式），状态保持待开始
  await mondayRow.locator('select[aria-label="任务状态"]').selectOption('done');
  await expect(page.getByTestId('toast')).toContainText('测试');
  await expect(page.getByTestId('toast')).toContainText('100%');
  await expect(mondayRow.locator('select[aria-label="任务状态"]')).toHaveValue('todo');

  // 进度补到 100% → 门禁放行 → 状态完成
  await mondayRow.getByTestId('table-custom-assignee').click();
  const progressFull = page.locator('[data-testid^="table-custom-assignee-editor-progress-"]');
  await progressFull.fill('100');
  await progressFull.press('Enter');
  await mondayRow.locator('select[aria-label="任务状态"]').selectOption('done');
  await expect(mondayRow.locator('select[aria-label="任务状态"]')).toHaveValue('done');
});

// 用例 6：节点上人员进度头像 + 点选盘快速更新（2026-10-11 第二步）——表格给叶子
// 节点分配成员 30% → 切回脑图 → 任务行出现圆形文字头像（data 锚点）+ 弧形进度环
// → 点击头像弹 9 档选盘 → 选 100% → docState 写回、头像环变整圆。
test('人员进度头像：节点展示圆形头像+进度环，点击弹选盘快速更新', async ({ page }) => {
  const phone = await openSeedDocTable(page, '本周计划');
  await addColumn(page, '测试', 'assignee');
  // 表格侧给「方案评审」（叶子）分配成员并设 30%（复用用例 5 的弹层操作）
  const row = page.locator('tr', { hasText: '方案评审' }).first();
  await row.getByTestId('table-custom-assignee').click();
  await page.locator('[data-testid^="table-custom-assignee-editor-member-"]').first().click();
  const progressInput = page.locator('[data-testid^="table-custom-assignee-editor-progress-"]');
  await progressInput.fill('30');
  await progressInput.press('Enter');
  await page.locator('.tt-overlay').click(); // 关弹层

  // 同时给该行设标准负责人（owner 列弹层选人）——画布 owner 头像有点击锚点
  await row.locator('td[data-col-key="owner"] .tt-owners-btn').click();
  await page.locator('.tt-popover .tt-chip').first().click();
  await page.locator('.tt-overlay').click(); // 关 owner 弹层

  // 切回脑图：节点任务行出现人员进度头像（圆形头像 + data 锚点 + 弧环）——
  // 未自定义头像的用户由宿主稳定分配预置 SVG（圆形 <image> 渲染）。
  await page.getByTestId('view-tab-mind').click();
  const avatar = page.locator('.editor-canvas svg g.gm-task-assignee');
  await expect(avatar).toBeVisible();
  await expect(avatar.getAttribute('data-assignee-user')).resolves.toMatch(/.+/);
  await expect(avatar.locator('path.gm-task-assignee-ring')).toBeVisible(); // 30% 弧
  await expect(avatar.locator('image.gm-task-avatar-img')).toHaveAttribute('href', /\/avatars\/preset-\d\.svg/);
  // 任务行右侧合成总进度：owner 0（w=1）+ 人员列 30（w=1）→ (0+30)/2 = 15%
  const nodeTaskProgress = page
    .locator('.editor-canvas svg g[data-node-id]')
    .filter({ has: page.locator('.gm-text', { hasText: '方案评审' }) })
    .locator('text.gm-task-progress');
  await expect(nodeTaskProgress).toHaveText('15%');
  // 有人员列时 owner 头像带弧形进度环（2026-10-12「整齐」裁定：环=owner 个人进度，默认 0 仅底环）
  const ownerAvatar = page.locator('.editor-canvas svg g.gm-task-owner-avatar');
  await expect(ownerAvatar).toBeVisible();
  await expect(ownerAvatar.getAttribute('data-owner-user')).resolves.toMatch(/.+/);
  await expect(ownerAvatar.locator('circle.gm-task-assignee-ring-bg')).toBeVisible(); // 0% 底环
  await expect(ownerAvatar.locator('.gm-task-assignee-ring')).toHaveCount(0); // 无进度弧（仅底环）

  // 点击人员头像 → 9 档选盘（头部展示人信息）→ 失焦消失 → 重开选 done（100%）
  await avatar.click();
  const picker = page.getByTestId('assignee-picker');
  await expect(picker).toBeVisible();
  // 弹盘头部展示（2026-10-13 需求方反馈改版）：所属列名 + 头像 + 昵称（「当前 x%」
  // 描述已去除——当前档位看网格内蓝环高亮）
  const who = page.getByTestId('assignee-picker-who');
  await expect(who.locator('img.assignee-picker-avatar')).toHaveAttribute(
    'src',
    /\/avatars\/preset-\d\.svg/,
  );
  await expect(who.locator('.marker-picker-label')).toHaveText('测试'); // 人员列名
  await expect(who).toContainText(`用户${phone.slice(-4)}`);
  // 30% 不落任何档位（选盘高亮仅精确在档时）——先验失焦关闭，再重开选 done
  await page.locator('.editor-canvas svg').click({ position: { x: 8, y: 8 } }); // 盘外 pointerdown
  await expect(picker).toHaveCount(0); // 失焦即消失（原版选盘同机制）
  await avatar.click();
  await expect(picker).toBeVisible(); // 重开（头像 toggle 正常）
  await page.getByTestId('assignee-picker-value-done').click();
  await expect(picker).toHaveCount(0);
  // 头像环变整圆（100%）；docState 写回 100
  await expect(avatar.locator('circle.gm-task-assignee-ring')).toBeVisible();
  await waitForDoc(page, (d) => {
    const id = findNodeByText(d, '方案评审');
    const custom = customOf(d, id);
    if (!custom) return false;
    for (const v of custom.values()) {
      if (typeof v !== 'object' || v === null) continue;
      for (const entry of Object.values(v as Record<string, unknown>)) {
        if (typeof entry === 'object' && entry !== null && (entry as { progress?: unknown }).progress === 100) {
          return true;
        }
      }
    }
    return false;
  });

  // 点负责人头像弹同款选盘（2026-10-12 裁定）：头部为负责人信息，选 75% 写回 task.progress
  await ownerAvatar.click();
  await expect(picker).toBeVisible();
  const whoOwner = page.getByTestId('assignee-picker-who');
  await expect(whoOwner.locator('.marker-picker-label')).toHaveText('负责人'); // 列名位显示「负责人」
  await expect(whoOwner).toContainText(`用户${phone.slice(-4)}`);
  await page.getByTestId('assignee-picker-value-p75').click();
  await expect(picker).toHaveCount(0);
  // owner 环变 75% 弧；docState task.progress=75（写回经 setNodeTask）
  await expect(ownerAvatar.locator('path.gm-task-assignee-ring')).toBeVisible();
  await waitForDoc(page, (d) => {
    const id = findNodeByText(d, '方案评审');
    const task = nodesMapOf(d).get(id)?.get('task') as Y.Map<unknown> | undefined;
    return task?.get('progress') === 75;
  });

  // 比重下拉（2026-10-12 裁定）：切回表格视图 → 勾「自定义比重」→ 每人行出现
  // 0.3~0.8 弱化档下拉 → 选 0.5 → docState 落 weight 0.5；合成总进度 =
  // (75×1 + 100×0.5)/(1+0.5) ≈ 83%
  await page.getByTestId('view-tab-table').click();
  await expect(page.locator('.task-table-root')).toBeVisible();
  await row.getByTestId('table-custom-assignee').click();
  const weightedToggle = page.getByTestId('table-custom-assignee-editor-weighted-toggle');
  await expect(weightedToggle).toBeVisible();
  await weightedToggle.locator('input').click();
  // 受控 checkbox 异步 setState：以「比重输入出现」为开关生效信号（不用 check 同步断言）
  await expect(page.locator('[data-testid^="table-custom-assignee-editor-weight-"]').first()).toBeVisible();
  await page.locator('.tt-overlay').click(); // 开关勾选即写列定义，关弹层
  await row.getByTestId('table-custom-assignee').click();
  const weightSelect = page.locator('[data-testid^="table-custom-assignee-editor-weight-"]');
  await expect(weightSelect).toBeVisible();
  await weightSelect.selectOption('0.5');
  await page.locator('.tt-overlay').click();
  await waitForDoc(page, (d) => {
    const id = findNodeByText(d, '方案评审');
    const custom = customOf(d, id);
    if (!custom) return false;
    for (const v of custom.values()) {
      if (typeof v !== 'object' || v === null) continue;
      for (const entry of Object.values(v as Record<string, unknown>)) {
        if (typeof entry === 'object' && entry !== null && (entry as { weight?: unknown }).weight === 0.5) {
          return true;
        }
      }
    }
    return false;
  });
});
