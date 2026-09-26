import { expect, test, type Page } from '@playwright/test';

/**
 * 三步新手引导 E2E — M5 Task 3（NFR-USE-001）。
 *
 * 复用 workspace.e2e.spec.ts 的注册登录模式（新手机号注册即赠 3 个种子文件，每用例
 * 独立用户、互不共享状态）。触发口径（M5 登记）：localStorage 缺 gmind.guide.done
 * 即触发（浏览器本地口径，跨设备不重复引导）。覆盖：三步走完（stepsDone=3，
 * skipped=false）/ 中途跳过（stepsDone=当前步，skipped=true）→ 均写 localStorage
 * 并 POST /api/events 上报 guide_finish（page.route 拦截校验 body）→ 刷新不再出现。
 */

/** POST /api/events 的 guide_finish 埋点 body 形状（其余事件不在此断言）。 */
type GuideEventBody = { type: string; payload: { stepsDone: number; skipped: boolean; elapsedMs: number } };

// 引导的触发口径是「localStorage 缺 gmind.guide.done」。playwright.config.ts 默认对
// 所有上下文预置该键（防引导模态阻塞既有用例）——本文件需要真正的首进用户，
// 以空 storageState 覆盖，从干净 localStorage 起测（finish 后应用写入的键不受影响，
// 刷新不再出现可如实断言）。
test.use({ storageState: { cookies: [], origins: [] } });

/** 注册并登录（UI 全流程），返回所用手机号。 */
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

/** 拦截 /api/events：收集 POST body 后放行（fire-and-forget，真实端点 204 即成功）。 */
async function collectEvents(page: Page): Promise<GuideEventBody[]> {
  const events: GuideEventBody[] = [];
  await page.route('**/api/events', (route) => {
    if (route.request().method() === 'POST') {
      events.push(route.request().postDataJSON() as GuideEventBody);
    }
    void route.continue();
  });
  return events;
}

test('新用户进入工作台出现引导，走完三步写 localStorage 并上报 guide_finish', async ({ page }) => {
  const events = await collectEvents(page);
  await registerAndLogin(page);

  // 三步依次出现（文案锚定步骤语义），下一步推进
  await expect(page.getByTestId('guide-overlay')).toBeVisible();
  await expect(page.getByTestId('guide-step-1')).toContainText('创建你的第一份脑图');
  await page.getByTestId('guide-next').click();
  await expect(page.getByTestId('guide-step-2')).toContainText('添加节点组织思路');
  await page.getByTestId('guide-next').click();
  await expect(page.getByTestId('guide-step-3')).toContainText('邀请伙伴协作');
  await page.getByTestId('guide-next').click();

  // 结束：浮层消失 + localStorage 置位 + 埋点恰一条（stepsDone=3 / skipped=false）
  await expect(page.getByTestId('guide-overlay')).toHaveCount(0);
  await expect
    .poll(() => page.evaluate(() => localStorage.getItem('gmind.guide.done')))
    .toBe('1');
  await expect.poll(() => events.length).toBe(1);
  expect(events[0]).toMatchObject({ type: 'guide_finish', payload: { stepsDone: 3, skipped: false } });
  expect(typeof events[0].payload.elapsedMs).toBe('number');

  // 刷新不再出现
  await page.reload();
  await expect(page.locator('.file-list li')).toHaveCount(3);
  await expect(page.getByTestId('guide-overlay')).toHaveCount(0);
});

test('中途跳过：立即结束并上报 skipped=true（stepsDone=当前步），刷新不再出现', async ({ page }) => {
  const events = await collectEvents(page);
  await registerAndLogin(page);

  await expect(page.getByTestId('guide-overlay')).toBeVisible();
  await page.getByTestId('guide-next').click();
  await expect(page.getByTestId('guide-step-2')).toBeVisible();
  await page.getByTestId('guide-skip').click();

  await expect(page.getByTestId('guide-overlay')).toHaveCount(0);
  await expect
    .poll(() => page.evaluate(() => localStorage.getItem('gmind.guide.done')))
    .toBe('1');
  await expect.poll(() => events.length).toBe(1);
  expect(events[0]).toMatchObject({ type: 'guide_finish', payload: { stepsDone: 2, skipped: true } });

  await page.reload();
  await expect(page.getByTestId('guide-overlay')).toHaveCount(0);
});
