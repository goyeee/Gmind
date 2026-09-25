import { expect, test, type Page } from '@playwright/test';
import { buildXmind } from '@gmind/xmind-io';

/**
 * XMind 导入端到端（M4 Task 4，FR-IO-001/002）——工作台导入入口。
 *
 * 夹具在测试内用 @gmind/xmind-io 的 buildXmind 构造 .xmind bytes（web 测试进程能
 * import workspace 包，同 e2e 直接 import 依赖的先例）。复用 M0 登录模式：新手机号
 * 注册即赠 3 个种子文件，每用例独立用户、互不共享状态。
 * 覆盖：正常导入（新文件出现 + 层级/备注渲染）、25MB 超限（大小文案）、损坏文件（已损坏文案）。
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
