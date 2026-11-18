import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const REAL_ENV = { ...process.env };

describe('开发环境默认端口', () => {
  beforeEach(() => {
    vi.resetModules();
    delete process.env.WEB_PORT;
  });

  afterEach(() => {
    process.env = { ...REAL_ENV };
  });

  it('Vite 未设置 WEB_PORT 时监听 5174', async () => {
    const { default: config } = await import('../vite.config');

    expect(config).toMatchObject({ server: { port: 5174 } });
  });

  it('Playwright 未设置 WEB_PORT 时访问 5174', async () => {
    const { default: config } = await import('../playwright.config');

    expect(config).toMatchObject({
      use: { baseURL: 'http://localhost:5174' },
      webServer: { url: 'http://localhost:5174' },
    });
  });
});
