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
  });

  afterAll(async () => {
    await app.close();
    rmSync(TEST_STORAGE_DIR, { recursive: true, force: true });
  });

  it('上传 1×1 PNG → { key }（files/ 前缀），GET 读回字节一致且带 image/png + immutable 缓存头', async () => {
    const upload = await request(app.getHttpServer())
      .post('/api/files/file-abc/images')
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

  it('jpg/gif/webp 魔数均被接受并返回对应 Content-Type', async () => {
    const cases = [
      { buf: JPG_FAKE, name: 'x', type: 'image/jpeg' },
      { buf: GIF_FAKE, name: 'x', type: 'image/gif' },
      { buf: WEBP_FAKE, name: 'x', type: 'image/webp' },
    ];
    for (const c of cases) {
      const upload = await request(app.getHttpServer())
        .post('/api/files/file-abc/images')
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
      .post('/api/files/file-abc/images')
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
      .post('/api/files/file-abc/images')
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
});
