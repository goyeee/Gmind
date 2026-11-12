import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import type { INestApplication } from '@nestjs/common';
import { createTemplateDoc, docToState, getNode, setNodeTask } from '@gmind/core';

/**
 * 跨文件待办（/api/todos，第二期批次 B）e2e：
 * - 索引抽取：PUT doc-state（带任务节点）后 task_index 出现，GET /todos 可见；
 * - 范围口径：负责人含我 + 文件可见（owner/协作者）——无权限者不可见；
 * - 统计卡口径：today/overdue/week/done；
 * - PATCH 直改：进度写回 docState（GET content 验证）且索引同步；
 * - remind：站内通知落库；提醒自己 409。
 */
describe('跨文件待办（/api/todos）', () => {
  let app: INestApplication;
  let adminToken: string;
  let adminId: string;
  let memberToken: string;
  let memberId: string;
  let fileId: string;
  let taskANodeId: string;
  let taskBNodeId: string;

  const authed = (token: string, method: 'get' | 'post' | 'patch' | 'put', url: string) =>
    request(app.getHttpServer())
      [method](url)
      .set('Authorization', `Bearer ${token}`);

  const login = async (phone: string): Promise<{ token: string; id: string }> => {
    const res = await request(app.getHttpServer())
      .post('/api/auth/login')
      .send({ method: 'phone', phone, code: '123456' });
    const body = res.body as { token: string; user: { id: string } };
    return { token: body.token, id: body.user.id };
  };

  beforeAll(async () => {
    const { createTestApp } = await import('./support/app-test');
    app = await createTestApp();
    const admin = await login('13800001111');
    adminToken = admin.token;
    adminId = admin.id;
    const member = await login('13800002222');
    memberToken = member.token;
    memberId = member.id;

    // 造带任务的文件：admin 建 → 两个任务节点（A 负责人=member 今日到期；B 负责人=admin 已完成）
    const today = new Date().toISOString().slice(0, 10);
    const yesterday = new Date(Date.now() - 86400_000).toISOString().slice(0, 10);
    const doc = createTemplateDoc({ title: '任务文件', children: [{ text: '任务A' }, { text: '任务B' }] });
    const kids = getNode(doc, 'root')!.childIds;
    taskANodeId = kids[0]!;
    taskBNodeId = kids[1]!;
    setNodeTask(doc, taskANodeId, { owners: [memberId], dueDate: today, status: 'doing', progress: 40 });
    // done 闸门：进度须先 100（core TASK_DONE_GATE_BLOCKED），两步走
    setNodeTask(doc, taskBNodeId, { owners: [adminId], dueDate: yesterday, progress: 100 });
    setNodeTask(doc, taskBNodeId, { status: 'done' });

    const created = await authed(adminToken, 'post', '/api/files').send({ title: '任务文件' });
    fileId = (created.body as { id: string }).id;
    // member 加为协作者（可见性口径）
    await authed(adminToken, 'post', `/api/files/${fileId}/collaborators`).send({ userIds: [memberId] });
    // PUT doc-state（触发索引抽取；抽取为异步 fire-and-forget，断言统一轮询等待）
    const state = Buffer.from(docToState(doc)).toString('base64');
    const put = await authed(adminToken, 'put', `/api/files/${fileId}/doc-state`).send({ docState: state });
    expect(put.status).toBe(200);
  });

  afterAll(async () => {
    await app.close();
  });

  it('索引抽取+范围口径：member 只见自己负责的任务A；admin 只见任务B', async () => {
    // 抽取是异步的——轮询至出现（上限 ~3s）
    let memberPage: { stats: { all: number }; items: Array<{ text: string }> } | null = null;
    for (let i = 0; i < 30; i++) {
      const res = await authed(memberToken, 'get', '/api/todos');
      expect(res.status).toBe(200);
      memberPage = res.body as never;
      if (memberPage.items.length > 0) break;
      await new Promise((r) => setTimeout(r, 100));
    }
    expect(memberPage!.stats.all).toBe(1);
    expect(memberPage!.items[0]?.text).toBe('任务A');
    expect(memberPage!.items[0]?.status).toBe('doing');

    const adminPage = (await (await authed(adminToken, 'get', '/api/todos?tab=done')).body) as {
      stats: { done: number; overdue: number };
      items: Array<{ text: string }>;
    };
    expect(adminPage.stats.done).toBe(1);
    expect(adminPage.items[0]?.text).toBe('任务B');
  });

  it('统计卡口径：member 的 today=1（任务A 今日到期）；越权者空', async () => {
    const page = (await (await authed(memberToken, 'get', '/api/todos')).body) as {
      stats: { all: number; today: number; overdue: number; week: number; done: number };
    };
    expect(page.stats).toEqual({ all: 1, today: 1, overdue: 0, week: 1, done: 0 });
    // 第三人（无该文件权限）：即便把自己设为负责人也不可见——此处验证新号空表
    const outsider = await login('13800003333');
    const page3 = (await (await authed(outsider.token, 'get', '/api/todos')).body) as { stats: { all: number } };
    expect(page3.stats.all).toBe(0);
  });

  it('PATCH 直改：进度写回 docState 且索引同步', async () => {
    const patch = await authed(memberToken, 'patch', `/api/todos/${fileId}/${taskANodeId}`).send({ progress: 80 });
    expect(patch.status).toBe(200);
    // 索引同步（异步重建，轮询）
    let progress = 0;
    for (let i = 0; i < 30; i++) {
      const page = (await (await authed(memberToken, 'get', '/api/todos')).body) as {
        items: Array<{ progress: number }>;
      };
      progress = page.items[0]?.progress ?? 0;
      if (progress === 80) break;
      await new Promise((r) => setTimeout(r, 100));
    }
    expect(progress).toBe(80);
    // docState 写回验证：admin 拉内容解析任务进度
    const content = await authed(adminToken, 'get', `/api/files/${fileId}`);
    expect(content.status).toBe(200);
    const stateB64 = (content.body as { docState: string }).docState;
    const { docFromState } = await import('@gmind/core');
    const doc = docFromState(new Uint8Array(Buffer.from(stateB64, 'base64')));
    expect(getNode(doc, taskANodeId)?.task.progress).toBe(80);
  });

  it('完成勾选：done=true → 状态 done，open 列表消失、done 列表出现', async () => {
    const patch = await authed(memberToken, 'patch', `/api/todos/${fileId}/${taskANodeId}`).send({ done: true });
    expect(patch.status).toBe(200);
    let openCount = 1;
    let doneCount = 0;
    for (let i = 0; i < 30; i++) {
      const open = (await (await authed(memberToken, 'get', '/api/todos?tab=open')).body) as { items: unknown[] };
      const done = (await (await authed(memberToken, 'get', '/api/todos?tab=done')).body) as { items: unknown[] };
      openCount = open.items.length;
      doneCount = done.items.length;
      if (openCount === 0 && doneCount === 1) break;
      await new Promise((r) => setTimeout(r, 100));
    }
    expect(openCount).toBe(0);
    expect(doneCount).toBe(1);
  });

  it('remind：提醒负责人 → 站内通知落库；提醒自己 409', async () => {
    const res = await authed(memberToken, 'post', '/api/todos/remind').send({
      fileId,
      nodeId: taskBNodeId,
      ownerUserId: adminId,
    });
    expect(res.status).toBe(200);
    const notifications = await authed(adminToken, 'get', '/api/notifications');
    const items = (notifications.body as Array<{ type: string; payload: { commenterName?: string } | null }>) ?? [];
    const reminder = items.find((n) => n.payload?.commenterName?.includes('提醒你跟进'));
    expect(reminder).toBeDefined();

    const self = await authed(adminToken, 'post', '/api/todos/remind').send({
      fileId,
      nodeId: taskBNodeId,
      ownerUserId: adminId,
    });
    expect(self.status).toBe(409);
  });
});
