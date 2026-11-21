import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import type { INestApplication } from '@nestjs/common';
import { DataSource } from 'typeorm';
import {
  addAssignee,
  addCanvas,
  addChild,
  createTemplateDoc,
  docFromState,
  docToState,
  getNode,
  ORIGIN_USER,
  rootIdOf,
  setCustomColumns,
  setNodeTask,
  setAssigneeProgress,
  setOwnerProgress,
} from '@gmind/core';
import { createAccount, type TestAccount } from './support/auth-test';

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

  beforeAll(async () => {
    const { createTestApp } = await import('./support/app-test');
    app = await createTestApp();
    const admin: TestAccount = await createAccount(app);
    adminToken = admin.token;
    adminId = admin.id;
    const member: TestAccount = await createAccount(app);
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
      if (memberPage.stats.all > 0) break; // 轮询统计而非 items：stats/items 分连接查询，重建提交恰落中间会踩竞态
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
    const outsider = await createAccount(app);
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

  it('重开必须带明确新进度：缺省 400；done=false+40% 后恢复 doing/40', async () => {
    const missing = await authed(memberToken, 'patch', `/api/todos/${fileId}/${taskANodeId}`).send({ done: false });
    expect(missing.status).toBe(400);
    expect(missing.body.message).toContain('选择 0～99% 的新进度');
    const patch = await authed(memberToken, 'patch', `/api/todos/${fileId}/${taskANodeId}`).send({ done: false, progress: 40 });
    expect(patch.status).toBe(200);
    const content = await authed(adminToken, 'get', `/api/files/${fileId}`);
    expect(content.status, JSON.stringify(content.body)).toBe(200);
    expect(content.body).toHaveProperty('docState');
    const { docFromState } = await import('@gmind/core');
    const doc = docFromState(new Uint8Array(Buffer.from((content.body as { docState: string }).docState, 'base64')));
    expect(getNode(doc, taskANodeId)?.task).toMatchObject({ status: 'doing', progress: 40 });
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

/**
 * 任务第二轮（2026-11-21，spec 2026-11-21-task-round2-design）e2e：
 * - 全画布覆盖：第二画布任务入索引且行内带 canvas；
 * - 参与人落表与圈范围：人员列条目入 task_participant，纯参与节点可见且不重复；
 * - 派生口径：自动父索引进度=直属真正任务均值；blocked 透传；
 * - myRole/双身份/mySubProgress（多列同人取最高）与 PATCH mySubProgress 全来源写入；
 * - report 负责人/参与人拆计数（同人同任务只进一处）；
 * - 旧口径行（canvas_id IS NULL）经 rebuildIfStaleInBackground 装载兜底重建。
 */
describe('跨文件待办第二轮（参与人/画布/派生口径）', () => {
  let app: INestApplication;
  let adminToken: string;
  let adminId: string;
  let memberToken: string;
  let memberId: string;
  let fileId: string;
  let taskAId: string; // owner=member，负责人+admin 参与（30）
  let taskCId: string; // 纯参与节点：member 50、admin 70，无负责人
  let autoPId: string; // 自动父：C1 40 / C2 80 → 派生 60
  let taskDId: string; // 第二画布：owner=member，两列同人条目 20/60
  let dataSource: DataSource;

  const authed = (token: string, method: 'get' | 'post' | 'patch' | 'put', url: string) =>
    request(app.getHttpServer())
      [method](url)
      .set('Authorization', `Bearer ${token}`);

  /** 轮询直至条件成立（索引/参与人重建是异步 fire-and-forget）。 */
  async function pollUntil(probe: () => Promise<boolean>, label: string): Promise<void> {
    for (let i = 0; i < 100; i++) {
      if (await probe()) return;
      await new Promise((r) => setTimeout(r, 100));
    }
    throw new Error(`轮询超时：${label}`);
  }

  beforeAll(async () => {
    const { createTestApp } = await import('./support/app-test');
    app = await createTestApp();
    dataSource = app.get(DataSource);
    const admin: TestAccount = await createAccount(app);
    adminToken = admin.token;
    adminId = admin.id;
    const member: TestAccount = await createAccount(app);
    memberToken = member.token;
    memberId = member.id;

    const doc = createTemplateDoc({ title: '二轮文件', children: [{ text: '任务A' }, { text: '自动父' }] });
    const kids = getNode(doc, 'root')!.childIds;
    taskAId = kids[0]!;
    autoPId = kids[1]!;
    setNodeTask(doc, taskAId, { owners: [memberId], dueDate: new Date().toISOString().slice(0, 10), status: 'doing', progress: 40 });
    setCustomColumns(doc, [
      { id: 'col-a', name: '执行组', type: 'assignee' },
      { id: 'col-b', name: '复核组', type: 'assignee' },
    ]);
    // 任务A：负责人=member，admin 参与（参与人行的 myRole='participant' 数据源）
    addAssignee(doc, taskAId, 'col-a', adminId);
    setAssigneeProgress(doc, taskAId, 'col-a', adminId, 30);
    // 自动父：autoProgress 开关 + 两个直属真正任务子级（40/80）→ 派生均值 60
    setNodeTask(doc, autoPId, { owners: [adminId], autoProgress: true, progress: 40 });
    const c1 = addChild(doc, autoPId, { text: '子任务1' });
    const c2 = addChild(doc, autoPId, { text: '子任务2' });
    setNodeTask(doc, c1, { owners: [adminId], status: 'doing', progress: 40 });
    setNodeTask(doc, c2, { owners: [adminId], status: 'doing', progress: 80 });
    // 纯参与节点（无负责人）：member 50 / admin 70 —— isExplicitTask 放宽后入索引
    const c0 = addChild(doc, 'root', { text: '纯参与' });
    taskCId = c0;
    addAssignee(doc, c0, 'col-a', memberId);
    setAssigneeProgress(doc, c0, 'col-a', memberId, 50);
    addAssignee(doc, c0, 'col-a', adminId);
    setAssigneeProgress(doc, c0, 'col-a', adminId, 70);
    // 第二画布：双身份任务（owner=member 且两列同人条目 20/60）
    const canvas2 = addCanvas(doc, { name: '画布二' });
    const d = addChild(doc, rootIdOf(doc, canvas2), { text: '画布二任务' }, ORIGIN_USER, canvas2);
    taskDId = d;
    setNodeTask(doc, d, { owners: [memberId] }, ORIGIN_USER, canvas2);
    addAssignee(doc, d, 'col-a', memberId, ORIGIN_USER, canvas2);
    setAssigneeProgress(doc, d, 'col-a', memberId, 20, ORIGIN_USER, canvas2);
    addAssignee(doc, d, 'col-b', memberId, ORIGIN_USER, canvas2);
    setAssigneeProgress(doc, d, 'col-b', memberId, 60, ORIGIN_USER, canvas2);

    const created = await authed(adminToken, 'post', '/api/files').send({ title: '二轮文件' });
    fileId = (created.body as { id: string }).id;
    await authed(adminToken, 'post', `/api/files/${fileId}/collaborators`).send({ userIds: [memberId] });
    const state = Buffer.from(docToState(doc)).toString('base64');
    const put = await authed(adminToken, 'put', `/api/files/${fileId}/doc-state`).send({ docState: state });
    expect(put.status).toBe(200);
    await pollUntil(async () => {
      const rows = (await dataSource.query('SELECT COUNT(*) AS n FROM task_participant WHERE file_id = ?', [fileId])) as Array<{ n: number }>;
      return Number(rows[0]?.n ?? 0) >= 5; // A:1 + C:2 + D:2（两列同人）
    }, '参与人落表');
  });

  afterAll(async () => {
    await app.close();
  });

  it('全画布覆盖+参与人圈范围：member 见 3 行（含第二画布/纯参与），canvas 字段齐', async () => {
    const page = (await (await authed(memberToken, 'get', '/api/todos')).body) as {
      stats: { all: number };
      items: Array<{ text: string; canvasId: string | null; canvasName: string | null; myRole: string; mySubProgress: number | null; participants: string[]; owners: string[]; status: string }>;
    };
    expect(page.stats.all).toBe(3); // 任务A + 纯参与 + 画布二任务（自动父 owner=admin 不在 member 范围）
    const a = page.items.find((t) => t.text === '任务A')!;
    expect(a).toMatchObject({ myRole: 'owner', canvasName: '画布 1' });
    expect(a.participants).toEqual([adminId]);
    const c = page.items.find((t) => t.text === '纯参与')!;
    expect(c).toMatchObject({ myRole: 'participant', mySubProgress: 50, owners: [] });
    const d = page.items.find((t) => t.text === '画布二任务')!;
    expect(d).toMatchObject({ canvasName: '画布二', myRole: 'both', mySubProgress: 60 }); // 多列同人取最高 60
    expect(d.canvasId).not.toBeNull();
  });

  it('派生口径：自动父索引进度=直属真正任务均值 60，status doing', async () => {
    const page = (await (await authed(adminToken, 'get', '/api/todos')).body) as {
      stats: { all: number };
      items: Array<{ text: string; progress: number; status: string; myRole: string; mySubProgress: number | null }>;
    };
    expect(page.stats.all).toBe(5); // 自动父+子任务1+子任务2(owner=admin) + 任务A(admin 参与 30) + 纯参与(admin 参与 70)
    const p = page.items.find((t) => t.text === '自动父')!;
    expect(p).toMatchObject({ progress: 60, status: 'doing', myRole: 'owner' });
    const a = page.items.find((t) => t.text === '任务A')!;
    expect(a).toMatchObject({ myRole: 'participant', mySubProgress: 30 }); // admin 在任务A的人员列 30
  });

  it('task_participant 落表：同节点多列同人各一行，负责人不入参与人表', async () => {
    const rows = (await dataSource.query(
      'SELECT node_id, user_id, col_id, progress FROM task_participant WHERE file_id = ? ORDER BY node_id, col_id',
      [fileId],
    )) as Array<{ node_id: string; user_id: string; col_id: string; progress: number }>;
    const dRows = rows.filter((r) => r.node_id === taskDId);
    expect(dRows).toHaveLength(2);
    expect(dRows.map((r) => r.col_id).sort()).toEqual(['col-a', 'col-b']);
    expect(dRows.every((r) => r.user_id === memberId)).toBe(true);
    // 自动父负责人=admin：ownerProgress 未设置 → owner_progress NULL
    const idx = (await dataSource.query(
      'SELECT owner_progress, progress, status FROM task_index WHERE file_id = ? AND node_id = ?',
      [fileId, autoPId],
    )) as Array<{ owner_progress: number | null; progress: number; status: string }>;
    expect(idx[0]).toMatchObject({ owner_progress: null, progress: 60, status: 'doing' });
  });

  it('PATCH mySubProgress：全部执行来源一起改（两列条目+ownerProgress 同值）', async () => {
    const patch = await authed(memberToken, 'patch', `/api/todos/${fileId}/${taskDId}`).send({ mySubProgress: 88 });
    expect(patch.status).toBe(200);
    await pollUntil(async () => {
      const rows = (await dataSource.query(
        'SELECT progress FROM task_participant WHERE file_id = ? AND node_id = ? AND user_id = ?',
        [fileId, taskDId, memberId],
      )) as Array<{ progress: number }>;
      return rows.length === 2 && rows.every((r) => r.progress === 88);
    }, 'mySubProgress 两列写入');
    const idx = (await dataSource.query(
      'SELECT owner_progress FROM task_index WHERE file_id = ? AND node_id = ?',
      [fileId, taskDId],
    )) as Array<{ owner_progress: number | null }>;
    expect(idx[0]?.owner_progress).toBe(88);
    const page = (await (await authed(memberToken, 'get', '/api/todos')).body) as {
      items: Array<{ text: string; mySubProgress: number | null }>;
    };
    expect(page.items.find((t) => t.text === '画布二任务')?.mySubProgress).toBe(88);
  });

  it('PATCH mySubProgress：参与人单独写自己的条目；非成员 400 两段式', async () => {
    const ok = await authed(adminToken, 'patch', `/api/todos/${fileId}/${taskCId}`).send({ mySubProgress: 90 });
    expect(ok.status).toBe(200);
    await pollUntil(async () => {
      const rows = (await dataSource.query(
        'SELECT progress FROM task_participant WHERE file_id = ? AND node_id = ? AND user_id = ?',
        [fileId, taskCId, adminId],
      )) as Array<{ progress: number }>;
      return rows.length === 1 && rows[0]!.progress === 90;
    }, '参与人写入');

    // 无权限者 404（不泄露存在性）；有 editor 权限但与任务无关者 400 两段式
    const outsider = await createAccount(app);
    const noAccess = await authed(outsider.token, 'patch', `/api/todos/${fileId}/${taskAId}`).send({ mySubProgress: 50 });
    expect(noAccess.status).toBe(404);
    const bystander = await createAccount(app);
    await authed(adminToken, 'post', `/api/files/${fileId}/collaborators`).send({ userIds: [bystander.id] });
    const denied = await authed(bystander.token, 'patch', `/api/todos/${fileId}/${taskAId}`).send({ mySubProgress: 50 });
    expect(denied.status).toBe(400);
    expect(denied.body.message).toContain('不是这个任务的负责人或执行人');

    const mixed = await authed(memberToken, 'patch', `/api/todos/${fileId}/${taskAId}`).send({ mySubProgress: 50, progress: 60 });
    expect(mixed.status).toBe(400);
  });

  it('report 拆计数：responsible/participating 同人同任务只进一处，合计=total', async () => {
    const report = (await (await authed(adminToken, 'get', '/api/todos/report?range=all')).body) as {
      stats: { total: number };
      byOwner: Array<{ key: string; total: number; responsible: number; participating: number }>;
    };
    // admin 视角可见文件=该文件全部 6 任务（A/P/C1/C2/C/画布二任务）——stats 按任务级
    expect(report.stats.total).toBe(6);
    const adminRow = report.byOwner.find((r) => r.key === adminId)!;
    // admin：负责 P/C1/C2 = 3；参与 A/C = 2；同人同任务无重复 → total 5
    expect(adminRow).toMatchObject({ total: 5, responsible: 3, participating: 2 });
    const memberRow = report.byOwner.find((r) => r.key === memberId)!;
    // member：负责 A/D = 2；参与 C = 1
    expect(memberRow).toMatchObject({ total: 3, responsible: 2, participating: 1 });
  });

  it('旧口径行兜底：canvas_id 置 NULL 后 rebuildIfStaleInBackground 重建补齐', async () => {
    await dataSource.query('UPDATE task_index SET canvas_id = NULL, canvas_name = NULL WHERE file_id = ?', [fileId]);
    const { TaskIndexService } = await import('../src/todos/task-index.service');
    const svc = app.get(TaskIndexService);
    const content = await authed(adminToken, 'get', `/api/files/${fileId}`);
    const doc = docFromState(new Uint8Array(Buffer.from((content.body as { docState: string }).docState, 'base64')));
    await svc.rebuildIfStaleInBackground(fileId, doc);
    await pollUntil(async () => {
      const rows = (await dataSource.query(
        'SELECT COUNT(*) AS n FROM task_index WHERE file_id = ? AND canvas_id IS NULL',
        [fileId],
      )) as Array<{ n: number }>;
      return Number(rows[0]?.n ?? 0) === 0;
    }, '旧口径行重建');
    const d = (await dataSource.query(
      'SELECT canvas_name, owner_progress FROM task_index WHERE file_id = ? AND node_id = ?',
      [fileId, taskDId],
    )) as Array<{ canvas_name: string; owner_progress: number | null }>;
    expect(d[0]).toMatchObject({ canvas_name: '画布二', owner_progress: 88 });
  });

  it('activity 范围（评审 P1-2）：相关人可见、文件可见但无关者不可见、无权限者空；limit 收拢与坏 payload 防御', async () => {
    // 直记一条 admin 的子进度事件（related=[admin, member]）
    const ok = await authed(adminToken, 'patch', `/api/todos/${fileId}/${taskCId}`).send({ mySubProgress: 77 });
    expect(ok.status).toBe(200);
    await pollUntil(async () => {
      const rows = (await dataSource.query(
        "SELECT COUNT(*) AS n FROM events WHERE file_id = ? AND type = ? AND payload LIKE '%77%'",
        [fileId, 'task_progress'],
      )) as Array<{ n: number }>;
      return Number(rows[0]?.n ?? 0) > 0;
    }, '事件落库');

    // 相关人（member 在 related）可见
    const memberPage = (await (await authed(memberToken, 'get', '/api/todos/activity?limit=100')).body) as {
      items: Array<{ type: string; payload: { sub?: { after: number } } | null }>;
    };
    const hit = memberPage.items.find((i) => i.payload?.sub?.after === 77);
    expect(hit).toBeDefined();

    // 文件可见但与任务无关的协作者（非 actor 非 related）不可见该事件
    const bystander = await createAccount(app);
    await authed(adminToken, 'post', `/api/files/${fileId}/collaborators`).send({ userIds: [bystander.id] });
    const bPage = (await (await authed(bystander.token, 'get', '/api/todos/activity?limit=100')).body) as {
      items: Array<{ payload: { sub?: { after: number } } | null }>;
    };
    expect(bPage.items.find((i) => i.payload?.sub?.after === 77)).toBeUndefined();

    // 无文件权限者动态流为空（他人任务事件不可见）
    const stranger = await createAccount(app);
    const outsiderPage = (await (await authed(stranger.token, 'get', '/api/todos/activity?limit=100')).body) as { items: unknown[] };
    expect(outsiderPage.items).toHaveLength(0);

    // limit 收拢：非法值取缺省 50、合法值生效
    const clamped = (await (await authed(memberToken, 'get', '/api/todos/activity?limit=abc')).body) as { items: unknown[] };
    expect(clamped.items.length).toBeLessThanOrEqual(50);
    const two = (await (await authed(memberToken, 'get', '/api/todos/activity?limit=2')).body) as { items: unknown[] };
    expect(two.items.length).toBeLessThanOrEqual(2);

    // 损坏 payload 行防御（操作者=member 使其在范围内）：不炸动态流、payload 还原为 null
    await dataSource.query(
      "INSERT INTO events (id, type, file_id, user_id, payload, created_at) VALUES (?, 'task_progress', ?, ?, 'not-json', NOW(3))",
      ['01M7X8ZZZZZZZZZZZZZZZZZZZZ', fileId, memberId],
    );
    const after = (await (await authed(memberToken, 'get', '/api/todos/activity?limit=100')).body) as {
      items: Array<{ payload: unknown }>;
    };
    expect(after.items.find((i) => i.payload === null)).toBeDefined();
  });

  it('参与范围配置（2026-11-21 追加）：GET 清单、画布级/文件级排除生效于 page/report/activity、幂等、恢复', async () => {
    // GET：可见文件在列、画布清单含两个画布、默认未排除
    const scope0 = (await (await authed(memberToken, 'get', '/api/todos/scope')).body) as {
      files: Array<{ fileId: string; title: string; excluded: boolean; canvases: Array<{ canvasId: string; canvasName: string; excluded: boolean }> }>;
    };
    const mine = scope0.files.find((f) => f.fileId === fileId)!;
    expect(mine).toBeDefined();
    expect(mine.excluded).toBe(false);
    expect(mine.canvases.map((c) => c.canvasName).sort()).toEqual(['画布 1', '画布二']);

    // 画布级排除「画布二」→ page 不再见画布二任务；任务A/纯参与仍在；重复 PUT 幂等
    const canvas2Row = mine.canvases.find((c) => c.canvasName === '画布二')!;
    for (let i = 0; i < 2; i++) {
      const put = await authed(memberToken, 'put', '/api/todos/scope').send({ fileId, canvasId: canvas2Row.canvasId, excluded: true });
      expect(put.status).toBe(200);
    }
    const page1 = (await (await authed(memberToken, 'get', '/api/todos')).body) as {
      stats: { all: number };
      items: Array<{ text: string; canvasName: string | null }>;
    };
    expect(page1.stats.all).toBe(2);
    expect(page1.items.find((t) => t.text === '画布二任务')).toBeUndefined();
    expect(page1.items.find((t) => t.text === '任务A')).toBeDefined();
    // scope 读侧排除态回显
    const scope1 = (await (await authed(memberToken, 'get', '/api/todos/scope')).body) as { files: Array<{ canvases: Array<{ canvasId: string; excluded: boolean }> }> };
    expect(scope1.files.find((f) => f.fileId === fileId)!.canvases.find((c) => c.canvasId === canvas2Row.canvasId)!.excluded).toBe(true);

    // 恢复画布参与 → 任务回来
    await authed(memberToken, 'put', '/api/todos/scope').send({ fileId, canvasId: canvas2Row.canvasId, excluded: false });
    const page2 = (await (await authed(memberToken, 'get', '/api/todos')).body) as { stats: { all: number } };
    expect(page2.stats.all).toBe(3);

    // 文件级排除：member 视角该文件整体退出（page/report/activity 三处同口径）；admin 不受影响
    await authed(memberToken, 'put', '/api/todos/scope').send({ fileId, excluded: true });
    const page3 = (await (await authed(memberToken, 'get', '/api/todos')).body) as { stats: { all: number } };
    expect(page3.stats.all).toBe(0);
    const report3 = (await (await authed(memberToken, 'get', '/api/todos/report?range=all')).body) as { stats: { total: number } };
    expect(report3.stats.total).toBe(0);
    const adminPage = (await (await authed(adminToken, 'get', '/api/todos')).body) as { stats: { all: number } };
    expect(adminPage.stats.all).toBe(5); // admin 自己的配置未排除该文件
    const memberAct = (await (await authed(memberToken, 'get', '/api/todos/activity?limit=100')).body) as {
      items: Array<{ payload: { fileId: string } | null }>;
    };
    expect(memberAct.items.find((i) => i.payload?.fileId === fileId)).toBeUndefined();

    // 恢复文件参与 → 全部回来（config 行删除后页/报表复位）
    await authed(memberToken, 'put', '/api/todos/scope').send({ fileId, excluded: false });
    const page4 = (await (await authed(memberToken, 'get', '/api/todos')).body) as { stats: { all: number } };
    expect(page4.stats.all).toBe(3);

    // 无权限文件 PUT → 404 不泄露存在性
    const strangerFile = (await (await authed(adminToken, 'post', '/api/files')).body) as { id: string };
    const denied = await authed(memberToken, 'put', '/api/todos/scope').send({ fileId: strangerFile.id, excluded: true });
    expect(denied.status).toBe(404);

    // byOwner 头像键（2026-11-21 追加）：设置了头像的成员行回传 avatarUrl 存储键
    const avatarSet = await authed(memberToken, 'patch', '/api/users/me/avatar').send({ avatarUrl: '/avatars/preset-1.svg' });
    expect(avatarSet.status).toBe(200);
    const rep = (await (await authed(memberToken, 'get', '/api/todos/report?range=all')).body) as {
      byOwner: Array<{ key: string; avatarUrl?: string | null }>;
    };
    expect(rep.byOwner.find((r) => r.key === memberId)?.avatarUrl).toBe('/avatars/preset-1.svg');
  });

  it('setOwnerProgress 独立写入后 mySubProgress 跟随（负责人无人员条目场景）', async () => {
    // member 是任务A负责人且无自身条目 → ownerProgress 即 mySubProgress 的唯一来源
    const content = await authed(adminToken, 'get', `/api/files/${fileId}`);
    const doc = docFromState(new Uint8Array(Buffer.from((content.body as { docState: string }).docState, 'base64')));
    const { listCanvases: lc } = await import('@gmind/core');
    const canvas1 = lc(doc)[0]!.id;
    setOwnerProgress(doc, taskAId, 45, ORIGIN_USER, canvas1);
    const state = Buffer.from(docToState(doc)).toString('base64');
    await authed(adminToken, 'put', `/api/files/${fileId}/doc-state`).send({ docState: state });
    await pollUntil(async () => {
      const page = (await (await authed(memberToken, 'get', '/api/todos')).body) as {
        items: Array<{ text: string; mySubProgress: number | null }>;
      };
      return page.items.find((t) => t.text === '任务A')?.mySubProgress === 45;
    }, 'ownerProgress 进 mySubProgress');
  });
})
