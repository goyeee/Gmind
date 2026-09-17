import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import type { INestApplication } from '@nestjs/common';
import { createTestApp } from './support/app-test';

describe('GET /api/users/me', () => {
  let app: INestApplication;

  beforeAll(async () => {
    app = await createTestApp();
  });

  afterAll(async () => {
    await app.close();
  });

  it('无 token 返回 401', async () => {
    const res = await request(app.getHttpServer()).get('/api/users/me');
    expect(res.status).toBe(401);
  });

  it('伪造 token 返回 401（NFR-SEC-003 越权用例）', async () => {
    const res = await request(app.getHttpServer()).get('/api/users/me').set('Authorization', 'Bearer fake-token');
    expect(res.status).toBe(401);
  });
});
