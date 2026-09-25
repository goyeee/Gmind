import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import type { INestApplication } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { ulid } from 'ulid';
import { createTestApp } from './support/app-test';

/**
 * 回收站域 e2e（M3a Task 7，FR-FIL-005~007/010）：列表 / 还原 / 彻底删除 / 定时清理 / 到期提醒。
 *
 * 口径：
 * - GET /api/trash 仅含本人文件（owner=me），deleted_by 任意；条目含 删除时间/删除人昵称/
 *   原文件夹名（删除时所在文件夹，已删文件夹按旧名回显）/nodeCount，按 deleted_at DESC。
 * - restore：原文件夹存活 → 回原处；已删/缺失 → 回根（folder_id=null）；不在回收站 → 404。
 * - purge：files 行 + comments/versions/file_collaborators/invites/share_links/file_stars
 *   硬删 + 存储前缀清理（图片 404）；events 保留（审计 180 天裁定）。
 * - CleanupService.runCleanup(now)：满 30 天 purge；剩 3 天（满 27 天）notification 提醒
 *   （type system + payload，同一条目只提醒一次——payload LIKE '"fileId":"<ulid>"' 幂去重）。
 *   本环境无 SMTP（M0 MailHog 未起）→ 邮件仅 log，不 crash。
 */

const DAY_MS = 24 * 60 * 60 * 1000;
// 1×1 透明 PNG（魔数 89 50 4E 47），存储域同款常量
const PNG_1X1 = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==',
  'base64',
);

describe('回收站域（FR-FIL-005~007/010）', () => {
  let app: INestApplication;
  let ds: DataSource;
  let userId: string;
  let token: string;
  let otherToken: string;
  const otherPhone = '13800060002';

  const tokenFor = async (uid: string): Promise<string> => {
    const { SessionService } = await import('../src/session/session.service');
    const redisMod = await import('ioredis');
    const svc = new SessionService(new redisMod.default('redis://127.0.0.1:63790/1'));
    return (await svc.create(uid, false)).token;
  };

  const authed = (method: 'get' | 'post' | 'put' | 'delete', url: string, tk = token) =>
    request(app.getHttpServer())[method](url).set('Authorization', `Bearer ${tk}`);

  const createFolder = async (name: string): Promise<{ id: string }> => {
    const res = await authed('post', '/api/folders').send({ name });
    expect(res.status).toBe(201);
    return res.body;
  };

  const createFile = async (title: string, folderId?: string): Promise<{ id: string }> => {
    const files = app.get((await import('../src/files/files.service')).FilesService);
    return files.createForUser(userId, { title, folderId });
  };

  const countRows = async (table: string, fileId: string): Promise<number> => {
    const rows: { c: string }[] = await ds.query(`SELECT COUNT(*) AS c FROM ${table} WHERE file_id = ?`, [fileId]);
    return Number(rows[0]?.c ?? 0);
  };

  beforeAll(async () => {
    app = await createTestApp();
    ds = app.get(DataSource);
    const users = app.get((await import('../src/users/users.service')).UsersService);
    const user = await users.create({ method: 'phone', phone: '13800060001', nickname: '回收站甲' });
    userId = user.id;
    token = await tokenFor(user.id);
    const other = await users.create({ method: 'phone', phone: otherPhone, nickname: '回收站乙' });
    otherToken = await tokenFor(other.id);
  });

  afterAll(async () => {
    await app.close();
  });

  it('软删文件 → 回收站列表含删除人昵称/删除时间/原文件夹名/nodeCount，按删除时间倒序', async () => {
    const folder = await createFolder('工作文档');
    const fileA = await createFile('被删文件A', folder.id);
    const fileB = await createFile('被删文件B');
    const alive = await createFile('存活文件');

    const del1 = await authed('delete', `/api/files/${fileA.id}`); // 先删 A（在文件夹里）
    expect(del1.status).toBe(200);
    const del2 = await authed('delete', `/api/files/${fileB.id}`); // 再删 B（根目录）
    expect(del2.status).toBe(200);

    const res = await authed('get', '/api/trash');
    expect(res.status).toBe(200);
    const ids = res.body.map((x: { id: string }) => x.id);
    expect(ids).toContain(fileA.id);
    expect(ids).toContain(fileB.id);
    expect(ids).not.toContain(alive.id);
    // 倒序：后删的 B 在前
    expect(ids.indexOf(fileB.id)).toBeLessThan(ids.indexOf(fileA.id));

    const entryA = res.body.find((x: { id: string }) => x.id === fileA.id);
    expect(entryA.title).toBe('被删文件A');
    expect(typeof entryA.nodeCount).toBe('number');
    expect(new Date(entryA.deletedAt).toString()).not.toBe('Invalid Date');
    expect(entryA.deletedByName).toBe('回收站甲'); // 删除人昵称（deleted_by → users.nickname）
    expect(entryA.folderName).toBe('工作文档'); // 原文件夹名（删除时所在）
    const entryB = res.body.find((x: { id: string }) => x.id === fileB.id);
    expect(entryB.folderName).toBeNull(); // 根目录文件无文件夹名

    // 非拥有者列表不可见（owner=me only）
    const otherList = await authed('get', '/api/trash', otherToken);
    expect(otherList.status).toBe(200);
    expect(otherList.body.map((x: { id: string }) => x.id)).not.toContain(fileA.id);
  });

  it('非拥有者还原/彻底删 → 404；不在回收站（存活/不存在）→ 404', async () => {
    const fileA = await createFile('权限负例文件');
    // 非拥有者对他人文件操作 → 404 不泄露存在性（他人文件也未在本人回收站）
    expect((await authed('post', `/api/trash/${fileA.id}/restore`, otherToken)).status).toBe(404);
    expect((await authed('delete', `/api/trash/${fileA.id}`, otherToken)).status).toBe(404);
    // 存活（未删）文件不在回收站 → owner 自己操作同样 404
    expect((await authed('post', `/api/trash/${fileA.id}/restore`)).status).toBe(404);
    expect((await authed('delete', `/api/trash/${fileA.id}`)).status).toBe(404);
    // 不存在的 id → 404
    expect((await authed('post', `/api/trash/${ulid()}/restore`)).status).toBe(404);
    await authed('delete', `/api/files/${fileA.id}`);
    // 不存在文件的彻底删除 → 404
    expect((await authed('delete', `/api/trash/${ulid()}`)).status).toBe(404);
  });

  it('还原回原处（原文件夹存活）：deleted_at/deleted_by 清空、folder_id 不变', async () => {
    const folder = await createFolder('还原原处');
    const file = await createFile('原处还原文件', folder.id);
    await authed('delete', `/api/files/${file.id}`);
    expect((await authed('get', `/api/files/${file.id}`)).status).toBe(404); // 回收站中不可打开

    const res = await authed('post', `/api/trash/${file.id}/restore`);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true });

    // 存活可打开，落点仍在原文件夹，软删标记清空
    const back = await authed('get', `/api/files/${file.id}`);
    expect(back.status).toBe(200);
    const rows: { folder_id: string | null; deleted_at: string | null; deleted_by: string | null }[] =
      await ds.query('SELECT folder_id, deleted_at, deleted_by FROM files WHERE id = ?', [file.id]);
    expect(rows[0]?.folder_id).toBe(folder.id);
    expect(rows[0]?.deleted_at).toBeNull();
    expect(rows[0]?.deleted_by).toBeNull();
    // 回收站列表不再包含
    const list = await authed('get', '/api/trash');
    expect(list.body.map((x: { id: string }) => x.id)).not.toContain(file.id);
  });

  it('原文件夹已删 → 还原到根（folder_id=null）', async () => {
    const folder = await createFolder('将被删除的文件夹');
    const file = await createFile('文件夹先删文件', folder.id);
    // 文件夹整体入回收站（级联软删其下文件）——文件随文件夹进入回收站
    expect((await authed('delete', `/api/folders/${folder.id}`)).status).toBe(200);
    const list = await authed('get', '/api/trash');
    expect(list.body.map((x: { id: string }) => x.id)).toContain(file.id);

    const res = await authed('post', `/api/trash/${file.id}/restore`);
    expect(res.status).toBe(200);
    const rows: { folder_id: string | null }[] = await ds.query('SELECT folder_id FROM files WHERE id = ?', [
      file.id,
    ]);
    expect(rows[0]?.folder_id).toBeNull(); // 原文件夹已删 → 回根
    expect((await authed('get', `/api/files/${file.id}`)).status).toBe(200);
  });

  it('彻底删除：关联行全清（comments/versions/stars/collaborators/share_links/invites）+ 图片 404 + events 保留', async () => {
    const file = await createFile('彻底删除文件');
    // 图片上传（purge 后须 404）
    const upload = await authed('post', `/api/files/${file.id}/images`).attach('file', PNG_1X1, 'x.png');
    expect(upload.status).toBe(201);
    const key = upload.body.key as string;
    expect((await request(app.getHttpServer()).get(`/api/images/${key}`)).status).toBe(200);
    // 星标 + 协作者（走既有 API 造行）
    expect((await authed('put', `/api/files/${file.id}/star`)).status).toBe(200);
    const grant = await request(app.getHttpServer())
      .post('/api/dev-e2e/grant-collaborator')
      .send({ fileId: file.id, phone: otherPhone });
    expect(grant.status).toBe(201);
    // 无 API 的表（comments/versions/share_links/invites/events）直插行
    const insertRow = (table: string, cols: string, values: unknown[]): Promise<unknown> =>
      ds.query(`INSERT INTO ${table} (${cols}) VALUES (${values.map(() => '?').join(', ')})`, values);
    await insertRow(
      'comments',
      'id, file_id, node_id, author_id, content, created_at, updated_at',
      [ulid(), file.id, ulid(), userId, '待清理评论', new Date(), new Date()],
    );
    await insertRow(
      'versions',
      'id, file_id, node_count, created_by, type, state, created_at',
      [ulid(), file.id, 3, userId, 'manual', Buffer.from('v1'), new Date()],
    );
    await insertRow(
      'share_links',
      'id, file_id, token, created_by, created_at',
      [ulid(), file.id, ulid().toLowerCase().slice(0, 32), userId, new Date()],
    );
    await insertRow(
      'invites',
      'id, file_id, contact_type, contact, invited_by, created_at',
      [ulid(), file.id, 'email', 'purge@example.com', userId, new Date()],
    );
    await insertRow(
      'events',
      'id, type, file_id, user_id, created_at',
      [ulid(), 'file.deleted', file.id, userId, new Date()],
    );
    // 先软删入回收站（彻底删除的前置态），再手动彻底删除
    expect((await authed('delete', `/api/files/${file.id}`)).status).toBe(200);

    const res = await authed('delete', `/api/trash/${file.id}`);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true });

    // DB 行级断言：files + 关联行全部消失
    expect(await countRows('comments', file.id)).toBe(0);
    expect(await countRows('versions', file.id)).toBe(0);
    expect(await countRows('file_stars', file.id)).toBe(0);
    expect(await countRows('file_collaborators', file.id)).toBe(0);
    expect(await countRows('share_links', file.id)).toBe(0);
    expect(await countRows('invites', file.id)).toBe(0);
    const filesRows = await ds.query('SELECT id FROM files WHERE id = ?', [file.id]);
    expect(filesRows).toHaveLength(0);
    // events 保留（审计 180 天裁定，不随 purge 清理）
    expect(await countRows('events', file.id)).toBe(1);

    // 对象存储前缀已清理：图片 404
    expect((await request(app.getHttpServer()).get(`/api/images/${key}`)).status).toBe(404);
    // 回收站不再包含；重复彻底删除 → 404（行已删）
    const list = await authed('get', '/api/trash');
    expect(list.body.map((x: { id: string }) => x.id)).not.toContain(file.id);
    expect((await authed('delete', `/api/trash/${file.id}`)).status).toBe(404);
  });

  it('runCleanup(+30d)：满 30 天自动清除（purge 计数返回），无提醒', async () => {
    const cleanup = app.get((await import('../src/jobs/cleanup.service')).CleanupService);
    const fileA = await createFile('清理边界A');
    const fileB = await createFile('清理边界B');
    await authed('delete', `/api/files/${fileA.id}`);
    await authed('delete', `/api/files/${fileB.id}`);

    const res = await cleanup.runCleanup(new Date(Date.now() + 30 * DAY_MS));
    expect(res.purged).toBeGreaterThanOrEqual(2); // 含此前用例遗留的回收站条目
    expect(res.reminded).toBe(0);
    for (const id of [fileA.id, fileB.id]) {
      const rows = await ds.query('SELECT id FROM files WHERE id = ?', [id]);
      expect(rows).toHaveLength(0); // 行已硬删
    }
    const list = await authed('get', '/api/trash');
    expect(list.body).toHaveLength(0); // 回收站被清空
  });

  it('runCleanup(+27d)：剩 3 天提醒一次（notification 落库），重复执行幂等；未满 27 天不提醒', async () => {
    const cleanup = app.get((await import('../src/jobs/cleanup.service')).CleanupService);
    const due = await createFile('到期提醒文件');
    await authed('delete', `/api/files/${due.id}`);

    const first = await cleanup.runCleanup(new Date(Date.now() + 27 * DAY_MS));
    expect(first).toEqual({ purged: 0, reminded: 1 });
    let rows: { user_id: string; type: string; payload: string }[] = await ds.query(
      'SELECT user_id, type, payload FROM notifications ORDER BY created_at ASC',
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]?.user_id).toBe(userId);
    expect(rows[0]?.type).toBe('system');
    const payload = JSON.parse(rows[0]?.payload ?? '{}') as {
      fileId: string;
      title: string;
      deletedAt: string;
      action: string;
    };
    expect(payload.fileId).toBe(due.id);
    expect(payload.title).toBe('到期提醒文件');
    expect(typeof payload.deletedAt).toBe('string');
    expect(payload.action).toBe('restore');

    // 幂等：第二次运行不重复提醒（payload LIKE '"fileId":"<ulid>"' 判重）
    const second = await cleanup.runCleanup(new Date(Date.now() + 27 * DAY_MS));
    expect(second.reminded).toBe(0);
    rows = await ds.query('SELECT user_id, type, payload FROM notifications');
    expect(rows).toHaveLength(1);

    // 未满 27 天（模拟 +26d 扫描）→ 不提醒也不清除
    const early = await createFile('未到期文件');
    await authed('delete', `/api/files/${early.id}`);
    const third = await cleanup.runCleanup(new Date(Date.now() + 26 * DAY_MS));
    expect(third).toEqual({ purged: 0, reminded: 0 });
    rows = await ds.query('SELECT user_id, type, payload FROM notifications');
    expect(rows).toHaveLength(1);
  });

  it('到期提醒 payload 可直接驱动还原（fileId + action=restore）', async () => {
    const rows: { payload: string }[] = await ds.query("SELECT payload FROM notifications WHERE type = 'system'");
    expect(rows).toHaveLength(1);
    const payload = JSON.parse(rows[0]?.payload ?? '{}') as { fileId: string; action: string };
    expect(payload.action).toBe('restore');

    const res = await authed('post', `/api/trash/${payload.fileId}/restore`);
    expect(res.status).toBe(200);
    expect((await authed('get', `/api/files/${payload.fileId}`)).status).toBe(200); // 还原后可打开
    const list = await authed('get', '/api/trash');
    expect(list.body.map((x: { id: string }) => x.id)).not.toContain(payload.fileId);
  });
});
