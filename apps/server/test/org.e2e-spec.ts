import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import type { INestApplication } from '@nestjs/common';

/**
 * 组织管理（/api/org，第二期批次 A）e2e：
 * - 权限门：读登录即可（member 200）；写（建/删/挂靠经 admin PATCH）仅 super_admin（member 403/未登录 401）；
 * - 部门/分组 CRUD：建 201、撞名 409、有账号挂靠删除 409、清挂靠后可删；
 * - 挂靠：PATCH /api/admin/users/:id { departmentId, groupIds } → directory 回显；
 *   无效 id 404；空目录删除即成。
 */
describe('组织管理（/api/org）：部门/分组/挂靠', () => {
  let app: INestApplication;
  let adminToken: string;
  let adminId: string;
  let memberToken: string;
  let memberId: string;

  const authed = (token: string, method: 'get' | 'post' | 'patch' | 'delete', url: string) =>
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
    // 首个登录建号 = 空库第一人 → super_admin
    const admin = await login('13800001111');
    adminToken = admin.token;
    adminId = admin.id;
    const member = await login('13800002222');
    memberToken = member.token;
    memberId = member.id;
  });

  afterAll(async () => {
    await app.close();
  });

  it('权限门：未登录读 401；member 读 200、写 403', async () => {
    expect((await request(app.getHttpServer()).get('/api/org/directory')).status).toBe(401);
    expect((await request(app.getHttpServer()).post('/api/org/departments').send({ name: 'X' })).status).toBe(401);
    expect((await authed(memberToken, 'get', '/api/org/directory')).status).toBe(200);
    expect((await authed(memberToken, 'post', '/api/org/departments').send({ name: 'X' })).status).toBe(403);
    expect(String((await authed(memberToken, 'post', '/api/org/departments').send({ name: 'X' })).body.message)).toContain(
      '仅超级管理员',
    );
  });

  it('部门 CRUD：建/撞名 409/列表；挂靠后删除 409、清挂靠后可删', async () => {
    const created = await authed(adminToken, 'post', '/api/org/departments').send({ name: '产品部' });
    expect(created.status).toBe(201);
    const deptId = (created.body as { id: string }).id;

    const dup = await authed(adminToken, 'post', '/api/org/departments').send({ name: '产品部' });
    expect(dup.status).toBe(409);

    // 挂到 admin 自己 → 删除 409 → 清挂 → 可删（重建一次验证删除路径）
    const patch = await authed(adminToken, 'patch', `/api/admin/users/${adminId}`).send({ departmentId: deptId });
    expect(patch.status).toBe(200);
    const blocked = await authed(adminToken, 'delete', `/api/org/departments/${deptId}`);
    expect(blocked.status).toBe(409);
    expect(String(blocked.body.message)).toContain('请先转移账号');

    const clear = await authed(adminToken, 'patch', `/api/admin/users/${adminId}`).send({ departmentId: null });
    expect(clear.status).toBe(200);
    expect((await authed(adminToken, 'delete', `/api/org/departments/${deptId}`)).status).toBe(200);
    // 目录回空
    const dir = (await (await authed(adminToken, 'get', '/api/org/directory')).body) as { departments: unknown[] };
    expect(dir.departments).toHaveLength(0);
  });

  it('分组多选拼靠：groupIds 全量替换；挂靠中删除 409；无效 id 404', async () => {
    const g1 = await authed(adminToken, 'post', '/api/org/groups').send({ name: '项目核心组', color: '#3370ff' });
    const g2 = await authed(adminToken, 'post', '/api/org/groups').send({ name: '前端组' });
    expect(g1.status).toBe(201);
    expect(g2.status).toBe(201);
    const gid1 = (g1.body as { id: string }).id;
    const gid2 = (g2.body as { id: string }).id;

    const dup = await authed(adminToken, 'post', '/api/org/groups').send({ name: '前端组' });
    expect(dup.status).toBe(409);

    // member 挂两个分组 → directory 回显
    const patch = await authed(adminToken, 'patch', `/api/admin/users/${memberId}`).send({ groupIds: [gid1, gid2] });
    expect(patch.status).toBe(200);
    expect((patch.body as { groupIds: string[] }).groupIds.sort()).toEqual([gid1, gid2].sort());

    const dir = (await (await authed(memberToken, 'get', '/api/org/directory')).body) as {
      memberships: Array<{ userId: string; groupIds: string[] }>;
    };
    expect(dir.memberships.find((m) => m.userId === memberId)?.groupIds.sort()).toEqual([gid1, gid2].sort());

    // 挂靠中删除 → 409；全量替换为空 → 可删
    expect((await authed(adminToken, 'delete', `/api/org/groups/${gid1}`)).status).toBe(409);
    await authed(adminToken, 'patch', `/api/admin/users/${memberId}`).send({ groupIds: [] });
    expect((await authed(adminToken, 'delete', `/api/org/groups/${gid1}`)).status).toBe(200);
    expect((await authed(adminToken, 'delete', `/api/org/groups/${gid2}`)).status).toBe(200);

    // 无效 id
    const badDept = await authed(adminToken, 'patch', `/api/admin/users/${memberId}`).send({ departmentId: '01NOPE' });
    expect(badDept.status).toBe(404);
    const badGroup = await authed(adminToken, 'patch', `/api/admin/users/${memberId}`).send({ groupIds: ['01NOPE'] });
    expect(badGroup.status).toBe(404);
  });

  it('空 patch 400（新字段不纳入「至少其一」时仍要拦纯空体）', async () => {
    const res = await authed(adminToken, 'patch', `/api/admin/users/${memberId}`).send({});
    expect(res.status).toBe(400);
  });
});
