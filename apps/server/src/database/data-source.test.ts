import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { createDataSource } from './data-source';

/** 迁移文件名推导预期类名：`20260918000000-init.ts` → `Init20260918000000`（时间戳置后，名称段 PascalCase）。 */
function expectedClassName(filename: string): string {
  const base = filename.replace(/\.ts$/, '');
  const [timestamp = '', ...nameParts] = base.split('-');
  const pascal = nameParts.map((p) => p.charAt(0).toUpperCase() + p.slice(1)).join('');
  return `${pascal}${timestamp}`;
}

describe('data-source migrations 注册完整性', () => {
  it('migrations 目录下每个迁移文件都已注册进 createDataSource，防止漏注册静默失效', () => {
    // vitest 的 SSR transform 注入 __dirname；tsconfig 为 CommonJS，不能用 import.meta
    const dir = join(__dirname, 'migrations');
    const files = readdirSync(dir).filter((f) => f.endsWith('.ts'));
    // test 文件不会放在 migrations 目录，*.ts 即迁移文件

    const ds = createDataSource('gmind_test');
    // options.migrations 允许 string[]（glob 路径）或类数组，这里按注册后的类形态断言
    const migrations = (ds.options.migrations ?? []) as unknown as Array<{ name?: string }>;
    const registered = migrations.map((m) => m.name ?? String(m));

    expect(files.length).toBeGreaterThan(0);
    expect(registered).toHaveLength(files.length);
    for (const f of files) {
      expect(registered).toContain(expectedClassName(f));
    }
  });
});
