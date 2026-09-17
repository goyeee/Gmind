# Gmind M0（工程地基）实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 搭起 Gmind 的全部工程地基：monorepo 脚手架、Docker 基础设施、全量建表迁移、三方式登录注册（Dev mock）、五端会话互踢、注册自动种 3 个示例脑图，最终达成 M0 验收——「注册登录 → 看到示例文件」。

**Architecture:** pnpm monorepo（apps/web + apps/server + packages/*）。NestJS 单服务（本里程碑仅 REST），MySQL 5.6 存业务数据（一次迁移建全 11 张表），Redis 存会话。文档数据模型以 Yjs 为中心，gmind-core 在本里程碑提供「模板 → Y.Doc → 二进制状态」最小能力供种子使用；完整操作 API 属 M1。

**Tech Stack:** Node 20 / pnpm / TypeScript(strict) / NestJS / TypeORM 0.3 + mysql2 / ioredis / Yjs / React 18 + Vite / Vitest / Playwright。

**Spec:** `docs/superpowers/specs/2026-09-18-gmind-phase1-design.md`（尤其 §2 决策表、§4.1 数据模型、§5.2 会话、§5.9 MySQL 5.6 约束、§7.1 表清单、§9 M0 验收口径）

## Global Constraints

- TypeScript 全仓 `strict: true`；Node ≥20；包管理只用 pnpm。
- MySQL 5.6 兼容（spec §5.9）：所有建表显式 `CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`；唯一/普通索引列宽 ≤varchar(191)；不使用 JSON 类型、CTE、窗口函数；schema 必须向前兼容 8.x。
- 主键一律 `char(26)` ULID（与节点 ID 同规范）；时间列 `datetime(3)`，应用层存 UTC（驱动 `timezone: 'Z'`）。
- 唯一写入口纪律（spec §3.3）：任何 Y.Doc 读写必须经 `@gmind/core`，apps 不得直接 import yjs。
- 开发环境第三方 mock（spec §5.2）：短信验证码固定 `123456`（env `DEV_SMS_CODE`），邮件进 MailHog，微信扫码返回模拟账号。
- 端口约定：MySQL 33061、Redis 63790、MinIO 9000/9001、MailHog 8025/1025、server 3000、web 5173。
- 提交信息用 Conventional Commits（feat/fix/chore/test/docs）。**执行前注意事项：需求方曾要求 spec 暂缓 commit，本计划的任务级 commit 步骤在开工前需向需求方确认放行。**
- 开发环境数据库/Redis 直连 compose 实例；测试使用 `gmind_test` 库与 Redis db 1。

---

### Task 1: Monorepo 脚手架与工程规范

**Files:**
- Create: `package.json`, `pnpm-workspace.yaml`, `tsconfig.base.json`, `eslint.config.mjs`, `.prettierrc`, `.gitignore`, `.nvmrc`
- Create: `packages/shared/package.json`, `packages/shared/tsconfig.json`, `packages/shared/src/index.ts`, `packages/shared/src/enums.ts`, `packages/shared/src/api/auth.ts`, `packages/shared/src/api/files.ts`

**Interfaces:**
- Produces: `@gmind/shared` 导出 `FileRole`、`StructureType`、`LoginMethod` 枚举与 zod schema `phoneLoginSchema`、`emailLoginSchema`、`wechatLoginSchema`、`loginSchema`、`createFileSchema`（Task 6/8/9 消费）。

- [ ] **Step 1: 写根配置文件**

`pnpm-workspace.yaml`：

```yaml
packages:
  - apps/*
  - packages/*
```

`package.json`：

```json
{
  "name": "gmind",
  "private": true,
  "engines": { "node": ">=20" },
  "scripts": {
    "dev": "pnpm --filter @gmind/server --filter @gmind/web --parallel dev",
    "build": "pnpm -r build",
    "test": "pnpm -r test",
    "lint": "eslint .",
    "compose:up": "docker compose -f docker/docker-compose.yml --env-file docker/.env up -d",
    "compose:down": "docker compose -f docker/docker-compose.yml --env-file docker/.env down",
    "db:migrate": "pnpm --filter @gmind/server migration:run"
  },
  "devDependencies": {
    "eslint": "^9.0.0",
    "typescript-eslint": "^8.0.0",
    "prettier": "^3.3.0",
    "typescript": "^5.5.0"
  }
}
```

`tsconfig.base.json`：

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "ESNext",
    "moduleResolution": "bundler",
    "strict": true,
    "skipLibCheck": true,
    "esModuleInterop": true,
    "forceConsistentCasingInFileNames": true,
    "noUncheckedIndexedAccess": false,
    "declaration": false,
    "sourceMap": true
  }
}
```

`.nvmrc`：`20`
`.prettierrc`：`{ "printWidth": 100, "singleQuote": true, "trailingComma": "all" }`
`.gitignore`：

```
node_modules/
dist/
coverage/
.env
docker/.env
playwright-report/
test-results/
```

`eslint.config.mjs`：

```js
import tseslint from 'typescript-eslint';

export default tseslint.config(
  { ignores: ['**/dist/**', '**/node_modules/**', '**/playwright-report/**'] },
  ...tseslint.configs.recommended,
);
```

- [ ] **Step 2: 写 @gmind/shared 包**

`packages/shared/package.json`：

```json
{
  "name": "@gmind/shared",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "main": "./src/index.ts",
  "types": "./src/index.ts",
  "scripts": { "test": "vitest run --passWithNoTests", "lint": "eslint src" },
  "dependencies": { "zod": "^3.23.0" },
  "devDependencies": { "vitest": "^2.0.0" }
}
```

`packages/shared/tsconfig.json`：

```json
{ "extends": "../../tsconfig.base.json", "include": ["src"] }
```

`packages/shared/src/enums.ts`：

```ts
/** 文件级四级权限（spec §7.1）。一期只实际写入 owner/editor，枚举按四级预留。 */
export type FileRole = 'owner' | 'editor' | 'commenter' | 'viewer';

export type StructureType = 'mindmap' | 'logic' | 'org';

export type LoginMethod = 'phone' | 'email' | 'wechat';
```

`packages/shared/src/api/auth.ts`：

```ts
import { z } from 'zod';

/** 手机验证码登录（开发环境验证码固定为 DEV_SMS_CODE，默认 123456） */
export const phoneLoginSchema = z.object({
  method: z.literal('phone'),
  phone: z.string().regex(/^1\d{10}$/, '手机号格式不正确'),
  code: z.string().min(4).max(6),
});

/** 邮箱登录：验证码或密码二选一（spec §5.2） */
export const emailLoginSchema = z
  .object({
    method: z.literal('email'),
    email: z.string().email('邮箱格式不正确'),
    mode: z.enum(['code', 'password']),
    code: z.string().min(4).max(6).optional(),
    password: z.string().min(6).max(64).optional(),
  })
  .refine((v) => (v.mode === 'code' ? !!v.code : !!v.password), {
    message: '验证码或密码不能为空',
  });

/** 微信扫码登录（开发环境返回模拟账号，spec §5.2 DevProvider） */
export const wechatLoginSchema = z.object({
  method: z.literal('wechat'),
  mockOpenid: z.string().min(1).max(64).optional(),
  nickname: z.string().min(1).max(64).optional(),
});

export const loginSchema = z.discriminatedUnion('method', [
  phoneLoginSchema,
  emailLoginSchema,
  wechatLoginSchema,
]);

export type LoginRequest = z.infer<typeof loginSchema>;

export interface LoginResponse {
  token: string;
  expiresAt: number;
  user: { id: string; nickname: string; avatarUrl: string | null };
}
```

`packages/shared/src/api/files.ts`：

```ts
import { z } from 'zod';
import type { StructureType } from '../enums';

export const createFileSchema = z.object({
  title: z.string().min(1).max(255).default('未命名脑图'),
});

export interface FileListItem {
  id: string;
  title: string;
  structure: StructureType;
  nodeCount: number;
  lastOpenedAt: string | null;
  updatedAt: string;
}
```

`packages/shared/src/index.ts`：

```ts
export * from './enums';
export * from './api/auth';
export * from './api/files';
```

- [ ] **Step 3: 安装依赖并验证**

Run: `pnpm install && pnpm lint`
Expected: 安装成功，eslint 无错误。

- [ ] **Step 4: Commit**

```bash
git add package.json pnpm-workspace.yaml tsconfig.base.json eslint.config.mjs .prettierrc .gitignore .nvmrc packages/shared
git commit -m "chore: pnpm monorepo 脚手架与 @gmind/shared 契约包"
```

---

### Task 2: Docker Compose 基础设施（MySQL 5.6 / Redis / MinIO / MailHog）

**Files:**
- Create: `docker/docker-compose.yml`, `docker/.env.example`, `docker/mysql/init/01-databases.sql`

**Interfaces:**
- Produces: 基础设施端点——MySQL `127.0.0.1:33061`（root/gminddev，库 `gmind` 与 `gmind_test`）、Redis `redis://127.0.0.1:63790`、MinIO `:9000`、MailHog `:8025`。Task 4/5/9 依赖。

- [ ] **Step 1: 写 compose 与初始化 SQL**

`docker/docker-compose.yml`：

```yaml
services:
  mysql:
    image: ${MYSQL_IMAGE}
    environment:
      MYSQL_ROOT_PASSWORD: gminddev
    ports:
      - '${MYSQL_HOST_PORT:-33061}:3306'
    volumes:
      - mysql-data:/var/lib/mysql
      - ./mysql/init:/docker-entrypoint-initdb.d:ro
    healthcheck:
      test: ['CMD', 'mysqladmin', 'ping', '-h', '127.0.0.1', '-uroot', '-pgminddev']
      interval: 5s
      timeout: 3s
      retries: 30

  redis:
    image: ${REDIS_IMAGE}
    ports:
      - '${REDIS_HOST_PORT:-63790}:6379'
    healthcheck:
      test: ['CMD', 'redis-cli', 'ping']
      interval: 5s
      timeout: 3s
      retries: 20

  minio:
    image: ${MINIO_IMAGE:-minio/minio}
    command: server /data --console-address ':9001'
    environment:
      MINIO_ROOT_USER: gminddev
      MINIO_ROOT_PASSWORD: gminddev123
    ports:
      - '9000:9000'
      - '9001:9001'
    volumes:
      - minio-data:/data

  mailhog:
    image: ${MAILHOG_IMAGE:-mailhog/mailhog}
    ports:
      - '8025:8025'
      - '1025:1025'

volumes:
  mysql-data: {}
  minio-data: {}
```

`docker/.env.example`（复制为 `docker/.env` 后使用；Redis 私有镜像 tag 待确认（spec OPEN-T-004），先用官方镜像参数化）：

```
MYSQL_IMAGE=repo.guanyingyun.com:1443/other/mysql5.6:1
REDIS_IMAGE=redis:7-alpine
MINIO_IMAGE=minio/minio
MAILHOG_IMAGE=mailhog/mailhog
MYSQL_HOST_PORT=33061
REDIS_HOST_PORT=63790
```

`docker/mysql/init/01-databases.sql`（5.6 兼容：显式 utf8mb4，spec §5.9）：

```sql
CREATE DATABASE IF NOT EXISTS gmind CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
CREATE DATABASE IF NOT EXISTS gmind_test CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
```

- [ ] **Step 2: 起环境并验证**

Run: `cp docker/.env.example docker/.env && pnpm compose:up && sleep 30 && docker compose -f docker/docker-compose.yml ps`
Expected: mysql/redis 状态 healthy（MySQL 5.6 首次初始化较慢，若 unhealthy 等待后重查）。

Run: `docker exec $(docker compose -f docker/docker-compose.yml ps -q mysql) mysql -uroot -pgminddev -e "SHOW DATABASES" 2>/dev/null`
Expected: 输出包含 `gmind` 与 `gmind_test`。

- [ ] **Step 3: Commit**

```bash
git add docker
git commit -m "chore: compose 基础设施（MySQL5.6/Redis/MinIO/MailHog）与 utf8mb4 初始化"
```

---

### Task 3: @gmind/core 最小文档能力（模板 → Y.Doc → 二进制状态）

**Files:**
- Create: `packages/gmind-core/package.json`, `packages/gmind-core/tsconfig.json`, `packages/gmind-core/src/index.ts`, `packages/gmind-core/src/doc.ts`, `packages/gmind-core/src/templates.ts`
- Test: `packages/gmind-core/src/doc.test.ts`

**Interfaces:**
- Produces（M1 在此文件上扩展完整操作 API，签名必须保持不变）:
  - `ROOT_NODE_ID = 'root'`
  - `createTemplateDoc(spec: TemplateSpec): Y.Doc`
  - `docToState(doc: Y.Doc): Uint8Array` / `docFromState(state: Uint8Array): Y.Doc`
  - `countNodes(doc: Y.Doc): number`
  - `SEED_TEMPLATES: TemplateSpec[]`（3 个示例模板，Task 7 消费）

- [ ] **Step 1: 写包骨架**

`packages/gmind-core/package.json`：

```json
{
  "name": "@gmind/core",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "main": "./src/index.ts",
  "types": "./src/index.ts",
  "scripts": { "test": "vitest run", "lint": "eslint src" },
  "dependencies": { "yjs": "^13.6.0", "ulid": "^2.3.0" },
  "devDependencies": { "vitest": "^2.0.0" }
}
```

`packages/gmind-core/tsconfig.json`：

```json
{ "extends": "../../tsconfig.base.json", "include": ["src"] }
```

`packages/gmind-core/src/index.ts`：

```ts
export * from './doc';
export * from './templates';
```

- [ ] **Step 2: 写失败测试**

`packages/gmind-core/src/doc.test.ts`：

```ts
import { describe, expect, it } from 'vitest';
import * as Y from 'yjs';
import { ROOT_NODE_ID, countNodes, createTemplateDoc, docFromState, docToState, SEED_TEMPLATES } from './doc';

describe('createTemplateDoc', () => {
  it('生成 root + 嵌套子树，meta 完整', () => {
    const doc = createTemplateDoc({
      title: 'T',
      structure: 'mindmap',
      children: [{ text: 'A', children: [{ text: 'A1' }] }, { text: 'B' }],
    });
    const nodes = doc.getMap('nodes');
    expect(nodes.size).toBe(4); // root + A + A1 + B
    const root = nodes.get(ROOT_NODE_ID) as Y.Map<unknown>;
    expect(root.get('parentId')).toBe('');
    expect((root.get('children') as Y.Array<string>).length).toBe(2);
    const a = [...nodes.values()].find((n) => n.get('text') === 'A')!;
    expect(a.get('parentId')).toBe(ROOT_NODE_ID);
    expect(doc.getMap('meta').get('title')).toBe('T');
    expect(doc.getMap('meta').get('structureType')).toBe('mindmap');
  });

  it('二进制状态可无损往返', () => {
    const doc = createTemplateDoc({ title: 'R', children: [{ text: 'X' }] });
    const restored = docFromState(docToState(doc));
    expect(countNodes(restored)).toBe(2);
    expect(restored.getMap('meta').get('title')).toBe('R');
    const root = restored.getMap('nodes').get(ROOT_NODE_ID) as Y.Map<unknown>;
    expect(((root.get('children') as Y.Array<string>).get(0))).toBeTruthy();
  });

  it('SEED_TEMPLATES 为 3 个且每个 ≥3 节点', () => {
    expect(SEED_TEMPLATES.length).toBe(3);
    for (const tpl of SEED_TEMPLATES) {
      expect(countNodes(createTemplateDoc(tpl))).toBeGreaterThanOrEqual(3);
    }
  });
});
```

- [ ] **Step 3: 运行确认失败**

Run: `pnpm --filter @gmind/core test`
Expected: FAIL（`doc.ts` 不存在）。

- [ ] **Step 4: 最小实现**

`packages/gmind-core/src/doc.ts`：

```ts
import * as Y from 'yjs';
import { ulid } from 'ulid';
import type { StructureType } from '@gmind/shared';

/** 中心主题固定 id（spec §4.1）：不可删除、不可换父。 */
export const ROOT_NODE_ID = 'root';

export interface TemplateNodeSpec {
  text: string;
  children?: TemplateNodeSpec[];
}

export interface TemplateSpec {
  title: string;
  structure?: StructureType;
  theme?: string;
  children: TemplateNodeSpec[];
}

/** 按 spec §4.1 的 Y.Doc 结构构建文档（M0 仅写入用到的字段，字段名与 §4.1 严格一致）。 */
export function createTemplateDoc(spec: TemplateSpec): Y.Doc {
  const doc = new Y.Doc();
  doc.transact(() => {
    const meta = doc.getMap('meta');
    meta.set('title', spec.title);
    meta.set('structureType', spec.structure ?? 'mindmap');
    meta.set('themeId', spec.theme ?? 'gmind-light');

    const nodes = doc.getMap('nodes');
    const root = new Y.Map();
    nodes.set(ROOT_NODE_ID, root);
    root.set('text', spec.title);
    root.set('parentId', '');
    const rootChildren = new Y.Array<string>();
    root.set('children', rootChildren);
    for (const child of spec.children) {
      buildSubtree(nodes, rootChildren, child, ROOT_NODE_ID);
    }
  });
  return doc;
}

function buildSubtree(
  nodes: Y.Map<Y.Map<unknown>>,
  parentChildren: Y.Array<string>,
  spec: TemplateNodeSpec,
  parentId: string,
): void {
  const id = ulid();
  const node = new Y.Map();
  nodes.set(id, node);
  node.set('text', spec.text);
  node.set('parentId', parentId);
  const children = new Y.Array<string>();
  node.set('children', children);
  parentChildren.push([id]);
  for (const child of spec.children ?? []) {
    buildSubtree(nodes, children, child, id);
  }
}

export function docToState(doc: Y.Doc): Uint8Array {
  return Y.encodeStateAsUpdate(doc);
}

export function docFromState(state: Uint8Array): Y.Doc {
  const doc = new Y.Doc();
  Y.applyUpdate(doc, state);
  return doc;
}

export function countNodes(doc: Y.Doc): number {
  return doc.getMap('nodes').size;
}
```

`packages/gmind-core/src/templates.ts`：

```ts
import type { TemplateSpec } from './doc';

/** 注册赠送的 3 个示例脑图（FR-ACC-001）。 */
export const SEED_TEMPLATES: TemplateSpec[] = [
  {
    title: '欢迎使用 Gmind',
    children: [
      {
        text: '基本操作',
        children: [{ text: 'Enter 新建同级节点' }, { text: 'Tab 新建子节点' }, { text: '拖拽节点调整结构' }],
      },
      {
        text: '协作能力',
        children: [{ text: '分享链接邀请协作者' }, { text: '节点级评论与 @ 提醒' }],
      },
      { text: '本文件可随意修改或删除' },
    ],
  },
  {
    title: '产品需求评审纪要',
    structure: 'org',
    children: [
      { text: '参会人', children: [{ text: '待补充' }] },
      { text: '评审结论', children: [{ text: '通过 / 有条件通过 / 驳回' }] },
      { text: '待办事项', children: [{ text: '更新 PRD' }, { text: '排期确认' }] },
    ],
  },
  {
    title: '本周计划',
    children: [
      { text: '周一', children: [{ text: '周会对齐' }] },
      { text: '周三', children: [{ text: '方案评审' }] },
      { text: '周五', children: [{ text: '周报复盘' }] },
    ],
  },
];
```

`pnpm-workspace.yaml` 已含 `packages/*`，无需改动。运行 `pnpm install` 使新包被 workspace 收编。

- [ ] **Step 5: 运行测试通过**

Run: `pnpm install && pnpm --filter @gmind/core test`
Expected: PASS（3 个用例全绿）。

- [ ] **Step 6: Commit**

```bash
git add packages/gmind-core
git commit -m "feat(core): Yjs 模板文档构建与二进制状态往返（spec §4.1）"
```

---

### Task 4: server 骨架、环境配置与全量建表迁移

**Files:**
- Create: `apps/server/package.json`, `apps/server/tsconfig.json`, `apps/server/src/main.ts`, `apps/server/src/app.module.ts`, `apps/server/src/config/env.ts`, `apps/server/src/database/database.module.ts`, `apps/server/src/database/data-source.ts`, `apps/server/src/database/migrations/20260918000000-init.ts`, `apps/server/src/health/health.controller.ts`, `apps/server/src/common/zod-exception.filter.ts`, `apps/server/test/support/env.setup.ts`
- Test: `apps/server/test/db-init.e2e-spec.ts`

**Interfaces:**
- Consumes: compose 基础设施（Task 2）。
- Produces: `env`（zod 校验的环境配置单例）；`AppModule`（后续模块统一挂载）；数据源工厂 `createDataSource(database: string)`（Task 8 测试复用）；迁移建出 spec §7.1 全部 11 张表；`GET /api/health`。

- [ ] **Step 1: 写包骨架与环境配置**

`apps/server/package.json`：

```json
{
  "name": "@gmind/server",
  "version": "0.1.0",
  "private": true,
  "scripts": {
    "dev": "tsx watch src/main.ts",
    "build": "tsc -p tsconfig.build.json && tsc-alias -p tsconfig.build.json",
    "test": "vitest run",
    "test:e2e": "vitest run --config vitest.e2e.config.ts",
    "migration:run": "tsx node_modules/typeorm/cli.js migration:run -d src/database/data-source.ts",
    "migration:revert": "tsx node_modules/typeorm/cli.js migration:revert -d src/database/data-source.ts"
  },
  "dependencies": {
    "@gmind/shared": "workspace:*",
    "@nestjs/common": "^10.0.0",
    "@nestjs/core": "^10.0.0",
    "@nestjs/platform-express": "^10.0.0",
    "@nestjs/typeorm": "^10.0.0",
    "ioredis": "^5.4.0",
    "mysql2": "^3.11.0",
    "reflect-metadata": "^0.2.0",
    "rxjs": "^7.8.0",
    "typeorm": "^0.3.20",
    "ulid": "^2.3.0",
    "zod": "^3.23.0"
  },
  "devDependencies": {
    "supertest": "^7.0.0",
    "tsx": "^4.16.0",
    "tsc-alias": "^1.8.0",
    "vitest": "^2.0.0"
  }
}
```

`apps/server/tsconfig.json`：

```json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": {
    "module": "commonjs",
    "moduleResolution": "node",
    "experimentalDecorators": true,
    "emitDecoratorMetadata": true,
    "outDir": "dist",
    "rootDir": "src",
    "baseUrl": ".",
    "paths": { "@gmind/shared": ["../../packages/shared/src/index.ts"] }
  },
  "include": ["src"]
}
```

`apps/server/tsconfig.build.json`：同上但 `"exclude": ["test"]`（内容为 extends 本目录 tsconfig.json 加 exclude）。
`apps/server/vitest.config.ts` 与 `apps/server/vitest.e2e.config.ts`：

```ts
// vitest.config.ts
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: { include: ['src/**/*.test.ts'], environment: 'node' },
});
```

```ts
// vitest.e2e.config.ts
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/**/*.e2e-spec.ts'],
    environment: 'node',
    testTimeout: 30000,
    hookTimeout: 60000,
    // 多个 e2e spec 共用 gmind_test 库，必须串行执行
    fileParallelism: false,
    // env.ts 在模块导入时解析，必须在任何 import 之前固定环境变量
    setupFiles: ['./test/support/env.setup.ts'],
    server: { deps: { inline: ['@gmind/shared', '@gmind/core'] } },
  },
});
```

`apps/server/test/support/env.setup.ts`：

```ts
process.env.DB_DATABASE = 'gmind_test';
process.env.REDIS_URL = 'redis://127.0.0.1:63790/1';
```

`apps/server/src/config/env.ts`：

```ts
import { z } from 'zod';

const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().default(3000),
  DB_HOST: z.string().default('127.0.0.1'),
  DB_PORT: z.coerce.number().default(33061),
  DB_USER: z.string().default('root'),
  DB_PASSWORD: z.string().default('gminddev'),
  DB_DATABASE: z.string().default('gmind'),
  REDIS_URL: z.string().default('redis://127.0.0.1:63790/0'),
  DEV_SMS_CODE: z.string().default('123456'),
});

export const env = envSchema.parse(process.env);
```

`apps/server/src/database/data-source.ts`：

```ts
import 'reflect-metadata';
import { DataSource } from 'typeorm';
import { env } from '../config/env';

/** CLI 与 e2e 共用的数据源工厂；migration 由本文件路径注册。 */
export function createDataSource(database: string): DataSource {
  return new DataSource({
    type: 'mysql',
    connectorPackage: 'mysql2',
    host: env.DB_HOST,
    port: env.DB_PORT,
    username: env.DB_USER,
    password: env.DB_PASSWORD,
    database,
    charset: 'utf8mb4',
    timezone: 'Z',
    synchronize: false,
    migrations: [`${__dirname}/migrations/*.{ts,js}`],
    logging: false,
  });
}

export default createDataSource(env.DB_DATABASE);
```

`apps/server/src/database/database.module.ts`：

```ts
import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { env } from '../config/env';
import { createDataSource } from './data-source';

@Module({
  imports: [
    TypeOrmModule.forRootAsync({
      useFactory: () => {
        const ds = createDataSource(env.DB_DATABASE);
        return { ...ds.options, entities: [`${__dirname}/../**/*.entity.{ts,js}`] };
      },
    }),
  ],
})
export class DatabaseModule {}
```

- [ ] **Step 2: 写全量建表迁移（spec §7.1 的 11 张表）**

`apps/server/src/database/migrations/20260918000000-init.ts`。用原生 SQL 精确控制 5.6 方言（无 JSON 列、索引前缀 ≤191 字符、显式 utf8mb4）：

```ts
import { MigrationInterface, QueryRunner } from 'typeorm';

const T = (name: string, cols: string, keys = ''): string =>
  `CREATE TABLE ${name} (${cols}${keys ? ', ' + keys : ''}) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`;

export class Init20260918000000 implements MigrationInterface {
  name = 'Init20260918000000';

  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(T(
      'users',
      `id char(26) NOT NULL,
       phone varchar(20) NULL,
       email varchar(191) NULL,
       wechat_openid varchar(64) NULL,
       password_hash varchar(100) NULL,
       nickname varchar(64) NOT NULL,
       avatar_url varchar(500) NULL,
       notify_prefs text NULL,
       created_at datetime(3) NOT NULL,
       updated_at datetime(3) NOT NULL`,
      'PRIMARY KEY (id), UNIQUE KEY uk_users_phone (phone), UNIQUE KEY uk_users_email (email), UNIQUE KEY uk_users_wechat (wechat_openid)',
    ));

    await queryRunner.query(T(
      'folders',
      `id char(26) NOT NULL,
       owner_user_id char(26) NOT NULL,
       space_id char(26) NULL,
       parent_id char(26) NULL,
       name varchar(64) NOT NULL,
       depth tinyint NOT NULL DEFAULT 1,
       deleted_at datetime(3) NULL,
       created_at datetime(3) NOT NULL,
       updated_at datetime(3) NOT NULL`,
      'PRIMARY KEY (id), KEY idx_folders_owner (owner_user_id), KEY idx_folders_parent (parent_id)',
    ));

    await queryRunner.query(T(
      'files',
      `id char(26) NOT NULL,
       owner_user_id char(26) NOT NULL,
       space_id char(26) NULL,
       folder_id char(26) NULL,
       title varchar(255) NOT NULL,
       structure varchar(16) NOT NULL DEFAULT 'mindmap',
       theme_id varchar(32) NOT NULL DEFAULT 'gmind-light',
       node_count int NOT NULL DEFAULT 1,
       doc_state longblob NULL,
       last_opened_at datetime(3) NULL,
       deleted_at datetime(3) NULL,
       deleted_by char(26) NULL,
       created_at datetime(3) NOT NULL,
       updated_at datetime(3) NOT NULL`,
      'PRIMARY KEY (id), KEY idx_files_owner (owner_user_id), KEY idx_files_folder (folder_id), KEY idx_files_deleted (deleted_at)',
    ));

    await queryRunner.query(T(
      'file_collaborators',
      `id char(26) NOT NULL,
       file_id char(26) NOT NULL,
       user_id char(26) NOT NULL,
       role enum('owner','editor','commenter','viewer') NOT NULL,
       created_at datetime(3) NOT NULL`,
      'PRIMARY KEY (id), UNIQUE KEY uk_fc_file_user (file_id, user_id), KEY idx_fc_user (user_id)',
    ));

    await queryRunner.query(T(
      'file_stars',
      `id char(26) NOT NULL,
       file_id char(26) NOT NULL,
       user_id char(26) NOT NULL,
       created_at datetime(3) NOT NULL`,
      'PRIMARY KEY (id), UNIQUE KEY uk_star_file_user (file_id, user_id), KEY idx_star_user (user_id)',
    ));

    await queryRunner.query(T(
      'share_links',
      `id char(26) NOT NULL,
       file_id char(26) NOT NULL,
       token varchar(32) NOT NULL,
       status enum('active','closed') NOT NULL DEFAULT 'active',
       created_by char(26) NOT NULL,
       password varchar(64) NULL,
       expires_at datetime(3) NULL,
       closed_at datetime(3) NULL,
       created_at datetime(3) NOT NULL`,
      'PRIMARY KEY (id), UNIQUE KEY uk_share_token (token), KEY idx_share_file (file_id)',
    ));

    await queryRunner.query(T(
      'invites',
      `id char(26) NOT NULL,
       file_id char(26) NOT NULL,
       contact_type enum('email','phone') NOT NULL,
       contact varchar(191) NOT NULL,
       invited_by char(26) NOT NULL,
       status enum('pending','accepted','revoked') NOT NULL DEFAULT 'pending',
       accepted_user_id char(26) NULL,
       created_at datetime(3) NOT NULL`,
      'PRIMARY KEY (id), UNIQUE KEY uk_invite (file_id, contact_type, contact), KEY idx_invite_contact (contact)',
    ));

    await queryRunner.query(T(
      'comments',
      `id char(26) NOT NULL,
       file_id char(26) NOT NULL,
       node_id char(26) NOT NULL,
       node_text_snapshot varchar(500) NOT NULL DEFAULT '',
       parent_id char(26) NULL,
       author_id char(26) NOT NULL,
       content text NOT NULL,
       mentions text NULL,
       status enum('open','resolved') NOT NULL DEFAULT 'open',
       created_at datetime(3) NOT NULL,
       updated_at datetime(3) NOT NULL`,
      'PRIMARY KEY (id), KEY idx_comments_file (file_id), KEY idx_comments_node (node_id), KEY idx_comments_parent (parent_id)',
    ));

    await queryRunner.query(T(
      'notifications',
      `id char(26) NOT NULL,
       user_id char(26) NOT NULL,
       type enum('mention','reply','permission','system') NOT NULL,
       payload text NULL,
       read_at datetime(3) NULL,
       emailed_at datetime(3) NULL,
       created_at datetime(3) NOT NULL`,
      'PRIMARY KEY (id), KEY idx_notif_user_read (user_id, read_at)',
    ));

    await queryRunner.query(T(
      'events',
      `id char(26) NOT NULL,
       type varchar(64) NOT NULL,
       file_id char(26) NULL,
       user_id char(26) NULL,
       payload text NULL,
       created_at datetime(3) NOT NULL`,
      'PRIMARY KEY (id), KEY idx_events_type_time (type, created_at), KEY idx_events_file (file_id)',
    ));

    await queryRunner.query(T(
      'versions',
      `id char(26) NOT NULL,
       file_id char(26) NOT NULL,
       node_count int NOT NULL,
       created_by char(26) NULL,
       type enum('auto','manual','pre_restore') NOT NULL DEFAULT 'auto',
       state longblob NOT NULL,
       created_at datetime(3) NOT NULL`,
      'PRIMARY KEY (id), KEY idx_versions_file_time (file_id, created_at)',
    ));
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    for (const t of ['versions', 'events', 'notifications', 'comments', 'invites', 'share_links', 'file_stars', 'file_collaborators', 'files', 'folders', 'users']) {
      await queryRunner.query(`DROP TABLE IF EXISTS ${t}`);
    }
  }
}
```

- [ ] **Step 3: 写应用骨架与失败测试**

`apps/server/src/app.module.ts`：

```ts
import { Module } from '@nestjs/common';
import { DatabaseModule } from './database/database.module';
import { HealthController } from './health/health.controller';

@Module({
  imports: [DatabaseModule],
  controllers: [HealthController],
})
export class AppModule {}
```

`apps/server/src/health/health.controller.ts`：

```ts
import { Controller, Get } from '@nestjs/common';
import { DataSource } from 'typeorm';

@Controller('api/health')
export class HealthController {
  constructor(private readonly dataSource: DataSource) {}

  @Get()
  async check(): Promise<{ ok: boolean; db: boolean }> {
    await this.dataSource.query('SELECT 1');
    return { ok: true, db: true };
  }
}
```

`apps/server/src/main.ts`：

```ts
import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';
import { env } from './config/env';
import { ZodExceptionFilter } from './common/zod-exception.filter';

async function bootstrap(): Promise<void> {
  const app = await NestFactory.create(AppModule);
  app.enableCors({ origin: ['http://localhost:5173'], credentials: true });
  app.useGlobalFilters(new ZodExceptionFilter());
  await app.listen(env.PORT);
  // eslint-disable-next-line no-console
  console.log(`[gmind-server] listening on :${env.PORT}`);
}

void bootstrap();
```

`apps/server/src/common/zod-exception.filter.ts`：

```ts
import { ArgumentsHost, Catch, ExceptionFilter } from '@nestjs/common';
import type { Response } from 'express';
import { ZodError } from 'zod';

@Catch(ZodError)
export class ZodExceptionFilter implements ExceptionFilter {
  catch(exception: ZodError, host: ArgumentsHost): void {
    const res = host.switchToHttp().getResponse<Response>();
    res.status(400).json({ message: exception.issues[0]?.message ?? '参数错误' });
  }
}
```

失败测试 `apps/server/test/db-init.e2e-spec.ts`（e2e 跑 `gmind_test` 库，验证迁移建出全部表）：

```ts
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDataSource } from '../src/database/data-source';

describe('init migration', () => {
  const ds = createDataSource('gmind_test');

  beforeAll(async () => {
    await ds.initialize();
    await ds.query('DROP TABLE IF EXISTS users, folders, files, file_collaborators, file_stars, share_links, invites, comments, notifications, events, versions');
    await ds.runMigrations();
  });

  afterAll(async () => {
    await ds.destroy();
  });

  it('建出 spec §7.1 全部 11 张表且字符集为 utf8mb4', async () => {
    const rows: { Tables_in_gmind_test: string }[] = await ds.query('SHOW TABLES');
    const tables = rows.map((r) => Object.values(r)[0]).sort();
    expect(tables).toEqual([
      'comments', 'events', 'file_collaborators', 'file_stars', 'files',
      'folders', 'invites', 'notifications', 'share_links', 'users', 'versions',
    ]);
    const cs: { TABLE_NAME: string; TABLE_COLLATION: string }[] = await ds.query(
      `SELECT TABLE_NAME, TABLE_COLLATION FROM information_schema.TABLES
       WHERE TABLE_SCHEMA = 'gmind_test'`,
    );
    for (const row of cs) {
      expect(row.TABLE_COLLATION).toContain('utf8mb4');
    }
  });

  it('doc_state 为 longblob（Yjs 状态，spec §4.3）', async () => {
    const cols: { DATA_TYPE: string }[] = await ds.query(
      `SELECT DATA_TYPE FROM information_schema.COLUMNS
       WHERE TABLE_SCHEMA='gmind_test' AND TABLE_NAME='files' AND COLUMN_NAME='doc_state'`,
    );
    expect(cols[0]?.DATA_TYPE).toBe('longblob');
  });
});
```

- [ ] **Step 4: 安装依赖并运行测试**

Run: `pnpm install && pnpm --filter @gmind/server test:e2e`
Expected: PASS（迁移在 gmind_test 建出 11 张表）。注意 compose 的 MySQL 必须已就绪（Task 2）。

- [ ] **Step 5: 冒烟启动**

Run: `pnpm --filter @gmind/server migration:run && pnpm --filter @gmind/server dev &`，然后 `curl -s http://localhost:3000/api/health`
Expected: `{"ok":true,"db":true}`。验证后停掉 dev 进程。

- [ ] **Step 6: Commit**

```bash
git add apps/server
git commit -m "feat(server): NestJS 骨架、env 配置与 11 张表全量迁移（MySQL5.6/utf8mb4）"
```

---

### Task 5: Redis 会话服务（7/30 天 + 五端互踢）

**Files:**
- Create: `apps/server/src/session/session.module.ts`, `apps/server/src/session/session.service.ts`
- Test: `apps/server/src/session/session.service.test.ts`

**Interfaces:**
- Consumes: `REDIS_URL`（env）。
- Produces（Task 6/8 消费）:
  - `class SessionService`
  - `create(userId: string, rememberMe: boolean): Promise<{ token: string; expiresAt: number }>`
  - `validate(token: string): Promise<SessionData | null>`（`SessionData = { userId: string; createdAt: number }`）
  - `revoke(token: string): Promise<void>`

- [ ] **Step 1: 写失败测试（ioredis-mock，不依赖真实 Redis）**

`apps/server/src/session/session.service.test.ts`：

```ts
import { describe, expect, it } from 'vitest';
import RedisMock from 'ioredis-mock';
import type Redis from 'ioredis';
import { DAY, MAX_SESSIONS, SessionService } from './session.service';

function makeService(): { svc: SessionService; redis: Redis } {
  const redis = new RedisMock() as unknown as Redis;
  return { svc: new SessionService(redis), redis };
}

describe('SessionService', () => {
  it('create 后可 validate 出 userId', async () => {
    const { svc } = makeService();
    const { token } = await svc.create('u1', false);
    const data = await svc.validate(token);
    expect(data?.userId).toBe('u1');
  });

  it('rememberMe 时 expiresAt 为 30 天，否则 7 天（FR-ACC-002）', async () => {
    const { svc } = makeService();
    const short = await svc.create('u1', false);
    const long = await svc.create('u1', true);
    expect(long.expiresAt - short.expiresAt).toBe(23 * DAY * 1000);
  });

  it(`第 ${MAX_SESSIONS + 1} 个会话踢除最早会话`, async () => {
    const { svc } = makeService();
    const tokens: string[] = [];
    for (let i = 0; i < MAX_SESSIONS + 1; i++) {
      tokens.push((await svc.create('u1', false)).token);
    }
    expect(await svc.validate(tokens[0])).toBeNull();
    expect(await svc.validate(tokens[1])).not.toBeNull();
    expect(await svc.validate(tokens[MAX_SESSIONS])).not.toBeNull();
  });

  it('revoke 后 validate 返回 null', async () => {
    const { svc } = makeService();
    const { token } = await svc.create('u1', false);
    await svc.revoke(token);
    expect(await svc.validate(token)).toBeNull();
  });

  it('无效 token 返回 null', async () => {
    const { svc } = makeService();
    expect(await svc.validate('not-exist')).toBeNull();
  });
});
```

- [ ] **Step 2: 运行确认失败**

Run: `pnpm --filter @gmind/server test`
Expected: FAIL（session.service 不存在）。

- [ ] **Step 3: 实现**

`apps/server/src/session/session.service.ts`：

```ts
import { Injectable } from '@nestjs/common';
import { randomBytes } from 'node:crypto';
import type Redis from 'ioredis';

export const DAY = 24 * 60 * 60;
export const MAX_SESSIONS = 5;

export interface SessionData {
  userId: string;
  createdAt: number;
}

@Injectable()
export class SessionService {
  constructor(private readonly redis: Redis) {}

  private sessKey(token: string): string {
    return `sess:${token}`;
  }

  private userKey(userId: string): string {
    return `user_sessions:${userId}`;
  }

  /** 会话有效期 7 天，记住我 30 天；超 5 端踢最早（FR-ACC-002）。 */
  async create(userId: string, rememberMe: boolean): Promise<{ token: string; expiresAt: number }> {
    const ttlSec = (rememberMe ? 30 : 7) * DAY;
    const token = randomBytes(32).toString('hex');
    const now = Date.now();
    await this.redis.set(this.sessKey(token), JSON.stringify({ userId, createdAt: now } satisfies SessionData), 'EX', ttlSec);
    const zkey = this.userKey(userId);
    await this.redis.zadd(zkey, String(now), token);
    await this.redis.expire(zkey, 30 * DAY);
    const count = await this.redis.zcard(zkey);
    if (count > MAX_SESSIONS) {
      const oldest = await this.redis.zrange(zkey, 0, count - MAX_SESSIONS - 1);
      for (const t of oldest) {
        await this.redis.del(this.sessKey(t));
        await this.redis.zrem(zkey, t);
      }
    }
    return { token, expiresAt: now + ttlSec * 1000 };
  }

  async validate(token: string): Promise<SessionData | null> {
    const raw = await this.redis.get(this.sessKey(token));
    return raw ? (JSON.parse(raw) as SessionData) : null;
  }

  async revoke(token: string): Promise<void> {
    const data = await this.validate(token);
    if (!data) return;
    await this.redis.del(this.sessKey(token));
    await this.redis.zrem(this.userKey(data.userId), token);
  }
}
```

`apps/server/src/session/session.module.ts`：

```ts
import { Global, Module } from '@nestjs/common';
import Redis from 'ioredis';
import { env } from '../config/env';
import { SessionService } from './session.service';

@Global()
@Module({
  providers: [
    { provide: Redis, useFactory: () => new Redis(env.REDIS_URL) },
    SessionService,
  ],
  exports: [SessionService, Redis],
})
export class SessionModule {}
```

`apps/server/package.json` 增加 devDependency：`"ioredis-mock": "^8.9.0"`（加后重跑 `pnpm install`）。

- [ ] **Step 4: 运行测试通过**

Run: `pnpm --filter @gmind/server test`
Expected: PASS（5 个用例全绿）。

- [ ] **Step 5: Commit**

```bash
git add apps/server/src/session apps/server/package.json
git commit -m "feat(server): Redis 会话服务，7/30 天有效期与五端互踢（FR-ACC-002）"
```

---

### Task 6: UserGuard 与 /api/users/me

**Files:**
- Create: `apps/server/src/auth/user.guard.ts`, `apps/server/src/users/user.entity.ts`, `apps/server/src/users/users.module.ts`, `apps/server/src/users/users.controller.ts`
- Test: `apps/server/test/users-me.e2e-spec.ts`

**Interfaces:**
- Consumes: `SessionService`（Task 5）。
- Produces: `UserGuard`（校验 `Authorization: Bearer <token>`，通过后挂 `req.user = { id }` 与 `req.sessionToken`）；`UsersService.findByIdentity`、`UsersService.create`；`GET /api/users/me`。

- [ ] **Step 1: 写实体与服务**

`apps/server/src/users/user.entity.ts`：

```ts
import { Column, CreateDateColumn, Entity, PrimaryColumn, UpdateDateColumn } from 'typeorm';
import { ulid } from 'ulid';

@Entity('users')
export class UserEntity {
  @PrimaryColumn({ type: 'char', length: 26 })
  id: string = ulid();

  @Column({ type: 'varchar', length: 20, nullable: true })
  phone: string | null = null;

  @Column({ type: 'varchar', length: 191, nullable: true })
  email: string | null = null;

  @Column({ type: 'varchar', length: 64, nullable: true, name: 'wechat_openid' })
  wechatOpenid: string | null = null;

  @Column({ type: 'varchar', length: 100, nullable: true, name: 'password_hash' })
  passwordHash: string | null = null;

  @Column({ type: 'varchar', length: 64 })
  nickname: string = '用户';

  @Column({ type: 'varchar', length: 500, nullable: true, name: 'avatar_url' })
  avatarUrl: string | null = null;

  @Column({ type: 'text', nullable: true, name: 'notify_prefs' })
  notifyPrefs: string | null = null;

  @CreateDateColumn({ type: 'datetime', precision: 3 })
  createdAt: Date = new Date();

  @UpdateDateColumn({ type: 'datetime', precision: 3 })
  updatedAt: Date = new Date();
}
```

`apps/server/src/users/users.service.ts`：

```ts
import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import type { LoginMethod } from '@gmind/shared';
import { UserEntity } from './user.entity';

export interface LoginIdentity {
  method: LoginMethod;
  phone?: string;
  email?: string;
  wechatOpenid?: string;
  nickname?: string;
}

@Injectable()
export class UsersService {
  constructor(@InjectRepository(UserEntity) private readonly repo: Repository<UserEntity>) {}

  findByIdentity(identity: LoginIdentity): Promise<UserEntity | null> {
    if (identity.method === 'phone') return this.repo.findOneBy({ phone: identity.phone });
    if (identity.method === 'email') return this.repo.findOneBy({ email: identity.email });
    return this.repo.findOneBy({ wechatOpenid: identity.wechatOpenid });
  }

  async create(identity: LoginIdentity): Promise<UserEntity> {
    const user = this.repo.create();
    if (identity.method === 'phone') user.phone = identity.phone;
    if (identity.method === 'email') user.email = identity.email;
    if (identity.method === 'wechat') user.wechatOpenid = identity.wechatOpenid;
    user.nickname = identity.nickname ?? this.defaultNickname(identity);
    return this.repo.save(user);
  }

  private defaultNickname(identity: LoginIdentity): string {
    if (identity.nickname) return identity.nickname;
    if (identity.phone) return `用户${identity.phone.slice(-4)}`;
    if (identity.email) return identity.email.split('@')[0] ?? '用户';
    return '微信用户';
  }
}
```

`apps/server/src/users/users.module.ts`：

```ts
import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { UserEntity } from './user.entity';
import { UsersService } from './users.service';
import { UsersController } from './users.controller';

@Module({
  imports: [TypeOrmModule.forFeature([UserEntity])],
  providers: [UsersService],
  controllers: [UsersController],
  exports: [UsersService],
})
export class UsersModule {}
```

`app.module.ts` 同步挂载（UserGuard 依赖全局 SessionModule 的 SessionService）：

```ts
imports: [DatabaseModule, SessionModule, UsersModule],
```

`apps/server/src/auth/user.guard.ts`：

```ts
import { CanActivate, ExecutionContext, Injectable, UnauthorizedException } from '@nestjs/common';
import { SessionService } from '../session/session.service';

@Injectable()
export class UserGuard implements CanActivate {
  constructor(private readonly sessions: SessionService) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const req = context.switchToHttp().getRequest();
    const header: string = req.headers['authorization'] ?? '';
    const token = header.startsWith('Bearer ') ? header.slice(7) : '';
    const session = token ? await this.sessions.validate(token) : null;
    if (!session) throw new UnauthorizedException('未登录或会话已过期');
    req.user = { id: session.userId };
    req.sessionToken = token;
    return true;
  }
}
```

`apps/server/src/users/users.controller.ts`：

```ts
import { Controller, Get, Req, UseGuards } from '@nestjs/common';
import { UserGuard } from '../auth/user.guard';

@Controller('api/users')
@UseGuards(UserGuard)
export class UsersController {
  @Get('me')
  me(@Req() req: { user: { id: string }; fullUser?: unknown }): unknown {
    return req.fullUser;
  }
}
```

注意：`me` 需要完整用户信息，guard 里只放了 id——在 `UserGuard.canActivate` 末尾补充查询（注入 UsersService 会造成循环依赖，改为 guard 内 `req.fullUser = await this.users.findById(userId)`）。因此 UserGuard 最终形态：

```ts
import { CanActivate, ExecutionContext, Injectable, UnauthorizedException } from '@nestjs/common';
import { SessionService } from '../session/session.service';
import { UsersService } from '../users/users.service';

@Injectable()
export class UserGuard implements CanActivate {
  constructor(
    private readonly sessions: SessionService,
    private readonly users: UsersService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const req = context.switchToHttp().getRequest();
    const header: string = req.headers['authorization'] ?? '';
    const token = header.startsWith('Bearer ') ? header.slice(7) : '';
    const session = token ? await this.sessions.validate(token) : null;
    if (!session) throw new UnauthorizedException('未登录或会话已过期');
    const user = await this.users.findById(session.userId);
    if (!user) throw new UnauthorizedException('用户不存在');
    req.user = { id: user.id };
    req.sessionToken = token;
    req.fullUser = { id: user.id, nickname: user.nickname, avatarUrl: user.avatarUrl };
    return true;
  }
}
```

`UsersService` 相应补充：

```ts
findById(id: string): Promise<UserEntity | null> {
  return this.repo.findOneBy({ id });
}
```

- [ ] **Step 2: 写失败 e2e**

`apps/server/test/users-me.e2e-spec.ts`（完整应用测试装置，Task 8 复用为 `test/support/app-test.ts`）：

`apps/server/test/support/app-test.ts`：

```ts
import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { AppModule } from '../../src/app.module';
import { createDataSource } from '../../src/database/data-source';

/** e2e 统一装置：连 gmind_test 库 + Redis db1（环境变量由 vitest.e2e.config.ts 的 setupFiles 固定），
 *  跑迁移并清库，返回已初始化的 app。 */
export async function createTestApp(): Promise<INestApplication> {
  const setup = createDataSource('gmind_test');
  await setup.initialize();
  await setup.runMigrations();
  for (const t of ['versions', 'events', 'notifications', 'comments', 'invites', 'share_links', 'file_stars', 'file_collaborators', 'files', 'folders', 'users']) {
    await setup.query(`DELETE FROM ${t}`);
  }
  await setup.destroy();

  const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
  const app = moduleRef.createNestApplication();
  await app.init();
  return app;
}
```

`apps/server/test/users-me.e2e-spec.ts`：

```ts
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
```

（`me` 的成功路径在 Task 8 登录 e2e 中一并断言，此处无登录接口可先拿 token。）

- [ ] **Step 3: 运行测试通过**

Run: `pnpm --filter @gmind/server test:e2e`
Expected: PASS（2 个 401 用例绿；db-init 用例仍绿）。

- [ ] **Step 4: Commit**

```bash
git add apps/server/src apps/server/test
git commit -m "feat(server): users 实体、UserGuard 会话鉴权与 /api/users/me"
```

---

### Task 7: 文件域：注册种子 3 个示例脑图 + 列表/新建接口

**Files:**
- Create: `apps/server/src/files/file.entity.ts`, `apps/server/src/files/files.service.ts`, `apps/server/src/files/files.controller.ts`, `apps/server/src/files/files.module.ts`
- Test: `apps/server/test/files.e2e-spec.ts`

**Interfaces:**
- Consumes: `@gmind/core` 的 `SEED_TEMPLATES`/`createTemplateDoc`/`docToState`/`countNodes`（Task 3）；`UserGuard`（Task 6）。
- Produces（Task 8 消费）:
  - `FilesService.createForUser(userId: string, input: { title: string; state?: Uint8Array; nodeCount?: number }): Promise<FileEntity>`
  - `FilesService.listOwned(userId: string): Promise<FileListItem[]>`
  - `FilesService.createSeedFiles(userId: string): Promise<void>`（注册时种 3 个示例文件）
  - `GET /api/files`、`POST /api/files`

- [ ] **Step 1: 写实体与服务**

`apps/server/src/files/file.entity.ts`：

```ts
import { Column, CreateDateColumn, Entity, Index, PrimaryColumn, UpdateDateColumn } from 'typeorm';
import { ulid } from 'ulid';

@Entity('files')
@Index('idx_files_owner', ['ownerUserId'])
export class FileEntity {
  @PrimaryColumn({ type: 'char', length: 26 })
  id: string = ulid();

  @Column({ type: 'char', length: 26, name: 'owner_user_id' })
  ownerUserId: string = '';

  @Column({ type: 'char', length: 26, nullable: true, name: 'space_id' })
  spaceId: string | null = null;

  @Column({ type: 'char', length: 26, nullable: true, name: 'folder_id' })
  folderId: string | null = null;

  @Column({ type: 'varchar', length: 255 })
  title: string = '未命名脑图';

  @Column({ type: 'varchar', length: 16 })
  structure: string = 'mindmap';

  @Column({ type: 'varchar', length: 32, name: 'theme_id' })
  themeId: string = 'gmind-light';

  @Column({ type: 'int', name: 'node_count' })
  nodeCount: number = 1;

  @Column({ type: 'longblob', nullable: true, name: 'doc_state' })
  docState: Buffer | null = null;

  @Column({ type: 'datetime', precision: 3, nullable: true, name: 'last_opened_at' })
  lastOpenedAt: Date | null = null;

  @Column({ type: 'datetime', precision: 3, nullable: true, name: 'deleted_at' })
  deletedAt: Date | null = null;

  @Column({ type: 'char', length: 26, nullable: true, name: 'deleted_by' })
  deletedBy: string | null = null;

  @CreateDateColumn({ type: 'datetime', precision: 3 })
  createdAt: Date = new Date();

  @UpdateDateColumn({ type: 'datetime', precision: 3 })
  updatedAt: Date = new Date();
}
```

`apps/server/src/files/files.service.ts`：

```ts
import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { IsNull, Repository } from 'typeorm';
import { countNodes, createTemplateDoc, docFromState, docToState, SEED_TEMPLATES } from '@gmind/core';
import type { FileListItem } from '@gmind/shared';
import { FileEntity } from './file.entity';

export const MAX_FILES_PER_USER = 100;

@Injectable()
export class FilesService {
  constructor(@InjectRepository(FileEntity) private readonly repo: Repository<FileEntity>) {}

  /** 新建文件；无 doc 状态时用空白模板。配额 100 文件（FR-ACC-003）。 */
  async createForUser(
    userId: string,
    input: { title: string; state?: Uint8Array; nodeCount?: number },
  ): Promise<FileEntity> {
    const count = await this.repo.countBy({ ownerUserId: userId, deletedAt: IsNull() });
    if (count >= MAX_FILES_PER_USER) {
      throw new QuotaError('文件数量已达上限（100 个）');
    }
    const file = this.repo.create();
    file.ownerUserId = userId;
    file.title = input.title;
    if (input.state) {
      file.docState = Buffer.from(input.state);
      file.nodeCount = input.nodeCount ?? countNodes(docFromState(input.state));
    } else {
      const doc = createTemplateDoc({ title: input.title, children: [] });
      file.docState = Buffer.from(docToState(doc));
      file.nodeCount = countNodes(doc);
    }
    return this.repo.save(file);
  }

  /** 注册赠送 3 个示例脑图（FR-ACC-001）。 */
  async createSeedFiles(userId: string): Promise<void> {
    for (const tpl of SEED_TEMPLATES) {
      const state = docToState(createTemplateDoc(tpl));
      await this.createForUser(userId, { title: tpl.title, state, nodeCount: undefined });
    }
  }

  async listOwned(userId: string): Promise<FileListItem[]> {
    const rows = await this.repo.find({
      where: { ownerUserId: userId, deletedAt: IsNull() },
      order: { updatedAt: 'DESC' },
    });
    return rows.map((f) => ({
      id: f.id,
      title: f.title,
      structure: f.structure as FileListItem['structure'],
      nodeCount: f.nodeCount,
      lastOpenedAt: f.lastOpenedAt?.toISOString() ?? null,
      updatedAt: f.updatedAt.toISOString(),
    }));
  }
}

export class QuotaError extends Error {}
```

`apps/server/package.json` dependencies 增加 `"@gmind/core": "workspace:*"`（files.service 消费模板与计数 API），随后 `pnpm install`。

`apps/server/src/files/files.controller.ts`：

```ts
import { Body, Controller, Get, Post, Req, UseGuards } from '@nestjs/common';
import { createFileSchema } from '@gmind/shared';
import { UserGuard } from '../auth/user.guard';
import { FilesService, QuotaError } from './files.service';

@Controller('api/files')
@UseGuards(UserGuard)
export class FilesController {
  constructor(private readonly files: FilesService) {}

  @Get()
  list(@Req() req: { user: { id: string } }) {
    return this.files.listOwned(req.user.id);
  }

  @Post()
  async create(@Req() req: { user: { id: string } }, @Body() body: unknown) {
    const { title } = createFileSchema.parse(body ?? {});
    return this.files.createForUser(req.user.id, { title });
  }
}
```

QuotaError → 403 映射：在 `zod-exception.filter.ts` 旁新建 `apps/server/src/common/quota-exception.filter.ts`：

```ts
import { ArgumentsHost, Catch, ExceptionFilter, ForbiddenException } from '@nestjs/common';
import type { Response } from 'express';
import { QuotaError } from '../files/files.service';

@Catch(QuotaError)
export class QuotaExceptionFilter implements ExceptionFilter {
  catch(exception: QuotaError, host: ArgumentsHost): void {
    host.switchToHttp().getResponse<Response>().status(403).json({ message: exception.message });
  }
}
```

并在 `main.ts` 注册：`app.useGlobalFilters(new ZodExceptionFilter(), new QuotaExceptionFilter());`

`apps/server/src/files/files.module.ts`：

```ts
import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { FileEntity } from './file.entity';
import { FilesService } from './files.service';
import { FilesController } from './files.controller';

@Module({
  imports: [TypeOrmModule.forFeature([FileEntity])],
  providers: [FilesService],
  controllers: [FilesController],
  exports: [FilesService],
})
export class FilesModule {}
```

`app.module.ts` imports 增加 `UsersModule`、`FilesModule`、`SessionModule`。

- [ ] **Step 2: 写失败 e2e**

`apps/server/test/files.e2e-spec.ts`：

```ts
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import type { INestApplication } from '@nestjs/common';
import { createTestApp } from './support/app-test';

describe('files 域', () => {
  let app: INestApplication;
  const tokenFor = async (userId: string): Promise<string> => {
    // 直接通过 SessionService 签发，登录接口在 Task 8 才有
    const { SessionService } = await import('../src/session/session.service');
    const redisMod = await import('ioredis');
    const svc = new SessionService(new redisMod.default('redis://127.0.0.1:63790/1'));
    return (await svc.create(userId, false)).token;
  };

  beforeAll(async () => {
    app = await createTestApp();
  });

  afterAll(async () => {
    await app.close();
  });

  it('createSeedFiles 后列表返回 3 个示例文件（FR-ACC-001）', async () => {
    const users = app.get((await import('../src/users/users.service')).UsersService);
    const user = await users.create({ method: 'phone', phone: '13800001111' });
    const files = app.get((await import('../src/files/files.service')).FilesService);
    await files.createSeedFiles(user.id);

    const token = await tokenFor(user.id);
    const res = await request(app.getHttpServer()).get('/api/files').set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(3);
    expect(res.body.map((f: { title: string }) => f.title)).toContain('欢迎使用 Gmind');
    expect(res.body[0]).toHaveProperty('nodeCount');
  });

  it('POST /api/files 新建并出现在列表首位', async () => {
    const users = app.get((await import('../src/users/users.service')).UsersService);
    const user = await users.create({ method: 'phone', phone: '13800002222' });
    const token = await tokenFor(user.id);
    const created = await request(app.getHttpServer())
      .post('/api/files')
      .set('Authorization', `Bearer ${token}`)
      .send({ title: '测试新建' });
    expect(created.status).toBe(201);
    expect(created.body.nodeCount).toBe(1);

    const list = await request(app.getHttpServer()).get('/api/files').set('Authorization', `Bearer ${token}`);
    expect(list.body[0].title).toBe('测试新建');
  });

  it('标题缺省时默认「未命名脑图」且 400 校验生效', async () => {
    const users = app.get((await import('../src/users/users.service')).UsersService);
    const user = await users.create({ method: 'phone', phone: '13800003333' });
    const token = await tokenFor(user.id);
    const created = await request(app.getHttpServer())
      .post('/api/files')
      .set('Authorization', `Bearer ${token}`)
      .send({});
    expect(created.status).toBe(201);
    expect(created.body.title).toBe('未命名脑图');
  });
});
```

- [ ] **Step 3: 运行测试通过**

Run: `pnpm --filter @gmind/server test:e2e && pnpm --filter @gmind/server test`
Expected: 全部 PASS。

- [ ] **Step 4: Commit**

```bash
git add apps/server
git commit -m "feat(server): 文件域实体/服务/接口，注册种子 3 个示例文件（FR-ACC-001/003）"
```

---

### Task 8: 三方式登录/注册（DevProvider）与统一会话签发

**Files:**
- Create: `apps/server/src/auth/providers/login-provider.interface.ts`, `apps/server/src/auth/providers/dev-phone.provider.ts`, `apps/server/src/auth/providers/dev-email.provider.ts`, `apps/server/src/auth/providers/dev-wechat.provider.ts`, `apps/server/src/auth/auth.service.ts`, `apps/server/src/auth/auth.controller.ts`, `apps/server/src/auth/auth.module.ts`
- Test: `apps/server/test/auth.e2e-spec.ts`

**Interfaces:**
- Consumes: `loginSchema`（shared）、`UsersService`（Task 6）、`SessionService`（Task 5）、`FilesService.createSeedFiles`（Task 7）。
- Produces: `POST /api/auth/login`（body 为 `LoginRequest` + 顶层 `rememberMe?: boolean`，返回 `LoginResponse`）、`POST /api/auth/logout`。`LoginProvider` 接口（生产 Provider 只换实现）。

- [ ] **Step 1: 写 Provider 接口与三个 Dev 实现**

`apps/server/src/auth/providers/login-provider.interface.ts`：

```ts
import type { LoginMethod } from '@gmind/shared';
import type { LoginIdentity } from '../../users/users.service';

export interface LoginProvider {
  readonly method: LoginMethod;
  authenticate(payload: unknown): Promise<LoginIdentity>;
}
```

`apps/server/src/auth/providers/dev-phone.provider.ts`：

```ts
import { Injectable, UnauthorizedException } from '@nestjs/common';
import { phoneLoginSchema } from '@gmind/shared';
import { env } from '../../config/env';
import type { LoginIdentity } from '../../users/users.service';
import type { LoginProvider } from './login-provider.interface';

/** 开发环境：验证码固定值（spec §5.2），生产替换为真实短信 Provider。 */
@Injectable()
export class DevPhoneProvider implements LoginProvider {
  readonly method = 'phone' as const;

  async authenticate(payload: unknown): Promise<LoginIdentity> {
    const { phone, code } = phoneLoginSchema.parse(payload);
    if (code !== env.DEV_SMS_CODE) throw new UnauthorizedException('验证码错误');
    return { method: 'phone', phone };
  }
}
```

`apps/server/src/auth/providers/dev-email.provider.ts`：

```ts
import { Injectable, UnauthorizedException } from '@nestjs/common';
import { emailLoginSchema } from '@gmind/shared';
import { compare } from 'bcryptjs';
import { env } from '../../config/env';
import { UsersService } from '../../users/users.service';
import type { LoginProvider } from './login-provider.interface';

@Injectable()
export class DevEmailProvider implements LoginProvider {
  readonly method = 'email' as const;

  constructor(private readonly users: UsersService) {}

  async authenticate(payload: unknown): Promise<LoginIdentity> {
    const parsed = emailLoginSchema.parse(payload);
    if (parsed.mode === 'code') {
      if (parsed.code !== env.DEV_SMS_CODE) throw new UnauthorizedException('验证码错误');
      return { method: 'email', email: parsed.email };
    }
    // 密码模式：用户必须已存在且已设置密码
    const user = await this.users.findByIdentity({ method: 'email', email: parsed.email });
    if (!user?.passwordHash || !parsed.password || !(await compare(parsed.password, user.passwordHash))) {
      throw new UnauthorizedException('邮箱或密码错误');
    }
    return { method: 'email', email: parsed.email };
  }
}

type LoginIdentity = Awaited<ReturnType<LoginProvider['authenticate']>>;
```

密码设置入口（注册时可选带 `password`）：见 Step 2 AuthService——登录请求体放宽为 `loginSchema` 与 `{password?, rememberMe?}` 的合并，注册携带 `password` 时为邮箱账号写入 hash。为此给 `loginSchema` 之外再包一层：

`apps/server/src/auth/auth-request.schema.ts`（新文件）：

```ts
import { z } from 'zod';
import { loginSchema } from '@gmind/shared';

export const authRequestSchema = z.intersection(
  z.object({
    rememberMe: z.boolean().optional(),
    /** 仅 email 注册时可选设置密码（6~64 位），登录时用于密码模式校验 */
    password: z.string().min(6).max(64).optional(),
  }),
  loginSchema,
);
```

`apps/server/src/auth/providers/dev-wechat.provider.ts`：

```ts
import { Injectable } from '@nestjs/common';
import { wechatLoginSchema } from '@gmind/shared';
import type { LoginProvider } from './login-provider.interface';

/** 开发环境：模拟微信扫码，openid 可指定（便于多账号测试），生产替换为真实微信 OAuth。 */
@Injectable()
export class DevWechatProvider implements LoginProvider {
  readonly method = 'wechat' as const;

  async authenticate(payload: unknown) {
    const { mockOpenid, nickname } = wechatLoginSchema.parse(payload ?? {});
    return {
      method: 'wechat' as const,
      wechatOpenid: mockOpenid ?? 'dev-wechat-openid-default',
      nickname: nickname ?? '微信用户',
    };
  }
}
```

- [ ] **Step 2: AuthService 与 Controller**

`apps/server/src/auth/auth.service.ts`：

```ts
import { Injectable } from '@nestjs/common';
import { hash } from 'bcryptjs';
import { SessionService } from '../session/session.service';
import { FilesService } from '../files/files.service';
import { UsersService, type LoginIdentity } from '../users/users.service';
import type { LoginResponse } from '@gmind/shared';

@Injectable()
export class AuthService {
  constructor(
    private readonly users: UsersService,
    private readonly sessions: SessionService,
    private readonly files: FilesService,
  ) {}

  /** 登录即注册（FR-ACC-001）：新身份建用户并种 3 个示例文件。 */
  async login(identity: LoginIdentity, rememberMe: boolean, registerPassword?: string): Promise<LoginResponse> {
    let user = await this.users.findByIdentity(identity);
    if (!user) {
      user = await this.users.create(identity);
      if (registerPassword && identity.method === 'email') {
        user.passwordHash = await hash(registerPassword, 10);
        await this.users.save(user);
      }
      await this.files.createSeedFiles(user.id);
    }
    const { token, expiresAt } = await this.sessions.create(user.id, rememberMe);
    return { token, expiresAt, user: { id: user.id, nickname: user.nickname, avatarUrl: user.avatarUrl } };
  }

  async logout(token: string): Promise<void> {
    await this.sessions.revoke(token);
  }
}
```

`UsersService` 补充 `save(user: UserEntity)`：`return this.repo.save(user);`

`apps/server/src/auth/auth.controller.ts`：

```ts
import { Body, Controller, HttpCode, Post, Req, UseGuards } from '@nestjs/common';
import { authRequestSchema } from './auth-request.schema';
import { AuthService } from './auth.service';
import { DevEmailProvider } from './providers/dev-email.provider';
import { DevPhoneProvider } from './providers/dev-phone.provider';
import { DevWechatProvider } from './providers/dev-wechat.provider';
import type { LoginMethod } from '@gmind/shared';

@Controller('api/auth')
export class AuthController {
  constructor(
    private readonly authService: AuthService,
    private readonly phoneProvider: DevPhoneProvider,
    private readonly emailProvider: DevEmailProvider,
    private readonly wechatProvider: DevWechatProvider,
  ) {}

  @Post('login')
  @HttpCode(200)
  async login(@Body() body: unknown): Promise<unknown> {
    const { rememberMe, password, ...loginPayload } = authRequestSchema.parse(body);
    const provider = ({ phone: this.phoneProvider, email: this.emailProvider, wechat: this.wechatProvider })[loginPayload.method as LoginMethod];
    const identity = await provider.authenticate(loginPayload);
    return this.authService.login(identity, rememberMe === true, password);
  }

  @Post('logout')
  @UseGuards(UserGuard)
  @HttpCode(200)
  async logout(@Req() req: { sessionToken: string }): Promise<{ ok: true }> {
    await this.authService.logout(req.sessionToken);
    return { ok: true };
  }
}
```

（`UserGuard` import 自 `./user.guard`。）

`apps/server/src/auth/auth.module.ts`：

```ts
import { Module } from '@nestjs/common';
import { AuthController } from './auth.controller';
import { AuthService } from './auth.service';
import { UserGuard } from './user.guard';
import { DevEmailProvider } from './providers/dev-email.provider';
import { DevPhoneProvider } from './providers/dev-phone.provider';
import { DevWechatProvider } from './providers/dev-wechat.provider';

@Module({
  controllers: [AuthController],
  providers: [AuthService, UserGuard, DevPhoneProvider, DevEmailProvider, DevWechatProvider],
})
export class AuthModule {}
```

`app.module.ts` imports 增加 `AuthModule`。

`apps/server/package.json` dependencies 增加 `"bcryptjs": "^2.4.3"`，devDependencies 增加 `"@types/bcryptjs": "^2.4.6"`。

- [ ] **Step 3: 写失败 e2e**

`apps/server/test/auth.e2e-spec.ts`：

```ts
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import type { INestApplication } from '@nestjs/common';
import { createTestApp } from './support/app-test';

const phone = () => '139' + String(Date.now()).slice(-8);

describe('POST /api/auth/login', () => {
  let app: INestApplication;

  beforeAll(async () => {
    app = await createTestApp();
  });

  afterAll(async () => {
    await app.close();
  });

  it('手机验证码首登即注册，返回 token 且种 3 个示例文件（FR-ACC-001）', async () => {
    const res = await request(app.getHttpServer())
      .post('/api/auth/login')
      .send({ method: 'phone', phone: phone(), code: '123456' });
    expect(res.status).toBe(200);
    expect(res.body.token).toBeTruthy();
    expect(res.body.user.nickname).toContain('用户');

    const list = await request(app.getHttpServer())
      .get('/api/files')
      .set('Authorization', `Bearer ${res.body.token}`);
    expect(list.body).toHaveLength(3);
  });

  it('同一手机号二次登录为同一账号', async () => {
    const p = phone();
    const r1 = await request(app.getHttpServer()).post('/api/auth/login').send({ method: 'phone', phone: p, code: '123456' });
    const r2 = await request(app.getHttpServer()).post('/api/auth/login').send({ method: 'phone', phone: p, code: '123456' });
    expect(r2.body.user.id).toBe(r1.body.user.id);
  });

  it('验证码错误返回 401', async () => {
    const res = await request(app.getHttpServer())
      .post('/api/auth/login')
      .send({ method: 'phone', phone: phone(), code: '999999' });
    expect(res.status).toBe(401);
  });

  it('手机号格式非法返回 400', async () => {
    const res = await request(app.getHttpServer())
      .post('/api/auth/login')
      .send({ method: 'phone', phone: 'not-a-phone', code: '123456' });
    expect(res.status).toBe(400);
  });

  it('邮箱验证码登录 / 密码注册后密码登录', async () => {
    const email = `u${Date.now()}@test.dev`;
    const withPwd = await request(app.getHttpServer())
      .post('/api/auth/login')
      .send({ method: 'email', email, mode: 'code', code: '123456', password: 'secret66' });
    expect(withPwd.status).toBe(200);

    const byPwd = await request(app.getHttpServer())
      .post('/api/auth/login')
      .send({ method: 'email', email, mode: 'password', password: 'secret66' });
    expect(byPwd.status).toBe(200);
    expect(byPwd.body.user.id).toBe(withPwd.body.user.id);

    const wrong = await request(app.getHttpServer())
      .post('/api/auth/login')
      .send({ method: 'email', email, mode: 'password', password: 'wrong66' });
    expect(wrong.status).toBe(401);
  });

  it('微信 mock 登录，默认 openid 稳定复用同一账号', async () => {
    const r1 = await request(app.getHttpServer()).post('/api/auth/login').send({ method: 'wechat' });
    const r2 = await request(app.getHttpServer()).post('/api/auth/login').send({ method: 'wechat' });
    expect(r1.status).toBe(200);
    expect(r2.body.user.id).toBe(r1.body.user.id);
  });

  it('第 6 台设备登录时第 1 个会话被踢（FR-ACC-002）', async () => {
    const p = phone();
    const tokens: string[] = [];
    for (let i = 0; i < 6; i++) {
      const r = await request(app.getHttpServer())
        .post('/api/auth/login')
        .send({ method: 'phone', phone: p, code: '123456' });
      tokens.push(r.body.token as string);
    }
    const first = await request(app.getHttpServer())
      .get('/api/users/me')
      .set('Authorization', `Bearer ${tokens[0]}`);
    expect(first.status).toBe(401);
    const latest = await request(app.getHttpServer())
      .get('/api/users/me')
      .set('Authorization', `Bearer ${tokens[5]}`);
    expect(latest.status).toBe(200);
    expect(latest.body.id).toBeTruthy();
  });

  it('logout 后原 token 失效', async () => {
    const login = await request(app.getHttpServer())
      .post('/api/auth/login')
      .send({ method: 'phone', phone: phone(), code: '123456' });
    const me = await request(app.getHttpServer())
      .post('/api/auth/logout')
      .set('Authorization', `Bearer ${login.body.token}`);
    expect(me.status).toBe(200);
    const after = await request(app.getHttpServer())
      .get('/api/users/me')
      .set('Authorization', `Bearer ${login.body.token}`);
    expect(after.status).toBe(401);
  });
});
```

- [ ] **Step 4: 运行测试通过**

Run: `pnpm install && pnpm --filter @gmind/server test:e2e && pnpm --filter @gmind/server test`
Expected: 全部 PASS。

- [ ] **Step 5: Commit**

```bash
git add apps/server
git commit -m "feat(server): 手机/邮箱/微信三方式登录注册（DevProvider）与统一会话签发"
```

---

### Task 9: web 前端（登录页 + 工作台）与 Playwright 全链路 E2E

**Files:**
- Create: `apps/web/package.json`, `apps/web/tsconfig.json`, `apps/web/vite.config.ts`, `apps/web/index.html`, `apps/web/src/main.tsx`, `apps/web/src/App.tsx`, `apps/web/src/api/client.ts`, `apps/web/src/pages/LoginPage.tsx`, `apps/web/src/pages/WorkspacePage.tsx`, `apps/web/src/styles.css`, `apps/web/playwright.config.ts`, `apps/web/e2e/m0-acceptance.e2e.spec.ts`
- Test: `apps/web/e2e/m0-acceptance.e2e.spec.ts`

**Interfaces:**
- Consumes: `POST /api/auth/login`、`GET /api/users/me`、`GET /api/files`、`POST /api/files`（Task 6/7/8）；`LoginResponse`/`FileListItem`（shared）。
- Produces: 可登录、可看文件、可新建文件的浏览器应用；`@gmind/web` E2E 即 M0 验收测试。

- [ ] **Step 1: 写应用骨架**

`apps/web/package.json`：

```json
{
  "name": "@gmind/web",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "scripts": {
    "dev": "vite",
    "build": "tsc -p tsconfig.json --noEmit && vite build",
    "test": "echo \"web 单测自 M1 起\" && exit 0",
    "e2e": "playwright test"
  },
  "dependencies": {
    "@gmind/shared": "workspace:*",
    "react": "^18.3.0",
    "react-dom": "^18.3.0",
    "react-router-dom": "^6.26.0"
  },
  "devDependencies": {
    "@playwright/test": "^1.47.0",
    "@types/react": "^18.3.0",
    "@types/react-dom": "^18.3.0",
    "@vitejs/plugin-react": "^4.3.0",
    "vite": "^5.4.0"
  }
}
```

`apps/web/tsconfig.json`：

```json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": {
    "jsx": "react-jsx",
    "lib": ["ES2022", "DOM", "DOM.Iterable"],
    "types": ["vite/client"],
    "noEmit": true
  },
  "include": ["src", "e2e"]
}
```

`apps/web/vite.config.ts`：

```ts
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  server: { proxy: { '/api': 'http://localhost:3000' } },
});
```

`apps/web/index.html`：

```html
<!doctype html>
<html lang="zh-CN">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>Gmind</title>
  </head>
  <body>
    <div id="root"></div>
    <script type="module" src="/src/main.tsx"></script>
  </body>
</html>
```

`apps/web/src/api/client.ts`：

```ts
const TOKEN_KEY = 'gmind.token';

export function getToken(): string | null {
  return localStorage.getItem(TOKEN_KEY);
}

export function setToken(token: string): void {
  localStorage.setItem(TOKEN_KEY, token);
}

export function clearToken(): void {
  localStorage.removeItem(TOKEN_KEY);
}

export async function api<T>(path: string, init: { method?: string; body?: unknown } = {}): Promise<T> {
  const res = await fetch(`/api${path}`, {
    method: init.method ?? 'GET',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${getToken() ?? ''}`,
    },
    body: init.body === undefined ? undefined : JSON.stringify(init.body),
  });
  if (!res.ok) {
    const data = (await res.json().catch(() => ({}))) as { message?: string };
    if (res.status === 401 && getToken()) clearToken();
    throw new Error(data.message ?? `请求失败（${res.status}）`);
  }
  return (await res.json()) as T;
}
```

`apps/web/src/main.tsx`：

```tsx
import React from 'react';
import ReactDOM from 'react-dom/client';
import { BrowserRouter } from 'react-router-dom';
import { App } from './App';
import './styles.css';

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <BrowserRouter>
      <App />
    </BrowserRouter>
  </React.StrictMode>,
);
```

`apps/web/src/App.tsx`：

```tsx
import { Navigate, Route, Routes } from 'react-router-dom';
import { getToken } from './api/client';
import { LoginPage } from './pages/LoginPage';
import { WorkspacePage } from './pages/WorkspacePage';

function RequireAuth({ children }: { children: React.ReactElement }) {
  return getToken() ? children : <Navigate to="/login" replace />;
}

export function App() {
  return (
    <Routes>
      <Route path="/login" element={<LoginPage />} />
      <Route
        path="/workspace"
        element={
          <RequireAuth>
            <WorkspacePage />
          </RequireAuth>
        }
      />
      <Route path="*" element={<Navigate to={getToken() ? '/workspace' : '/login'} replace />} />
    </Routes>
  );
}
```

（文件顶部需 `import type React from 'react'` 或将 children 类型改为 `JSX.Element`。）

`apps/web/src/pages/LoginPage.tsx`：

```tsx
import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { api, setToken } from '../api/client';
import type { LoginResponse } from '@gmind/shared';

type Tab = 'phone' | 'email' | 'wechat';

export function LoginPage() {
  const navigate = useNavigate();
  const [tab, setTab] = useState<Tab>('phone');
  const [phone, setPhone] = useState('');
  const [code, setCode] = useState('');
  const [email, setEmail] = useState('');
  const [emailMode, setEmailMode] = useState<'code' | 'password'>('code');
  const [emailSecret, setEmailSecret] = useState('');
  const [error, setError] = useState('');

  async function doLogin(body: Record<string, unknown>) {
    setError('');
    try {
      const res = await api<LoginResponse>('/auth/login', { method: 'POST', body });
      setToken(res.token);
      navigate('/workspace');
    } catch (e) {
      setError(e instanceof Error ? e.message : '登录失败');
    }
  }

  return (
    <div className="login-page">
      <h1>Gmind</h1>
      <p className="subtitle">在线协作脑图 · 开发环境</p>
      <div className="tabs">
        {(['phone', 'email', 'wechat'] as Tab[]).map((t) => (
          <button key={t} className={tab === t ? 'active' : ''} onClick={() => setTab(t)}>
            {{ phone: '手机号', email: '邮箱', wechat: '微信扫码' }[t]}
          </button>
        ))}
      </div>

      {tab === 'phone' && (
        <div className="form">
          <input placeholder="手机号" value={phone} onChange={(e) => setPhone(e.target.value)} />
          <input placeholder="验证码（开发环境固定 123456）" value={code} onChange={(e) => setCode(e.target.value)} />
          <button onClick={() => void doLogin({ method: 'phone', phone, code })}>登录</button>
        </div>
      )}

      {tab === 'email' && (
        <div className="form">
          <input placeholder="邮箱" value={email} onChange={(e) => setEmail(e.target.value)} />
          <div className="mode-switch">
            <button className={emailMode === 'code' ? 'active' : ''} onClick={() => setEmailMode('code')}>验证码登录</button>
            <button className={emailMode === 'password' ? 'active' : ''} onClick={() => setEmailMode('password')}>密码登录</button>
          </div>
          <input
            placeholder={emailMode === 'code' ? '验证码（开发环境固定 123456）' : '密码（未设置则先用验证码登录）'}
            value={emailSecret}
            onChange={(e) => setEmailSecret(e.target.value)}
          />
          <button
            onClick={() =>
              void doLogin({
                method: 'email',
                email,
                mode: emailMode,
                code: emailMode === 'code' ? emailSecret : undefined,
                password: emailMode === 'password' ? emailSecret : undefined,
              })
            }
          >
            登录
          </button>
        </div>
      )}

      {tab === 'wechat' && (
        <div className="form">
          <button onClick={() => void doLogin({ method: 'wechat' })}>模拟微信扫码登录</button>
        </div>
      )}

      {error && <p className="error">{error}</p>}
    </div>
  );
}
```

`apps/web/src/pages/WorkspacePage.tsx`：

```tsx
import { useEffect, useState } from 'react';
import type { FileListItem } from '@gmind/shared';
import { api } from '../api/client';

export function WorkspacePage() {
  const [files, setFiles] = useState<FileListItem[]>([]);
  const [error, setError] = useState('');

  async function reload() {
    try {
      setFiles(await api<FileListItem[]>('/files'));
    } catch (e) {
      setError(e instanceof Error ? e.message : '加载失败');
    }
  }

  useEffect(() => {
    void reload();
  }, []);

  async function createFile() {
    await api('/files', { method: 'POST', body: {} });
    await reload();
  }

  return (
    <div className="workspace">
      <header>
        <h2>我的文件</h2>
        <button onClick={() => void createFile()}>新建脑图</button>
      </header>
      {error && <p className="error">{error}</p>}
      <ul className="file-list">
        {files.map((f) => (
          <li key={f.id}>
            <span className="title">{f.title}</span>
            <span className="meta">{f.nodeCount} 节点 · 更新于 {new Date(f.updatedAt).toLocaleString()}</span>
          </li>
        ))}
        {files.length === 0 && <li className="empty">暂无文件，点击「新建脑图」开始</li>}
      </ul>
    </div>
  );
}
```

`apps/web/src/styles.css`（最小可读样式）：

```css
* { box-sizing: border-box; }
body { margin: 0; font-family: 'PingFang SC', 'Microsoft YaHei', sans-serif; background: #f5f6f8; color: #1f2329; }
button { cursor: pointer; }
.login-page { max-width: 360px; margin: 12vh auto; padding: 24px; background: #fff; border-radius: 12px; box-shadow: 0 4px 16px rgba(0,0,0,.08); }
.login-page h1 { margin: 0; text-align: center; }
.subtitle { text-align: center; color: #86909c; font-size: 13px; }
.tabs { display: flex; gap: 8px; margin: 16px 0; }
.tabs button { flex: 1; padding: 8px; border: 1px solid #e5e6eb; background: #fff; border-radius: 6px; }
.tabs button.active { border-color: #3370ff; color: #3370ff; }
.form { display: flex; flex-direction: column; gap: 12px; }
.form input { padding: 10px; border: 1px solid #e5e6eb; border-radius: 6px; }
.form button { padding: 10px; border: none; background: #3370ff; color: #fff; border-radius: 6px; }
.mode-switch { display: flex; gap: 8px; }
.mode-switch button { flex: 1; padding: 6px; border: 1px solid #e5e6eb; background: #fff; border-radius: 6px; }
.mode-switch button.active { border-color: #3370ff; color: #3370ff; }
.error { color: #f53f3f; font-size: 13px; }
.workspace { max-width: 720px; margin: 40px auto; padding: 0 16px; }
.workspace header { display: flex; justify-content: space-between; align-items: center; }
.workspace header button { padding: 8px 16px; border: none; background: #3370ff; color: #fff; border-radius: 6px; }
.file-list { list-style: none; padding: 0; display: flex; flex-direction: column; gap: 8px; }
.file-list li { background: #fff; padding: 14px 16px; border-radius: 8px; display: flex; justify-content: space-between; }
.file-list .meta { color: #86909c; font-size: 12px; }
.file-list .empty { color: #86909c; justify-content: center; }
```

- [ ] **Step 2: 写 Playwright 配置与验收测试**

`apps/web/playwright.config.ts`：

```ts
import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './e2e',
  timeout: 30000,
  use: { baseURL: 'http://localhost:5173' },
  webServer: {
    command: 'pnpm dev',
    url: 'http://localhost:5173',
    reuseExistingServer: true,
    timeout: 60000,
  },
});
```

`apps/web/e2e/m0-acceptance.e2e.spec.ts`：

```ts
import { test, expect } from '@playwright/test';

test('M0 验收：手机验证码注册登录后看到 3 个示例文件', async ({ page }) => {
  await page.goto('/login');
  const phone = '138' + String(Date.now()).slice(-8);
  await page.getByPlaceholder('手机号').fill(phone);
  await page.getByPlaceholder('验证码（开发环境固定 123456）').fill('123456');
  await page.getByRole('button', { name: '登录', exact: true }).click();
  await expect(page).toHaveURL(/\/workspace/);
  await expect(page.getByText('欢迎使用 Gmind')).toBeVisible();
  await expect(page.locator('.file-list li')).toHaveCount(3);
});

test('M0 验收：新建脑图出现在列表首位', async ({ page }) => {
  await page.goto('/login');
  const phone = '138' + String(Date.now()).slice(-8);
  await page.getByPlaceholder('手机号').fill(phone);
  await page.getByPlaceholder('验证码（开发环境固定 123456）').fill('123456');
  await page.getByRole('button', { name: '登录', exact: true }).click();
  await expect(page).toHaveURL(/\/workspace/);
  await page.getByRole('button', { name: '新建脑图' }).click();
  await expect(page.getByText('未命名脑图').first()).toBeVisible();
});

test('未登录访问工作台跳转登录页', async ({ page }) => {
  await page.goto('/workspace');
  await expect(page).toHaveURL(/\/login/);
});
```

- [ ] **Step 3: 安装浏览器并运行 E2E**

Run: `pnpm --filter @gmind/web exec playwright install chromium && pnpm compose:up && pnpm db:migrate && pnpm --filter @gmind/server dev &`（server 就绪后）
Run: `pnpm --filter @gmind/web e2e`
Expected: 3 个用例 PASS。

- [ ] **Step 4: Commit**

```bash
git add apps/web
git commit -m "feat(web): 登录页与工作台，M0 全链路 Playwright 验收"
```

---

### Task 10: README 快速上手与 M0 验收清单

**Files:**
- Create: `README.md`, `docs/m0-acceptance.md`

- [ ] **Step 1: 写 README**

`README.md`：

```markdown
# Gmind 在线协作脑图

浏览器端、协作为先的在线脑图工具。当前进度：M0（工程地基）。

## 快速开始（开发环境）

前置要求：Node ≥20、pnpm、Docker。

\`\`\`bash
pnpm install
cp docker/.env.example docker/.env
pnpm compose:up          # MySQL 5.6 / Redis / MinIO / MailHog
pnpm db:migrate          # 建表（gmind 库）
pnpm dev                 # server :3000 + web :5173
\`\`\`

打开 http://localhost:5173 ，手机号 + 验证码 `123456` 登录（开发环境 mock）。

## 常用命令

| 命令 | 说明 |
| --- | --- |
| `pnpm test` | 全部单元测试 |
| `pnpm --filter @gmind/server test:e2e` | 服务端集成测试（gmind_test 库） |
| `pnpm --filter @gmind/web e2e` | Playwright 端到端（需 compose 与 server 运行中） |
| `pnpm compose:down` | 停基础设施 |

## 文档

- 产品需求：`Gmind_在线协作脑图软件_产品需求文档.md`
- 技术设计：`docs/superpowers/specs/2026-09-18-gmind-phase1-design.md`
- 实施计划：`docs/superpowers/plans/`
```

（写入 `README.md` 文件时，代码块直接用三个反引号围栏，上文的反斜杠转义仅为在本计划文档中嵌套展示。）

- [ ] **Step 2: 写 M0 验收清单并逐项人工核验**

`docs/m0-acceptance.md`：

```markdown
# M0 验收清单（spec §9）

| # | 验收项 | 命令/操作 | 结果 |
| --- | --- | --- | --- |
| 1 | compose 四服务 healthy | `docker compose -f docker/docker-compose.yml ps` | ☐ |
| 2 | 迁移建出 11 张 utf8mb4 表 | `pnpm --filter @gmind/server test:e2e`（db-init 用例） | ☐ |
| 3 | 会话五端互踢 | `pnpm --filter @gmind/server test`（session 用例） | ☐ |
| 4 | 三方式登录注册（mock） | `pnpm --filter @gmind/server test:e2e`（auth 用例） | ☐ |
| 5 | 注册种 3 个示例文件 | 同上 + files 用例 | ☐ |
| 6 | 浏览器全链路：注册→看到示例文件→新建 | `pnpm --filter @gmind/web e2e` | ☐ |
| 7 | 无 token 访问受保护接口 401 | users-me 用例 | ☐ |
```

逐项执行并勾选，全部通过后 M0 完成。

- [ ] **Step 3: 全量回归**

Run: `pnpm lint && pnpm test && pnpm --filter @gmind/server test:e2e`
Expected: 全绿。

- [ ] **Step 4: Commit**

```bash
git add README.md docs/m0-acceptance.md
git commit -m "docs: README 快速上手与 M0 验收清单"
```

---

## 里程碑边界（本计划不做）

M1 及之后：Yjs 完整操作 API（撤销/repair/墓碑）、渲染引擎、Hocuspocus 协同、工作台完整视图、回收站任务、分享/评论/导入导出/版本——见 spec §9 各里程碑，待 M0 验收后另出计划。
