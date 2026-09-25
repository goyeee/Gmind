import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import type { INestApplication } from '@nestjs/common';
import { readdirSync, rmSync } from 'node:fs';
import { createTestApp } from './support/app-test';

// 1×1 透明 PNG（已知良好的 base64 常量，魔数 89 50 4E 47）
const PNG_1X1 = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==',
  'base64',
);
// jpg/gif/webp 仅按魔数校验（服务端不解析像素），正文体只需前缀命中白名单
const JPG_FAKE = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(16, 0x00)]);
const GIF_FAKE = Buffer.concat([Buffer.from([0x47, 0x49, 0x46, 0x38, 0x39, 0x61]), Buffer.alloc(16, 0x00)]);
const WEBP_FAKE = Buffer.concat([Buffer.from([0x52, 0x49, 0x46, 0x46, 0x00, 0x00, 0x00, 0x00, 0x57, 0x45, 0x42, 0x50]), Buffer.alloc(16, 0x00)]);
// >10MB 且魔数合法的 PNG 体：必须先因大小被拒（413），而非格式
const OVER_10MB_PNG = Buffer.concat([PNG_1X1, Buffer.alloc(10 * 1024 * 1024 + 1, 0x00)]);
// e2e 存储目录由 test/support/env.setup.ts 固定为 ./.data/storage-e2e（相对 apps/server 运行目录）
const TEST_STORAGE_DIR = `${process.cwd()}/.data/storage-e2e`;

describe('storage 域（本地磁盘图片存储 Provider）', () => {
  let app: INestApplication;
  let token: string;
  // 准入 7.2（M3a Task 1）装置：第二用户（非协作者）与真实文件行（属主校验按 files 表判定）
  let otherToken: string;
  const otherPhone = '13800005556';
  let mineA: { id: string }; // owner 主上传文件（copy 源键出处，永不授权他人）
  let mineB: { id: string }; // owner copy 目标文件（后授权给协作者）
  let theirs: { id: string }; // 第二用户自己的文件（负例 copy 目的地）
  const tokenFor = async (userId: string): Promise<string> => {
    // 直接通过 SessionService 签发，登录接口在 Task 8 才有
    const { SessionService } = await import('../src/session/session.service');
    const redisMod = await import('ioredis');
    const svc = new SessionService(new redisMod.default('redis://127.0.0.1:63790/1'));
    return (await svc.create(userId, false)).token;
  };

  beforeAll(async () => {
    rmSync(TEST_STORAGE_DIR, { recursive: true, force: true });
    app = await createTestApp();
    const users = app.get((await import('../src/users/users.service')).UsersService);
    const user = await users.create({ method: 'phone', phone: '13800005555' });
    token = await tokenFor(user.id);
    const other = await users.create({ method: 'phone', phone: otherPhone });
    otherToken = await tokenFor(other.id);
    const files = app.get((await import('../src/files/files.service')).FilesService);
    mineA = await files.createForUser(user.id, { title: '存储属主-A' });
    mineB = await files.createForUser(user.id, { title: '存储属主-B' });
    theirs = await files.createForUser(other.id, { title: '他人文件' });
  });

  afterAll(async () => {
    await app.close();
    rmSync(TEST_STORAGE_DIR, { recursive: true, force: true });
  });

  it('上传 1×1 PNG → { key }（files/ 前缀），GET 读回字节一致且带 image/png + immutable 缓存头', async () => {
    const upload = await request(app.getHttpServer())
      .post(`/api/files/${mineA.id}/images`)
      .set('Authorization', `Bearer ${token}`)
      .attach('file', PNG_1X1, 'x.png');
    expect(upload.status).toBe(201);
    expect(typeof upload.body.key).toBe('string');
    expect(upload.body.key.startsWith('files/')).toBe(true);

    const res = await request(app.getHttpServer()).get(`/api/images/${upload.body.key}`);
    expect(res.status).toBe(200);
    const bytes = Buffer.isBuffer(res.body) ? res.body : Buffer.from(res.body);
    expect(bytes.equals(PNG_1X1)).toBe(true);
    expect(res.headers['content-type']).toBe('image/png');
    expect(res.headers['cache-control']).toBe('public, max-age=31536000, immutable');
  });

  it('POST images/copy：上传的 key 复制到另一 file 前缀 → 新 key 字节一致，原 key 仍在（Task 15 FR-EDT-010）', async () => {
    const upload = await request(app.getHttpServer())
      .post(`/api/files/${mineA.id}/images`)
      .set('Authorization', `Bearer ${token}`)
      .attach('file', PNG_1X1, 'x.png');
    expect(upload.status).toBe(201);
    const sourceKey = upload.body.key as string;

    const copy = await request(app.getHttpServer())
      .post(`/api/files/${mineB.id}/images/copy`)
      .set('Authorization', `Bearer ${token}`)
      .send({ sourceKey });
    expect(copy.status).toBe(201);
    expect(typeof copy.body.key).toBe('string');
    expect(copy.body.key).not.toBe(sourceKey);
    expect((copy.body.key as string).startsWith(`files/${mineB.id}/`)).toBe(true);

    const copied = await request(app.getHttpServer()).get(`/api/images/${copy.body.key}`);
    expect(copied.status).toBe(200);
    const bytes = Buffer.isBuffer(copied.body) ? copied.body : Buffer.from(copied.body);
    expect(bytes.equals(PNG_1X1)).toBe(true);
    // 源对象不受影响
    const origin = await request(app.getHttpServer()).get(`/api/images/${sourceKey}`);
    expect(origin.status).toBe(200);
  });

  it('POST images/copy：源 key 不存在 → 404；含 .. → 400；扩展名白名单外 → 400', async () => {
    const missing = await request(app.getHttpServer())
      .post(`/api/files/${mineB.id}/images/copy`)
      .set('Authorization', `Bearer ${token}`)
      .send({ sourceKey: `files/${mineA.id}/nope.png` });
    expect(missing.status).toBe(404);

    const traversal = await request(app.getHttpServer())
      .post(`/api/files/${mineB.id}/images/copy`)
      .set('Authorization', `Bearer ${token}`)
      .send({ sourceKey: '../etc/passwd.png' });
    expect(traversal.status).toBe(400);

    const badExt = await request(app.getHttpServer())
      .post(`/api/files/${mineB.id}/images/copy`)
      .set('Authorization', `Bearer ${token}`)
      .send({ sourceKey: `files/${mineA.id}/key.txt` });
    expect(badExt.status).toBe(400);
  });

  it('jpg/gif/webp 魔数均被接受并返回对应 Content-Type', async () => {
    const cases = [
      { buf: JPG_FAKE, name: 'x', type: 'image/jpeg' },
      { buf: GIF_FAKE, name: 'x', type: 'image/gif' },
      { buf: WEBP_FAKE, name: 'x', type: 'image/webp' },
    ];
    for (const c of cases) {
      const upload = await request(app.getHttpServer())
        .post(`/api/files/${mineA.id}/images`)
        .set('Authorization', `Bearer ${token}`)
        .attach('file', c.buf, 'x.png');
      expect(upload.status).toBe(201);
      const res = await request(app.getHttpServer()).get(`/api/images/${upload.body.key}`);
      expect(res.status).toBe(200);
      expect(res.headers['content-type']).toBe(c.type);
    }
  });

  it('.txt 伪装 → 415「不支持的图片格式」', async () => {
    const res = await request(app.getHttpServer())
      .post(`/api/files/${mineA.id}/images`)
      .set('Authorization', `Bearer ${token}`)
      .attach('file', Buffer.from('hello'), 'x.txt');
    expect(res.status).toBe(415);
    expect(res.body.message).toBe('不支持的图片格式');
  });

  it('>10MB Buffer（合法 PNG 魔数 + 填充）→ 413「图片大小超出 10MB 限制」，且不在磁盘留下任何文件', async () => {
    // multer fileSize 硬顶路径：拒收发生在内存缓冲/落盘之前，磁盘不得新增文件
    const countStoredFiles = (): number => readdirSync(TEST_STORAGE_DIR, { recursive: true }).length;
    const before = countStoredFiles();
    const res = await request(app.getHttpServer())
      .post(`/api/files/${mineA.id}/images`)
      .set('Authorization', `Bearer ${token}`)
      .attach('file', OVER_10MB_PNG, 'big.png');
    expect(res.status).toBe(413);
    expect(res.body.message).toBe('图片大小超出 10MB 限制');
    expect(countStoredFiles()).toBe(before);
  });

  it('GET 不存在的 key → 404', async () => {
    const res = await request(app.getHttpServer()).get('/api/images/nope.png');
    expect(res.status).toBe(404);
  });

  it('GET 含 .. 的 key（路径穿越）→ 400', async () => {
    const res = await request(app.getHttpServer()).get('/api/images/..%2Fetc%2Fpasswd');
    expect(res.status).toBe(400);
  });

  // —— 准入 7.2（M3a Task 1）：写端点属主校验（owner 或协作者，deletedAt null）——
  it('非协作者上传到他人文件 → 404「文件不存在」（不泄露存在性）', async () => {
    const res = await request(app.getHttpServer())
      .post(`/api/files/${mineA.id}/images`)
      .set('Authorization', `Bearer ${otherToken}`)
      .attach('file', PNG_1X1, 'x.png');
    expect(res.status).toBe(404);
    expect(res.body.message).toBe('文件不存在');
  });

  it('非协作者 copy 他人 key 到自己命名空间 → 404「文件不存在」（源键归属文件须可访问）', async () => {
    const upload = await request(app.getHttpServer())
      .post(`/api/files/${mineA.id}/images`)
      .set('Authorization', `Bearer ${token}`)
      .attach('file', PNG_1X1, 'x.png');
    expect(upload.status).toBe(201);
    const sourceKey = upload.body.key as string;

    const res = await request(app.getHttpServer())
      .post(`/api/files/${theirs.id}/images/copy`)
      .set('Authorization', `Bearer ${otherToken}`)
      .send({ sourceKey });
    expect(res.status).toBe(404);
    expect(res.body.message).toBe('文件不存在');
  });

  it('非协作者 copy 目标为他人文件 → 404「文件不存在」（目标命名空间须可编辑）', async () => {
    const upload = await request(app.getHttpServer())
      .post(`/api/files/${mineA.id}/images`)
      .set('Authorization', `Bearer ${token}`)
      .attach('file', PNG_1X1, 'x.png');
    expect(upload.status).toBe(201);

    const res = await request(app.getHttpServer())
      .post(`/api/files/${mineA.id}/images/copy`)
      .set('Authorization', `Bearer ${otherToken}`)
      .send({ sourceKey: upload.body.key });
    expect(res.status).toBe(404);
    expect(res.body.message).toBe('文件不存在');
  });

  it('协作者（dev-e2e grant-collaborator 授权）上传 → 201，key 落在授权文件命名空间', async () => {
    const grant = await request(app.getHttpServer())
      .post('/api/dev-e2e/grant-collaborator')
      .send({ fileId: mineB.id, phone: otherPhone });
    expect(grant.status).toBe(201);

    const upload = await request(app.getHttpServer())
      .post(`/api/files/${mineB.id}/images`)
      .set('Authorization', `Bearer ${otherToken}`)
      .attach('file', PNG_1X1, 'x.png');
    expect(upload.status).toBe(201);
    expect((upload.body.key as string).startsWith(`files/${mineB.id}/`)).toBe(true);
  });
});
