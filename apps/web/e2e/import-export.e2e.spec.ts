import * as fs from 'node:fs';
import { expect, test, type Page } from '@playwright/test';
import { buildXmind, parseXmind, type XmindNode } from '@gmind/xmind-io';

/**
 * XMind 导入端到端（M4 Task 4，FR-IO-001/002）——工作台导入入口。
 *
 * 夹具在测试内用 @gmind/xmind-io 的 buildXmind 构造 .xmind bytes（web 测试进程能
 * import workspace 包，同 e2e 直接 import 依赖的先例）。复用 M0 登录模式：新手机号
 * 注册即赠 3 个种子文件，每用例独立用户、互不共享状态。
 * 覆盖：正常导入（新文件出现 + 层级/备注渲染）、25MB 超限（大小文案）、损坏文件（已损坏文案）、
 * 导出往返（M4 Task 5：导出菜单下载 .xmind → xmind-io 解析断言 → 下载产物回灌导入）。
 */

/** 夹具树：root「项目根主题」+ 两级子树，分支A 带备注（层级/备注渲染的断言依据）。
 *  文件名「项目.xmind」与 root 标题共同满足列表行 hasText「项目」的契约。 */
const FIXTURE_TREE = {
  title: '项目根主题',
  children: [
    { title: '分支A', note: '分支A的备注', children: [{ title: '孙1', children: [] }] },
    { title: '分支B', children: [] },
  ],
};

async function registerAndLogin(page: Page): Promise<void> {
  await page.goto('/login');
  const phone = '138' + String(Math.floor(10000000 + Math.random() * 89999999));
  await page.getByPlaceholder('手机号').fill(phone);
  await page.getByPlaceholder('验证码（开发环境固定 123456）').fill('123456');
  await page.getByRole('button', { name: '登录', exact: true }).click();
  await expect(page).toHaveURL(/\/workspace/);
  await expect(page.locator('.file-list li')).toHaveCount(3);
}

test('工作台导入 .xmind：新文件出现且层级/备注正确渲染', async ({ page }) => {
  await registerAndLogin(page);
  await page.getByTestId('import-button').click();
  await page.getByTestId('import-input').setInputFiles({
    name: '项目.xmind',
    mimeType: 'application/octet-stream',
    // setInputFiles 的 buffer 契约为 Buffer（buildXmind 产物是 Uint8Array，需包一层）
    buffer: Buffer.from(buildXmind(FIXTURE_TREE)),
  });
  // 新文件出现在列表（标题 = 根主题「项目根主题」，命中「项目」）
  await expect(page.locator('.file-list li', { hasText: '项目' })).toBeVisible();
  await page.locator('.file-list li', { hasText: '项目' }).click();
  await expect(page).toHaveURL(/\/edit\//);
  // 层级渲染：root 与两级子节点；备注以角标呈现（分支A 持有唯一的 note 角标）
  await expect(page.locator('.editor-canvas svg .gm-text', { hasText: '根主题' })).toBeVisible();
  await expect(page.locator('.editor-canvas svg .gm-text', { hasText: '分支A' })).toBeVisible();
  await expect(page.locator('.editor-canvas svg .gm-text', { hasText: '孙1' })).toBeVisible();
  await expect(page.locator('.editor-canvas svg .gm-note-badge')).toHaveCount(1);
});

test('导入 25MB 超限：提示大小上限；损坏文件：提示已损坏', async ({ page }) => {
  await registerAndLogin(page);
  // 超限 buffer 用恒定填充（大小检查先于解析，垃圾内容不会进入解析器）
  await page.getByTestId('import-button').click();
  await page.getByTestId('import-input').setInputFiles({
    name: '超大.xmind',
    mimeType: 'application/octet-stream',
    buffer: Buffer.alloc(21 * 1024 * 1024, 0),
  });
  await expect(page.getByTestId('toast')).toHaveText('文件大小超过 20MB 上限');

  // 损坏文件（< 20MB 乱字节，非 zip）：归因「文件已损坏，无法解析」且不产生新文件
  await page.getByTestId('import-button').click();
  await page.getByTestId('import-input').setInputFiles({
    name: '损坏.xmind',
    mimeType: 'application/octet-stream',
    buffer: Buffer.alloc(1024, 0x07),
  });
  await expect(page.getByTestId('toast')).toHaveText('文件已损坏，无法解析');
  await expect(page.locator('.file-list li')).toHaveCount(3);
});

/** 先序查找 title 命中的节点（导出往返断言辅助）。 */
function findTitle(node: XmindNode, title: string): XmindNode | null {
  if (node.title === title) return node;
  for (const child of node.children) {
    const hit = findTitle(child, title);
    if (hit) return hit;
  }
  return null;
}

/** 打开种子文件「本周计划」并给「周一」写备注「评审要点」（复用富内容面板 UI 流，
 *  同 rich-content.e2e.spec.ts 的既定模式）。角标可见即备注已入本地 doc——导出读
 *  本地 doc，无需等网络落库。 */
async function openSeedDocWithNote(page: Page): Promise<void> {
  await registerAndLogin(page);
  await page.locator('.file-list li', { hasText: '本周计划' }).click();
  await expect(page).toHaveURL(/\/edit\//);
  await expect(page.locator('.editor-canvas svg .gm-text', { hasText: '本周计划' })).toBeVisible();
  await page.locator('.editor-canvas svg .gm-text', { hasText: '周一' }).click();
  const panel = page.getByTestId('rich-panel');
  await expect(panel).toBeVisible();
  await panel.getByLabel('节点备注').fill('评审要点');
  await panel.getByRole('button', { name: '保存备注' }).click();
  await expect(
    page.locator('.editor-canvas svg g[data-node-id]', { hasText: '周一' }).locator('.gm-note-badge'),
  ).toBeVisible();
}

// 用例 3（M4 Task 5，FR-IO-004 一期 XMind 部分）：导出菜单 → 下载 .xmind →
// xmind-io 直接解析断言层级/文本/备注 → 下载产物回灌工作台导入，新文件出现且渲染一致。
test('导出 XMind 并往返导入：层级/文本/备注一致', async ({ page }) => {
  await openSeedDocWithNote(page);
  // 工具栏「导出」按钮点开下拉（Task 9 前仅 XMind 一项），点击触发下载
  await page.getByTestId('export-menu').click();
  const [download] = await Promise.all([
    page.waitForEvent('download'),
    page.getByTestId('export-xmind').click(),
  ]);
  // 下载名 = 编辑器标题（header 与 getMeta(doc).title 同源）+ .xmind
  expect(download.suggestedFilename()).toBe('本周计划.xmind');
  const path = await download.path();
  const bytes = new Uint8Array(await fs.promises.readFile(path));
  // 导出产物直接用 @gmind/xmind-io 断言结构（root=本周计划、层级完整、周一持备注）
  const parsed = parseXmind(bytes);
  expect(parsed.root.title).toBe('本周计划');
  expect(parsed.root.children.map((c) => c.title)).toEqual(['周一', '周三', '周五']);
  const monday = findTitle(parsed.root, '周一');
  expect(monday?.note).toBe('评审要点');
  expect(monday?.children.map((c) => c.title)).toEqual(['周会对齐']);
  expect(parsed.degraded).toEqual([]);

  // 往返：下载产物 setInputFiles 回灌导入 → 新文件出现（4 行 = 3 种子 + 导入件，
  // 新件 updated_at 最新置顶）
  await page.goto('/workspace');
  await page.getByTestId('import-button').click();
  await page.getByTestId('import-input').setInputFiles({
    name: '本周计划.xmind',
    mimeType: 'application/octet-stream',
    buffer: Buffer.from(bytes),
  });
  await expect(page.locator('.file-list li')).toHaveCount(4);
  await page.locator('.file-list li').first().click();
  await expect(page).toHaveURL(/\/edit\//);
  // 导入件渲染一致：层级（root/周一/周会对齐）与备注角标（恰 1 个）
  await expect(page.locator('.editor-canvas svg .gm-text', { hasText: '本周计划' })).toBeVisible();
  await expect(page.locator('.editor-canvas svg .gm-text', { hasText: '周一' })).toBeVisible();
  await expect(page.locator('.editor-canvas svg .gm-text', { hasText: '周会对齐' })).toBeVisible();
  await expect(page.locator('.editor-canvas svg .gm-note-badge')).toHaveCount(1);
});
