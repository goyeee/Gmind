# M4 导入导出与版本 实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 交付 PRD 一期的 XMind 导入导出、PNG/JPG 导出（自动展开折叠/透明底/倍率）、3 分钟自动快照 + 90 天保留 + 版本面板（时间轴/预览/恢复）+ 恢复广播（FR-IO-001~005、FR-VER-001/004），并收口准入台账 §7.10/§7.11。

**Architecture:** xmind-io 独立包（纯 TS 解析/生成，浏览器与服务端测试共用）；导入在浏览器端解析 → gmind-core 建文档 → 走既有建文件 API（服务端重算配额与节点数）；PNG/JPG 由 engine 离屏渲染 SVG → web 胶水内联图片后 Canvas 栅格化；版本快照挂在 collab 网关的持久化/卸载钩子（脏标记 + 3 分钟节流），恢复在 gmind-core 以结构化 op-diff 单事务应用回在线文档（经 y-sync 天然广播），恢复前自动存档 `pre_restore` 行。

**Tech Stack:** pnpm monorepo（apps/web React18+Vite、apps/server NestJS10+TypeORM+MySQL5.6、packages/shared zod、packages/gmind-core Yjs、packages/engine SVG）；新增 packages/xmind-io + fflate（zip 容器，无原生依赖）；Vitest + Playwright。

**Spec:** docs/superpowers/specs/2026-09-18-gmind-phase1-design.md（§4.3 版本快照与恢复、§5.10 导入导出执行位置、§8.6 埋点、里程碑表 M4 行）

## Global Constraints（全任务绑定）

- **唯一写入口**：任何对文档的写必须经 `@gmind/core` 操作 API，禁止直操 Y.Map（spec §3.3）。xmind-io 只做格式解析/生成（纯数据结构 `XmindNode`），建文档必须经 core。
- **校验先于事务**：Yjs 事务内抛错不回滚（M1a 裁定，全项目纪律）——所有校验与 diff 计算在 `withTransaction` 之外完成，事务内只做已验证的写。
- **MySQL 5.6**：实体列必须显式 `name`（snake_case）；索引键 ≤191 字符；无 JSON/CTE/窗口函数；迁移显式 utf8mb4。
- **tsx 无 DI 元数据**：Nest 类注入一律显式 `@Inject(ClassToken)`。
- **实体/迁移显式注册**：新实体加入 database 的实体数组（`apps/server/src/database/`），目录守卫测试同步更新。
- **配额口径**：节点数上限 = `countAliveReachable` ≤ `MAX_DOC_NODES`（500）；文件数 ≤100；口径源 `@gmind/shared`。
- **权限口径**：读 = `canAccess`（owner 或协作者，缺失/已删/无权统一 404 不泄露）；恢复版本 = owner 或 editor；一期角色集只有 owner/editor（分享加入即 editor）。
- **导入解析失败必须可归因**：格式不支持 / 文件损坏 / 超过 20MB 三种提示（FR-IO-001）。
- **导出自动展开折叠**仅作用于导出快照，不改画布状态（spec §4.2 第 5 条、FR-EDT-030）。
- **测试输出 pristine**；每个任务 TDD（先失败后通过）；提交信息 `feat:/fix:/test:/docs:` 风格。
- **本计划不做**（登记防口径漂移）：FR-IO PDF/SVG 导出（二期）、FreeMind/Markdown/OPML/TXT 导入（二期）、FR-VER-002 手动版本（三期）、FR-VER-003 版本对比（二期）、导入图片对象提取（.xmind 内嵌图按 FR-IO-002 降级计数，不入库）。

## 恢复语义裁定（T7/T8 绑定，需求方未提异议前按此实现）

1. **恢复范围**：节点树（结构+顺序）、节点文本、备注、链接、图标、图片、节点样式、折叠态、doc meta 的 `structureType`/`themeId`。**不含 doc meta.title**（工作台文件名不随恢复变化；PRD FR-VER-004 口径是「画布内容」）。
2. **墓碑不可复活**：快照中存活而当前已删的节点以**新 ULID** 重建（Yjs 墓碑永久）。旧节点上的评论因 node_id 解耦呈现「原节点已删除」（M3b 已有语义，作为恢复×评论的产品裁定登记到验收文档）。
3. **恢复可逆**：恢复前当前状态写 `type='pre_restore'` 行（`restored_from` 指向目标快照）；时间轴上它就是 PRD 所说「恢复自某版本的记录」。
4. **恢复广播**：live 文档经服务端事务 → y-sync 自动同步全部在线端（spec §4.3）；无人在线时走落库路径。恢复 op 以 `ORIGIN_RESTORE` 应用，不进任何端撤销栈（UndoManager 仅 ORIGIN_USER）；撤销语义由「再恢复到 pre_restore 行」承担。

---

### Task 1: 准入前置——§7.10 登录回填扩展 + §7.11 提醒双重邮件

**Files:**
- Modify: `apps/server/src/auth/auth.service.ts:21-46`（回填移出 `if (!user)` 门控）
- Modify: `apps/server/src/jobs/cleanup.service.ts:88-98`（remind() 落行带 emailed_at）
- Test: `apps/server/test/share.e2e-spec.ts`（追加已注册受邀者用例）
- Test: `apps/server/test/trash.e2e-spec.ts`（追加摘要去重用例）

**Interfaces:**
- Consumes: `InviteService.acceptPendingForNewUser(user: UserEntity): Promise<void>`（现状已幂等：pending 过滤 + uk_invite + In 批量置 accepted）；`DigestService.runDigest(now)`。
- Produces: 已注册受邀者登录即获得授权（无新端点）；回收站提醒行 `emailedAt` 非空（digest 不再重复发信）。

- [ ] **Step 1: 写失败测试（§7.10）**

在 `share.e2e-spec.ts` 邀请组追加（沿用该文件既有注册/登录 helper）：

```ts
it('准入 7.10：已注册用户被邀请，登录后自动获得授权（不再永久悬挂）', async () => {
  // ① 受邀者先注册（产生既有账号）
  const invitee = await registerUser({ email: 'reg710@test.dev' });
  // ② owner 邀请该已注册邮箱 → pending 行 + 邮件
  await ownerInvite(ownerToken, fileId, ['reg710@test.dev']);
  // ③ 受邀者用同一邮箱再登录（旧代码：回填仅新用户创建路径，此处必失败）
  const res = await login({ email: 'reg710@test.dev' });
  expect(res.status).toBe(200);
  // ④ 协作者行存在且 shared 视图可见
  const row = await dbCount(collaborators, { fileId, userId: invitee.id });
  expect(row).toBe(1);
  const shared = await reqGet(`/api/files?view=shared`, res.body.token);
  expect(shared.body.items.some((f: { id: string }) => f.id === fileId)).toBe(true);
});
```

（具体 helper 名以该 spec 文件现状为准：文件内已有 register/invite/login 的私有函数，保持同文件风格。）

- [ ] **Step 2: 写失败测试（§7.11）**

在 `trash.e2e-spec.ts` 准入 7.9 用例之后追加：

```ts
it('准入 7.11：回收站提醒的即时邮件不触发 15 分钟摘要重发（emailed_at 落行）', async () => {
  // 触发提醒（同 7.9 用例的编排：软删 → runCleanup(+27d)）
  await runCleanupAt(+27 * 24 * 60 * 60 * 1000);
  const rows = await notifRows(type: 'system');
  expect(rows).toHaveLength(1);
  expect(rows[0].emailedAt).not.toBeNull();      // ← 修复点：旧代码为 null
  // 15 分钟后 digest 扫描：该行已收敛，不产生第二封
  const mails: string[] = [];
  await runDigestAt(+16 * 60 * 1000);
  expect(mails).toHaveLength(0);                  // mailService spy 断言（同 notify spec 摘要组模式）
});
```

- [ ] **Step 3: 运行确认失败**

Run: `pnpm --filter @gmind/server test:e2e -- trash.e2e-spec share.e2e-spec`
Expected: 两个新用例 FAIL（emailedAt 为 null / 协作者行 count=0）。

- [ ] **Step 4: 实现（两处各为一处小改）**

`auth.service.ts`：把回填 try/catch 块移到 `if (!user)` 之外、`sessions.create` 之前，对新旧用户都执行；注释改为：

```ts
// 准入 7.10 裁定：回填对已注册用户同样生效（每次登录尽力触发，天然重试）；
// 幂等由 acceptPendingForNewUser 的 pending 过滤 + uk_invite 保证。失败隔离：
// 事务化且捕获记录，不波及登录主流程（口径同邮件旁路）。
try {
  await this.invites.acceptPendingForNewUser(user);
} catch (err) { console.error('[invite-backfill] 登录回填失败（已隔离）', err); }
```

新用户分支里原调用删除（避免双重触发；`createSeedFiles` 保持在 `if (!user)` 内）。

`cleanup.service.ts` `remind()`：落行前补 `notification.emailedAt = new Date();`，注释：

```ts
// 准入 7.11：即时邮件已发（或无邮箱天然不可达），行级 emailed_at 置位使
// DigestService 扫描跳过本行——回收站提醒不再 15 分钟后重发第二封。
```

（核对 NotificationEntity 的列名确为 `emailed_at`/属性 `emailedAt`，与 digest.service markEmailed 同字段。）

- [ ] **Step 5: 运行确认通过**

Run: `pnpm --filter @gmind/server test:e2e`
Expected: 全量 PASS（share 22+1、trash 9+1）。

- [ ] **Step 6: 台账回写 + 提交**

`docs/m2-entry-checklist.md` §7.10/§7.11 各加一行「**已收口（M4 T1，commit <sha>）**」。提交：

```bash
git add -A && git commit -m "fix(server): 准入 7.10 登录回填覆盖已注册用户、7.11 提醒落行带 emailed_at"
```

---

### Task 2: 邀请对话框 UI（M3b 缺口收口）

**Files:**
- Modify: `apps/web/src/editor/MemberPanel.tsx`（加邀请区）
- Test: `apps/web/e2e/member-invite.e2e.spec.ts`（新建）

**Interfaces:**
- Consumes: `POST /api/files/:id/invites` body `{contacts: string[]}`（M3b 已有：200 `{accepted: n}`、400 `{message, invalid: [{contact, reason}]}` 逐条错误、非 owner 404）；`GET /api/files/:id/collaborators`。
- Produces: MemberPanel 内 testid `invite-section`（textarea `invite-input`、按钮 `invite-submit`、结果 toast）；无新 API。

- [ ] **Step 1: 写失败 e2e**

```ts
// apps/web/e2e/member-invite.e2e.spec.ts
import { expect, test, type Page } from '@playwright/test';

async function registerAndLogin(page: Page): Promise<string> { /* 同 share.e2e.spec.ts 的模式：新手机号注册 → /workspace，返回 token 需要时用 page.evaluate(localStorage) */ }

test('成员面板邀请：粘贴多个地址批量邀请成功；非法地址逐条报错', async ({ page }) => {
  await openSeedDoc(page, '本周计划');                       // 沿用既有 helper（rich-content spec 同款）
  await page.getByTestId('members-toggle').click();          // 打开成员面板（核对 EditorPage 实际 testid）
  const input = page.getByTestId('invite-input');
  await input.fill('a@test.dev, 13900000001\nb@test.dev');
  await page.getByTestId('invite-submit').click();
  await expect(page.getByTestId('toast')).toContainText('已邀请 3 位');
  // 非法整批拒绝且逐条列出
  await input.fill('bad-email');
  await page.getByTestId('invite-submit').click();
  await expect(page.getByTestId('toast')).toContainText('bad-email');
});
```

（打开成员面板的按钮 testid 与面板结构以 `EditorPage.tsx:1443` 的 MemberPanel 装配与组件现状为准，缺失则本任务补 toolbar 按钮。）

- [ ] **Step 2: 运行确认失败**

Run: `WEB_PORT=5174 API_ORIGIN=http://localhost:3001 pnpm --filter @gmind/web e2e -- member-invite`
Expected: FAIL（invite-input 不存在）。

- [ ] **Step 3: 实现 MemberPanel 邀请区**

MemberPanel 底部加 `<section data-testid="invite-section">`：说明文案（「粘贴邮箱或手机号，逗号/空格/换行分隔，上限 50」）、textarea、提交按钮。逻辑：split `/[,\s;；、\n]+/` 过滤空串 → `api(POST /files/${fileId}/invites, {contacts})` → 成功 toast「已邀请 N 位」并调 props 的成员刷新（核对 MemberPanel 现有 props：若无刷新回调，通过 onInvited 可选 props 让 EditorPage 重新拉 collaborators）；400 时 toast 逐条 `invalid.map(i => `${i.contact}：${i.reason}`)` 前 3 条拼接。仅 owner 显示（members 数据里有 ownerUserId，同 WorkspacePage 行菜单的判定模式）。

- [ ] **Step 4: 运行确认通过 + 全量回归**

Run: `WEB_PORT=5174 API_ORIGIN=http://localhost:3001 pnpm --filter @gmind/web e2e`
Expected: 全量 PASS。

- [ ] **Step 5: 提交**

```bash
git add -A && git commit -m "feat(web): 成员面板邀请对话框——批量粘贴邮箱/手机号（M3b 缺口收口）"
```

---

### Task 3: xmind-io 包——parseXmind（content.json/content.xml 双路径）+ buildXmind

**Files:**
- Create: `packages/xmind-io/package.json`、`tsconfig.json`、`vitest.config.ts`（照抄 packages/gmind-core 对应文件，包名 `@gmind/xmind-io`，deps 只加 `fflate`）
- Create: `packages/xmind-io/src/index.ts`（导出面）、`src/parse-json.ts`（2020+ content.json）、`src/parse-xml.ts`（XMind 8 content.xml）、`src/build.ts`、`src/types.ts`
- Test: `packages/xmind-io/src/parse.test.ts`、`src/build.test.ts`、`src/roundtrip.test.ts`
- Modify: 根 `tsconfig` references / 各 tsconfig paths（照 gmind-core 在 apps/web、apps/server 的引用模式接线，使 `@gmind/xmind-io` 可被 web import）

**Interfaces:**
- Produces（后续任务依赖的精确签名）:

```ts
// packages/xmind-io/src/index.ts
export interface XmindNode { title: string; note?: string; children: XmindNode[]; }
export type DegradedKind = 'style' | 'media' | 'structure';
export interface DegradedItem { kind: DegradedKind; count: number; }
export type XmindErrorCode = 'UNSUPPORTED_FORMAT' | 'CORRUPTED' | 'EMPTY';
export class XmindParseError extends Error { readonly code: XmindErrorCode; }
/** 解析 .xmind（zip 容器）：content.json（2020+）优先，回落 content.xml（XMind 8）。
 *  只保留层级/文本/备注；样式、标记、标签、图片、附件、漂浮主题、概要、额外 sheet 计入降级。 */
export function parseXmind(bytes: Uint8Array): { root: XmindNode; degraded: DegradedItem[] }
/** 生成 2020+ 格式 zip：[content.json, metadata.json]。 */
export function buildXmind(root: XmindNode): Uint8Array
```

- [ ] **Step 1: 脚手架 + 失败测试**

包文件照抄 gmind-core 的配置骨架（package.json name/exports/main、tsconfig、vitest）。`parse.test.ts` 用 fflate 在测试内构造 zip 夹具（无需二进制 fixture 文件）：

```ts
import { describe, expect, it } from 'vitest';
import { strToU8, zipSync } from 'fflate';
import { parseXmind, XmindParseError } from './index';

const sheet = (rootTopic: unknown) => JSON.stringify([{ class: 'sheet', title: 'Sheet 1', rootTopic }]);

it('解析 2020+ content.json：层级/文本/备注', () => {
  const bytes = zipSync({ 'content.json': strToU8(sheet({
    class: 'topic', title: '中心', notes: { plain: { content: '根备注' } },
    children: { attached: [
      { class: 'topic', title: 'A', children: { attached: [{ class: 'topic', title: 'A1' }] } },
      { class: 'topic', title: 'B' },
    ] },
  })) });
  const { root, degraded } = parseXmind(bytes);
  expect(root.title).toBe('中心');
  expect(root.note).toBe('根备注');
  expect(root.children.map((c) => c.title)).toEqual(['A', 'B']);
  expect(root.children[0].children[0].title).toBe('A1');
  expect(degraded).toEqual([]);
});

it('降级计数：markers/labels/图片备注/漂浮主题/额外 sheet', () => {
  const bytes = zipSync({ 'content.json': strToU8(sheet({
    class: 'topic', title: '中心', markers: [{ markerId: 'priority-1' }],
    children: { attached: [
      { class: 'topic', title: 'A', labels: ['标签'], notes: { realHTML: { content: '<b>富</b>' } } },
    ], detached: [{ class: 'topic', title: '漂浮' }] },
  })), 'metadata.json': strToU8('{}') });
  // 两个 sheet：第二个只计入降级
  const bytes2 = zipSync({ 'content.json': strToU8(`[${JSON.parse(sheet({ class: 'topic', title: 'x' }))[0] ? '' : ''}]`) });
  void bytes2;
  const { root, degraded } = parseXmind(bytes);
  expect(root.children).toHaveLength(1);          // detached 不进树
  expect(root.children[0].note).toBe('富');       // realHTML 剥标签取文本
  const kinds = Object.fromEntries(degraded.map((d) => [d.kind, d.count]));
  expect(kinds.style).toBeGreaterThanOrEqual(2);  // markers + labels
  expect(kinds.media).toBeUndefined();            // 本例无媒体
  expect(kinds.structure).toBeGreaterThanOrEqual(1); // detached
});
```

（测试中「额外 sheet」与 `EMPTY`/损坏/无 content.json 的 xml 回落用例，按同样构造方式补齐：损坏 = 非法 zip 字节；xml 回落 = 只给 `content.xml` 的 zip；无有效内容 = `XmindParseError` `code='EMPTY'`。）

- [ ] **Step 2: 运行确认失败**

Run: `pnpm --filter @gmind/xmind-io test`
Expected: FAIL（模块未实现）。

- [ ] **Step 3: 实现解析器**

`parse-json.ts`：`unzipSync`（fflate）→ 找 `content.json`（无则返回 null 交由上层回落 xml）→ `JSON.parse` → sheet 数组取 `[0]`，其余 sheet 计 `structure` 降级 → 递归 `walkTopic(topic)`：

```ts
function walkTopic(t: JsonTopic): XmindNode {
  let degradedStyle = 0;
  if (t.markers) degradedStyle += t.markers.length;
  if (t.labels) degradedStyle += t.labels.length;
  // 图片/附件在 topic.image / topic.attachments → media 计数
  const note = t.notes?.plain?.content
    ?? (t.notes?.realHTML?.content ? stripHtml(t.notes.realHTML.content) : undefined);
  return { title: typeof t.title === 'string' ? t.title : '', note, children: (t.children?.attached ?? []).map(walkTopic) };
}
```

`parse-xml.ts`：`content.xml` 用 `DOMParser`（浏览器原生；测试文件头加 `// @vitest-environment jsdom`，web 的 devDependencies 已含 jsdom 则复用，否则 xmind-io 自加）解析 `<sheet><topic>` 树：`topic > title`、`children > topics[type=attached] > topic` 递归、`notes > plain` 文本。根元素非 `<map`/`<sheet` → `CORRUPTED`。
`index.ts` `parseXmind`：非 zip（unzipSync 抛）→ `CORRUPTED`；两文件都无 → `UNSUPPORTED_FORMAT`；树空（root title 空且无 children 视为空？不——title 空合法，rootTopic 缺失才 EMPTY）。降级聚合同 kind 求和，count=0 的不输出。

`build.ts`：

```ts
export function buildXmind(root: XmindNode): Uint8Array {
  const topic = (n: XmindNode): JsonTopic => ({
    class: 'topic', title: n.title,
    ...(n.note ? { notes: { plain: { content: n.note } } } : {}),
    ...(n.children.length ? { children: { attached: n.children.map(topic) } } : {}),
  });
  const content = JSON.stringify([{ class: 'sheet', title: 'Sheet 1', rootTopic: topic(root) }]);
  return zipSync({ 'content.json': strToU8(content), 'metadata.json': strToU8('{"creator":"Gmind"}') });
}
```

- [ ] **Step 4: 往返测试**

`roundtrip.test.ts`：`buildXmind(tree) → parseXmind → deep-equal 原 tree`（含 note、多层、空 children）；`buildXmind` 产物可被 `unzipSync` 读回 `content.json`。

- [ ] **Step 5: 运行通过 + lint/typecheck + 提交**

Run: `pnpm --filter @gmind/xmind-io test && pnpm typecheck && pnpm lint`
Expected: 全 PASS。

```bash
git add -A && git commit -m "feat(xmind-io): 新包——.xmind 解析（2020+ json/8 xml 双路径）与生成，降级计数"
```

---

### Task 4: XMind 导入端到端（API 扩展 + 工作台入口）

**Files:**
- Modify: `apps/server/src/files/files.controller.ts`（POST /api/files body 增 `docState?`）
- Modify: `apps/server/src/files/files.service.ts:75-130`（createForUser/buildFile 支持初始 state：`docFromState` 损坏 400、`countAliveReachable` 重算 nodeCount、> MAX_DOC_NODES 400）
- Create: `apps/web/src/editor/xmind-import.ts`（导入胶水：file → {title, state}）
- Modify: `apps/web/src/pages/WorkspacePage.tsx`（工具栏「导入」按钮 + file input + 错误 toast）
- Test: `apps/server/test/file-content.e2e-spec.ts`（追加导入 API 用例）、`apps/web/e2e/import-export.e2e.spec.ts`（新建）

**Interfaces:**
- Consumes: Task 3 `parseXmind`；core `createTemplateDoc`/`addChild`/`setNote`/`docToState`（组装）。
- Produces: `POST /api/files` body `{title, folderId?, docState?}`（docState=base64 Yjs update；200 响应与现有建文件一致）；web `importXmindFile(file: File): Promise<{title: string; state: string; degraded: DegradedItem[]}>`，错误以 `Error.message` 归因（'文件大小超过 20MB 上限' / '无法识别的文件格式' / '文件已损坏，无法解析'）。

- [ ] **Step 1: 写失败服务端测试**

`file-content.e2e-spec.ts` 追加：

```ts
it('导入：携带 docState 建文件——nodeCount 服务端重算、层级落库', async () => {
  // 测试内构造：createTemplateDoc('中心') + addChild('A') + setNote → docToState → base64
  const state = await buildDocStateViaCore();   // helper 放本 spec 顶部（import @gmind/core）
  const res = await appReq().post('/api/files').set(token).send({ title: '导入件', docState: state });
  expect(res.status).toBe(201);
  const got = await appReq().get(`/api/files/${res.body.id}`).set(token);
  expect(got.body.nodeCount).toBe(2);
  // 超节点数拒绝：构造 501 节点 doc → 400，文案含「节点数」
  // 损坏 docState → 400（docFromState 抛错映射）
});
```

- [ ] **Step 2: 服务端实现**

controller：POST body zod schema 扩展 `docState: z.string().max(4_000_000).optional()`（base64 后文本型文档远小于 2mb JSON 上限；20MB 的 .xmind 中媒体已降级不入 docState）。service：`state` 存在时 `docFromState(Buffer.from(state, 'base64'))`（抛 → 400 '文件已损坏'）→ `nodeCount = countAliveReachable(doc)` → 传给既有 buildFile 路径（该路径已做配额检查；> MAX → 既有文案）。

- [ ] **Step 3: 运行服务端测试通过后写失败 web e2e**

`import-export.e2e.spec.ts`（夹具在测试内用 `@gmind/xmind-io` 的 `buildXmind` 构造 buffer——web 测试进程能 import workspace 包，沿用 e2e 里直接 import core 的先例；若不行则用 `node:child_process` 调 vitest-node 脚本生成，实现者按可行性选其一并在报告注明）：

```ts
test('工作台导入 .xmind：新文件出现且层级/备注正确渲染', async ({ page }) => {
  await registerAndLogin(page);
  await page.getByTestId('import-button').click();
  await page.getByTestId('import-input').setInputFiles({
    name: '项目.xmind', mimeType: 'application/octet-stream', buffer: buildXmindFixtureBytes(),
  });
  await expect(page.locator('.file-list li', { hasText: '项目' })).toBeVisible();
  await page.locator('.file-list li', { hasText: '项目' }).click();
  await expect(page.locator('.editor-canvas svg .gm-text', { hasText: '根主题' })).toBeVisible();
  await expect(page.locator('.editor-canvas svg .gm-text', { hasText: '分支A' })).toBeVisible();
});
test('导入 25MB 超限：提示大小上限；损坏文件：提示已损坏', async ({ page }) => {
  /* 超限 buffer 用 Buffer.alloc(21 * 1024 * 1024, 0) 恒定填充（zip 头无效即「已损坏」——
     大小检查先于解析，必须先看到「大小超过」；损坏用例用 < 20MB 的乱字节） */
});
```

- [ ] **Step 4: web 实现**

`xmind-import.ts`：

```ts
export async function importXmindFile(file: File): Promise<{ title: string; state: string; degraded: DegradedItem[] }> {
  if (file.size > 20 * 1024 * 1024) throw new Error('文件大小超过 20MB 上限');
  const bytes = new Uint8Array(await file.arrayBuffer());
  let parsed: ReturnType<typeof parseXmind>;
  try { parsed = parseXmind(bytes); } catch (e) {
    if (e instanceof XmindParseError) {
      throw new Error(e.code === 'UNSUPPORTED_FORMAT' ? '无法识别的文件格式（仅支持 .xmind）' : '文件已损坏，无法解析');
    }
    throw new Error('文件已损坏，无法解析');
  }
  const doc = createTemplateDoc({ title: parsed.root.title || file.name.replace(/\.xmind$/i, '') });
  // 组装：先序遍历 XmindNode，addChild(parentId, {text}) + setNote；root 用 ROOT_NODE_ID
  const state = docToState(doc);
  return { title: docMetaTitle(doc), state: bytesToBase64(state), degraded: parsed.degraded };
}
```

（base64 编码用与 `useEditorDoc.ts` 的 base64ToBytes 对称的实现；大数组用分块 `String.fromCharCode` 防 call stack。）WorkspacePage：工具栏加「导入」button（testid `import-button`）+ 隐藏 `<input type="file" accept=".xmind" data-testid="import-input">` → 成功后刷新列表 + 降级提示 toast（`degraded.length > 0` 时「已降级处理 N 项（样式 n/媒体 n/结构 n）」，FR-IO-002）→ 失败 toast 显示归因文案。

- [ ] **Step 5: 运行通过 + 全量回归 + 提交**

Run: `pnpm --filter @gmind/server test:e2e && WEB_PORT=5174 API_ORIGIN=http://localhost:3001 pnpm --filter @gmind/web e2e`

```bash
git add -A && git commit -m "feat: XMind 导入——API 携带 docState + 工作台导入入口与降级提示（FR-IO-001/002）"
```

---

### Task 5: XMind 导出（工具栏 + 往返 e2e）

**Files:**
- Create: `apps/web/src/editor/xmind-export.ts`
- Modify: `apps/web/src/pages/EditorPage.tsx`（工具栏导出菜单：XMind 项）
- Test: `apps/web/e2e/import-export.e2e.spec.ts`（追加导出与往返用例）

**Interfaces:**
- Consumes: Task 3 `buildXmind`；core `getNode`/`childrenIds`（遍历存活树）。
- Produces: `exportXmind(doc: Y.Doc, title: string): void`（生成并触发浏览器下载 `${title}.xmind`）；导出菜单 testid `export-menu` / `export-xmind`。

- [ ] **Step 1: 失败 e2e（导出 + 往返）**

```ts
test('导出 XMind 并往返导入：层级/文本/备注一致', async ({ page }) => {
  await openSeedDocWithNote(page);                     // 选中节点写备注（复用面板 API 或 UI 操作）
  const [download] = await Promise.all([
    page.waitForEvent('download'),
    page.getByTestId('export-xmind').click(),
  ]);
  const path = await download.path();
  const bytes = new Uint8Array(await fs.promises.readFile(path));
  const parsed = parseXmind(bytes);                    // 直接用 xmind-io 断言结构
  expect(parsed.root.title).toBe('本周计划');
  expect(findTitle(parsed.root, '周一')?.note).toBe('评审要点');
  // 往返：把下载产物 setInputFiles 导入 → 新文件出现
});
```

- [ ] **Step 2: 实现**

`xmind-export.ts`：先序遍历 doc（`getNode(doc, id)` 的 `childIds`）→ `XmindNode` 树 → `buildXmind` → `Blob` 下载（URL.createObjectURL + a.download + revoke）。树遍历从 `ROOT_NODE_ID` 起，只走 `childIds`（天然存活可达，墓碑与折叠无关——数据层完整，FR-IO-004 的「层级类导出先自动展开」在本架构下自动满足，注释注明）。EditorPage：工具栏「导出」按钮（testid `export-menu`）点开下拉，含 `export-xmind`（本任务）与 PNG/JPG 占位（Task 9 实现——**不放死按钮**：Task 9 前菜单只有 XMind 一项）。

- [ ] **Step 3: 通过 + 提交**

```bash
git add -A && git commit -m "feat(web): XMind 导出下载与导出菜单（FR-IO-004 一期 XMind 部分）"
```

---

### Task 6: 版本快照（collab 网关）+ VersionEntity/restored_from 迁移 + 90 天清理

**Files:**
- Create: `apps/server/src/versions/version.entity.ts`、`apps/server/src/database/migrations/20260926000000-versions-restored-from.ts`
- Modify: `apps/server/src/database/`（实体注册数组 + 目录守卫测试）
- Modify: `apps/server/src/collab/collab.service.ts`（快照状态机）
- Modify: `apps/server/src/jobs/cleanup.service.ts`（90 天清理）
- Modify: `apps/server/src/jobs/jobs.module.ts`（forFeature 注册 VersionEntity）
- Test: `apps/server/test/versions.e2e-spec.ts`（新建）、cleanup 既有 spec 追加

**Interfaces:**
- Produces:

```ts
// version.entity.ts（显式列名纪律）
@Entity('versions')
export class VersionEntity {
  @PrimaryColumn({ type: 'char', length: 26, name: 'id' }) id!: string;          // ULID，写入时生成
  @Column({ type: 'char', length: 26, name: 'file_id' }) fileId!: string;
  @Column({ type: 'int', name: 'node_count' }) nodeCount!: number;
  @Column({ type: 'char', length: 26, name: 'created_by', nullable: true }) createdBy!: string | null;
  @Column({ type: 'enum', enum: ['auto', 'manual', 'pre_restore'], name: 'type' }) type!: 'auto' | 'manual' | 'pre_restore';
  @Column({ type: 'longblob', name: 'state' }) state!: Buffer;
  @Column({ type: 'datetime', precision: 3, name: 'created_at' }) createdAt!: Date;
  @Column({ type: 'char', length: 26, name: 'restored_from', nullable: true }) restoredFrom!: string | null;
}
// collab.service.ts 新增（T7 恢复路径复用）
withLiveDocument<T>(fileId: string, fn: (doc: Y.Doc) => T): T | null
// cleanup 返回值扩展
runCleanup(now): Promise<{ purged: number; reminded: number; versionsPurged: number }>
```

- [ ] **Step 1: 迁移 + 实体 + 失败测试**

迁移：`ALTER TABLE versions ADD COLUMN restored_from char(26) NULL`（down 反向 drop）。实体照 Interfaces 块。实体注册数组追加 + 守卫测试更新（照既有模式）。`versions.e2e-spec.ts`：

```ts
it('快照：编辑落库后过 3 分钟窗口落 auto 版本行（注入时钟直调）', async () => {
  const collab = app.get(CollabService);
  // 建立连接并编辑（复用 collab.e2e-spec.ts 的 provider client 模式）→ 等待 storeDocument
  // 直调快照入口（public，供 e2e 注入时钟）：
  const due = await collab.snapshotIfDue(fileId, Date.now() + 4 * 60 * 1000);
  expect(due).toBe(true);
  const rows = await versionRows(fileId);
  expect(rows).toHaveLength(1);
  expect(rows[0].type).toBe('auto');
  expect(rows[0].nodeCount).toBe(编辑后节点数);
  expect(rows[0].createdBy).toBe(editorUserId);
});
it('快照：无变更不落行；间隔内不重复落', async () => { /* dirty=false 直调 → false；2 分钟后再调 → false */ });
it('快照：卸载时脏文档落行（snapshotIfDirty）', async () => { /* 断开全部连接后行存在 */ });
it('清理：90 天前版本行删除、保留期内保留', async () => {
  // 直插两行（createdAt 老/新）→ runCleanup(now) → versionsPurged=1 且老行无新行在
});
```

- [ ] **Step 2: 实现快照状态机**

collab.service.ts：

```ts
private static readonly SNAPSHOT_INTERVAL_MS = 3 * 60 * 1000;
private readonly snapMeta = new Map<string, { lastAutoAt: number; dirty: boolean }>();
private ensureSnapMeta(name: string): { lastAutoAt: number; dirty: boolean } { /* get or init {now, false} */ }
// onChange：ensureSnapMeta + dirty=true
// authenticate 成功后：ensureSnapMeta(documentName)
// storeDocument 成功（ack 广播前）：await this.snapshotIfDue(fileId, Date.now())
// beforeUnloadDocument：await this.snapshotIfDirty(...)，然后 snapMeta.delete(name)

/** 脏文档且距上次自动快照 ≥3 分钟 → 写 auto 行（FR-VER-001「有变更才写」由 dirty 保证）。 */
async snapshotIfDue(fileId: string, now: number): Promise<boolean> {
  const meta = this.snapMeta.get(fileId);
  const doc = this.hocuspocus.documents.get(fileId);
  if (!meta?.dirty || !doc || now - meta.lastAutoAt < CollabService.SNAPSHOT_INTERVAL_MS) return false;
  await this.insertVersionSnapshot(fileId, doc, 'auto', now);
  meta.lastAutoAt = now; meta.dirty = false;
  return true;
}
/** 卸载兜底：会话结束时有未落快照的变更 → 立即落行（补「编辑 1 分钟即关页」窗口）。 */
async snapshotIfDirty(fileId: string, now: number): Promise<boolean> { /* dirty 即落，不看间隔 */ }
private async insertVersionSnapshot(fileId, doc, type, now, restoredFrom?): Promise<string> {
  // id=ulid()（server 侧生成，核对项目内 ULID 生成来源——users/files 同款）、
  // nodeCount=countAliveReachable(doc)、createdBy=getLastEditor(doc)、state=Buffer.from(docToState(doc))、
  // createdAt=new Date(now)
}
```

（`getLastEditor`/`countAliveReachable`/`docToState` 均已在 collab.service 引用。createdBy 为 null 合法——显示层兜底。）cleanup：`InjectRepository(VersionEntity)` + runCleanup 末尾 `const r = await this.versionRepo.delete({ createdAt: LessThanOrEqual(before90d) }); return { ..., versionsPurged: r.affected ?? 0 }`（DELETE 全表按 created_at 过滤在 versions 量级可接受；不加新索引，注释说明）。

- [ ] **Step 3: 通过 + 提交**

Run: `pnpm --filter @gmind/server test:e2e`

```bash
git add -A && git commit -m "feat(server): 版本快照——collab 脏标记+3 分钟节流+卸载兜底、90 天清理（FR-VER-001）"
```

---

### Task 7: core restoreFromSnapshot + 版本 REST（列表/取态/恢复）+ events 端点

**Files:**
- Create: `packages/gmind-core/src/restore.ts` + `restore.test.ts`（core index.ts 导出）
- Create: `apps/server/src/versions/versions.service.ts`、`versions.controller.ts`、`versions.module.ts`
- Create: `apps/server/src/events/event.entity.ts`、`events.service.ts`（表已存在，实体新建：id/type/file_id/user_id/payload/created_at 显式列名）+ 注册 + 守卫更新
- Modify: `apps/server/src/app.module.ts`（VersionsModule/EventsModule）、`packages/gmind-core/src/index.ts`（导出 + ORIGIN_RESTORE）
- Test: `packages/gmind-core/src/restore.test.ts`、`apps/server/test/versions.e2e-spec.ts`（恢复组）

**Interfaces:**
- Consumes: Task 6 `VersionEntity`/`withLiveDocument`；core 既有 `withTransaction`/`addChild`/`setText`/`setNote`/`setHref`/`setIcon`/`setImage`/`setStyle`/`setCollapsed`/`moveNode`/`deleteNodes`/`getNode`/`getMeta`/`setDocMeta`/`countAliveReachable`/`docFromState`/`docToState`/`childrenIds`/`isAlive`。
- Produces:

```ts
// packages/gmind-core/src/restore.ts
export const ORIGIN_RESTORE = 'restore';
export interface RestoreResult { deleted: number; created: number; moved: number; updated: number; }
/** 将 target 就地恢复为 snapshot 的内容（结构 op-diff，单事务，ORIGIN_RESTORE）。
 *  前置：两 doc 均为已 normalize 的本项目文档。快照中存活而当前墓碑的节点以新 ULID 重建。 */
export function restoreFromSnapshot(target: Y.Doc, snapshot: Y.Doc): RestoreResult
// versions REST（server）
GET    /api/files/:fileId/versions          → {items: [{id, nodeCount, type, createdAt, createdByName, restoredFrom}]}   // canAccess
GET    /api/files/:fileId/versions/:vid     → {id, nodeCount, type, createdAt, createdByName, restoredFrom, state(base64)} // canAccess
POST   /api/files/:fileId/versions/:vid/restore → {preRestoreVersionId}                                                    // owner/editor
POST   /api/events                          → 204（埋点通道：body {type: string, fileId?: string, payload?: object}，登录即可）
```

- [ ] **Step 1: core 失败测试**

`restore.test.ts`（场景全部先建 target、再建 snapshot 同源 doc，操作走 core API）：

```ts
it('恢复：文本/结构差异收敛到快照；多余子树删除', () => {
  const base = makeDoc();                       // root+A+B
  const snap = docFromState(docToState(base));  // 快照定档
  setText(base, idOf('A'), '改了');              // 文本漂移
  addChild(base, idOf('B'), { text: '新增' });   // 多余节点
  const r = restoreFromSnapshot(base, snap);
  expect(r.deleted).toBe(1);
  expect(getNode(base, idOf('A'))!.text).toBe('A');
  expect(countAliveReachable(base)).toBe(3);
});
it('恢复：快照中已删节点以新 id 重建，内容完整（text/note/href/icons/image/collapsed）', () => {
  const base = makeDoc();   // root + A(note/href/图标/图/collapsed=true) + A1
  const snap = docFromState(docToState(base));
  deleteNodes(base, [idOf('A')]);
  const before = countAliveReachable(base);
  restoreFromSnapshot(base, snap);
  expect(countAliveReachable(base)).toBe(before);
  const restored = aliveNodesExceptRoot(base).find((n) => getNode(base, n)!.text === 'A')!;
  const s = getNode(base, restored)!;
  expect(s.note).toBe('原备注'); expect(s.href).toBe('https://x'); expect(s.icons).toEqual({ flag: 'flag-red' });
  expect(s.collapsed).toBe(true);
  expect(s.childIds).toHaveLength(1);           // A1 重建在其下
});
it('恢复：乱序重排收敛到快照同层顺序；meta 恢复 structureType/themeId 不动 title', () => { /* moveNode 后 childrenIds 顺序断言；setDocMeta({title}) 后恢复 title 不被回滚 */ });
it('恢复：对一致状态零操作（不开事务、计数全零）；双跑幂等', () => { /* 两次 restore 第二次全零 */ });
it('恢复：不进撤销栈（ORIGIN_RESTORE 隔离 UndoManager）', () => { /* createUndoManager 后 restore，undo 不回滚恢复 */ });
```

- [ ] **Step 2: core 实现（算法写死，防自由发挥）**

```ts
export function restoreFromSnapshot(target: Y.Doc, snapshot: Y.Doc): RestoreResult {
  // ——全部读取与 diff 计算在事务外（校验先于事务纪律）——
  const tAlive = reachableAliveIds(target);      // 内部 helper：root 先序遍历 childIds
  const sAlive = reachableAliveIds(snapshot);
  const sNode = (id: string) => getNode(snapshot, id)!;
  const plan: Op[] = [];
  // ① 删除：target 有而快照无（只删顶层——父被删的深层随子树走；isAlive 过滤）
  for (const id of tAlive) if (!sAlive.has(id) && isAlive(target, id) && !sAlive.has(getNode(target, id)!.parentId)) plan.push({ k: 'del', id });
  // ② 重建：快照有而 target 无，按快照先序（父先于子）；parent 映射表 Map<snapId, newId|既有id>
  // ③ 移动+内容：交集节点按快照先序——parentId 映射后不同或同层位置不同 → moveNode(id, mappedParent, snapIndex)
  //    （moveNode 的 index 越界自动钳制为 append，见 operations.ts:231；同层前序兄弟已按先序就位）
  // ④ 内容字段逐项对比（getNode 的 NodeSnapshot 全字段）：text/note/href/collapsed 直接比；
  //    icons 比 Partial<Record<IconGroup,string>>（ICON_GROUPS 全组，组值不同 setIcon(value|null)）；
  //    image 键值对比 setImage；style 键集对比 setStyle；meta 的 structureType/themeId diff → setDocMeta（title 排除）
  // 重建节点的字段回填 = addChild 后立即按 ④ 同一套 diff 写（新节点必全量不同）
  // ——diff 为空：直接返回全零，不开事务——
  if (plan.length === 0 && metaDiffEmpty) return { deleted: 0, created: 0, moved: 0, updated: 0 };
  return withTransaction(target, ORIGIN_RESTORE, () => { /* 执行 plan，边执行边计数 */ });
}
```

（重建走 addChild 返回的新 id；`reachableAliveIds`/plan 类型为文件内私有。约束：本函数只依赖 core 既有导出，不新增 yjs 直调。）

- [ ] **Step 3: server 失败测试 → 实现**

versions.e2e-spec 追加恢复组：

```ts
it('恢复：live 文档——REST 恢复后 WS 在线端收到回滚内容（恢复广播）', async () => {
  // provider client 连接（collab spec 模式）→ 版本行直插（早期状态）→
  // POST restore 200 {preRestoreVersionId} → provider 上 doc 内容断言回到早期状态；
  // versions 行含 type='pre_restore' 且 restoredFrom=vid；files.docState 已随防抖落库（或直接断言 storeDocument 后行值）
});
it('恢复：无人在线——走落库路径，GET /api/files/:id 的 docState 与快照一致', async () => { /* docFromState 比对文本 */ });
it('恢复权限：非 owner/editor 404；未登录 401；版本 id 属其他文件 404', async () => { /* canAccess 与 restore 判定分离：一期角色集下用协作者账号可恢复、未授权账号 404 */ });
it('列表/取态：canAccess 可读，含 createdByName；其他文件版本 404', async () => { /* join users 名字非空 */ });
it('events 端点：POST /api/events 登录 204 且落库；未登录 401', async () => {});
```

实现要点：`VersionsService.restoreVersion` 流程 = `findAliveOr404` → 权限（owner 或 collaborator.role==='editor'，不满足 404）→ 版本行（fileId 匹配，否则 404）→ `snapDoc = docFromState(version.state)`（抛 → 400 '版本数据损坏'）→ **先写 pre_restore 行**（state=恢复前状态：live 路径取 `withLiveDocument(fileId, (d) => Buffer.from(docToState(d)))`，离线路径取 `file.docState` 原值；createdBy=restorer；restoredFrom=vid）→ live：`withLiveDocument(fileId, (d) => restoreFromSnapshot(d, snapDoc))`（y-sync 自动广播；onChange/storeDocument 钩子照常走配额与持久化）；返回 null 则离线路径：`docFromState(file.docState)` → restore → `files.update({docState, nodeCount: countAliveReachable(doc)})` → `events.record('version_restore', ...)`。VersionsModule imports FilesModule（复用 findAliveOr404/canAccess）+ CollabModule（核对 CollabService 导出方式——M3a trash 如何拿到 closeDocumentConnections 的模块接线照抄）。

- [ ] **Step 4: 全量通过 + 提交**

Run: `pnpm --filter @gmind/gmind-core test && pnpm --filter @gmind/server test:e2e`

```bash
git add -A && git commit -m "feat: 版本恢复——core 结构 op-diff 单事务 + REST（pre_restore 存档/live 广播/落库双路径）（FR-VER-004）"
```

---

### Task 8: 版本面板 UI（时间轴/预览/恢复）

**Files:**
- Create: `apps/web/src/editor/VersionPanel.tsx`
- Modify: `apps/web/src/pages/EditorPage.tsx`（toolbar「版本历史」按钮 + 装配，模式同 MemberPanel open/onClose）
- Test: `apps/web/e2e/versions.e2e.spec.ts`（新建）

**Interfaces:**
- Consumes: Task 7 三个 GET/POST 端点；engine `renderScene`（只读预览）；core `docFromState`。
- Produces: testid `versions-toggle`（toolbar 按钮）、`version-panel`、`version-item-{id}`、`version-preview`、`version-restore-{id}`。

- [ ] **Step 1: 失败 e2e**

```ts
test('版本面板：时间轴/预览/恢复', async ({ page }) => {
  await openSeedDoc(page, '本周计划');
  // API 造两个版本行（服务端 e2e 已覆盖真实快照链路，此处经 fetch 直插会绕过网关——
  // 改为：改文本 'A→A2' 并等待保存，再 API 触发？不可——用 spec 内 supertest 同款 fetch
  // 直写不可行；方案：调 POST /api/events 无用。**造数方式**：对 doc 经 window.__gmind.getDoc
  // 取 update 后……——最终裁定：web e2e 造数走「两台 provider 时序」太重，直接在 spec 的
  // playwright.request 里调 Task 6 无从插入。
  // 简化：先改文本等待「已保存」，然后通过测试专用的 dev 钩子触发快照？
  // ——否。造数落定：服务端在 test 环境（e2e）暴露 POST /api/files/:id/versions/snapshot（dev-only，
  //   collab.service.snapshotIfDirty 包装，NODE_ENV!=='production' 才注册路由）——e2e 与手动验收共用。
  await apiPost(page, `/files/${fileId}/versions/snapshot`);
  // 改文本 '计划B' → 再造一版 → 打开面板 → 断言两条时间轴 → 点第一条预览（对话框 svg 含 '本周计划'）→
  // 点恢复 → 画布文本回到 '本周计划'（经恢复广播，无需 reload）→ 面板顶部出现「恢复前存档」条目
});
```

（dev-only snapshot 路由进 Task 8 一并实现：controller 层 `if (config.NODE_ENV !== 'production')` 条件路由，调 `collab.snapshotIfDirty(fileId, Date.now())`——此改动归属 Task 8 的 Files 清单：Modify `apps/server/src/collab/collab.controller?` 无——放在 `versions.controller.ts`，服务端测试补一条「非 production 才注册」。）

- [ ] **Step 2: 实现 VersionPanel**

右侧抽屉（复制 MemberPanel 的容器样式模式）：列表项 = 时间（HH:mm 或昨天/日期）+ 类型徽标（auto='自动' / pre_restore='恢复前存档'，restoredFrom 非空时 title 显示「恢复自某版本」）+ 触发人名 + 节点数。点条目 → GET state → `docFromState` → 预览对话框（`data-testid=version-preview`）内挂只读 svg：复用 EditorPage 现有引擎装配参数（theme/structure 取快照 meta），只渲染无交互（不装配手势/编辑器）。恢复按钮（每条目，hover 显示）→ confirm 文案「当前内容将自动存档为「恢复前版本」，确定恢复到 {时间} 的快照吗？」→ POST restore → toast「已恢复」→ 刷新列表（新 pre_restore 条目出现；画布由恢复广播自动更新）。权限：恢复按钮按 Task 7 的 401/404 响应兜底 toast（前端不再单独判角色——一期角色集 owner/editor 全员可恢复）。

- [ ] **Step 3: 通过 + 全量回归 + 提交**

```bash
git add -A && git commit -m "feat(web): 版本面板——时间轴/只读预览/一键恢复（FR-VER-004 UI）"
```

---

### Task 9: PNG/JPG 导出（engine SVG 序列化 + web Canvas 栅格化 + 折叠提示）

**Files:**
- Create: `packages/engine/src/export.ts` + `export.test.ts`
- Create: `apps/web/src/editor/image-export.ts`
- Modify: `packages/gmind-core/src/read.ts`（`countCollapsedWithChildren(doc): number`）+ index 导出
- Modify: `apps/web/src/pages/EditorPage.tsx`（导出菜单补 PNG/JPG 项与选项）
- Test: `packages/engine/src/export.test.ts`、`packages/gmind-core/src/read.test.ts`（追加）、`apps/web/e2e/import-export.e2e.spec.ts`（追加）

**Interfaces:**
- Consumes: engine `renderScene`（核对现签名）；core `docFromState`/`docToState`/`setCollapsed`。
- Produces:

```ts
// packages/engine/src/export.ts
export interface ExportSceneOptions { structure: StructureType; themeId: string; }
/** 离屏渲染并序列化完整 SVG 字符串（含 xmlns 与尺寸），供 web 侧内联图片后栅格化。 */
export function exportSceneSvg(reader: DocReader, opts: ExportSceneOptions): { svg: string; width: number; height: number }
// apps/web/src/editor/image-export.ts
export async function exportImage(doc: Y.Doc, title: string, opts: { format: 'png' | 'jpg'; scale: 1 | 2 | 3; transparent: boolean }): Promise<void>
```

- [ ] **Step 1: core/engine 失败测试**

```ts
// read.test.ts 追加
it('countCollapsedWithChildren：仅统计存活且折叠且有子级的节点', () => { /* 3 折叠 1 无子 → 2 */ });
// engine export.test.ts（沿用 engine 测试环境）
it('exportSceneSvg：序列化含根文本、xmlns、正尺寸；不污染既有场景容器', () => {
  const doc = makeDoc(); const { svg, width, height } = exportSceneSvg(readerOf(doc), { structure: 'mindmap', themeId: 'gmind-light' });
  expect(svg).toContain('xmlns="http://www.w3.org/2000/svg"');
  expect(svg).toContain('根'); expect(width).toBeGreaterThan(0); expect(height).toBeGreaterThan(0);
});
```

- [ ] **Step 2: engine 实现**

`export.ts`：`document.createElement('div')`（ detached）→ renderScene（options 与画布同参但**无视折叠渲染**——核对 renderScene 对 collapsed 的处理：若渲染层按折叠裁剪，则传入「已展开克隆」的 reader；方案落定为后者，见 Step 4）→ `new XMLSerializer().serializeToString(svgEl)` → 确保 `xmlns` 与 `width/height` 属性为布局包围盒。

- [ ] **Step 3: web 失败 e2e → 实现 image-export + 菜单**

```ts
test('导出 PNG 3x：下载产物 IHDR 尺寸 = 1x 布局 ×3；折叠时先提示自动展开', async ({ page }) => {
  await openSeedDoc(page, '本周计划');
  await page.getByTestId('export-menu').click();
  await page.getByTestId('export-png-3x').click();          // 无折叠：直接导出
  const [dl] = await Promise.all([page.waitForEvent('download'), /* 同上 */]);
  const png = await fs.promises.readFile(await dl.path());
  expect(png.subarray(1, 4).toString()).toBe('PNG');
  const w = png.readUInt32BE(16), h = png.readUInt32BE(20);  // IHDR
  expect(w % 3).toBe(0); expect(h % 3).toBe(0);              // 3x 尺寸可被 3 整除（1x 布局×3）
});
test('折叠提示：检测到 N 处折叠 → 确认后导出（画布折叠态不变）', async ({ page }) => { /* 折叠一节点 → 导出 → confirm 文案含 '1 处折叠' → 确认 → 折叠角标仍在 */ });
```

`image-export.ts` 流程（注释写明 SVG-as-image 外部资源禁载，必须内联）：

```ts
export async function exportImage(doc: Y.Doc, title: string, opts): Promise<void> {
  if (countAliveReachable(doc) > MAX_DOC_NODES) throw new Error('文件过大，请拆分后导出');   // FR-IO-005 防御（配额已保证 ≤500）
  const expanded = cloneExpanded(doc);                    // core helper：docToState→docFromState 克隆 + 存活集 setCollapsed(false)（ORIGIN_SYSTEM，仅导出快照不改画布）
  const { svg, width, height } = exportSceneSvg(readerOf(expanded), { structure: getMeta(expanded).structureType, themeId: getMeta(expanded).themeId });
  const inlined = await inlineImages(svg);                // DOM 遍历 image[href^='/api/images/'] → fetch → blob→dataURL 回填（失败保留原 href 并继续）
  const canvas = await rasterize(inlined, width * opts.scale, height * opts.scale, opts.format === 'jpg' || !opts.transparent);
  const blob = await new Promise<Blob>((res) => canvas.toBlob((b) => res(b!), opts.format === 'png' ? 'image/png' : 'image/jpeg', 0.92));
  downloadBlob(blob, `${title}.${opts.format}`);
}
```

（`cloneExpanded` 放 core `restore.ts` 旁新文件 `export-helpers.ts` 或 read.ts——落位 `packages/gmind-core/src/export.ts`：`cloneExpanded(doc): Y.Doc` + `countCollapsedWithChildren`；测试并入 Step 1。）EditorPage 导出菜单补：PNG 1x/2x/3x + 「透明背景」勾选（默认勾选，仅 PNG 显示）、JPG 1x/2x/3x（白底）。点击前 `countCollapsedWithChildren(doc) > 0` → `confirm('检测到 N 处折叠，将自动展开后导出')`，取消即中止。导出成功后调 `POST /api/events {type:'export_done', fileId, payload:{format, scale}}`（Task 7 端点）。

- [ ] **Step 4: 通过 + 全量回归 + 提交**

Run: `pnpm --filter @gmind/engine test && pnpm --filter @gmind/gmind-core test && WEB_PORT=5174 API_ORIGIN=http://localhost:3001 pnpm --filter @gmind/web e2e`

```bash
git add -A && git commit -m "feat: PNG/JPG 导出——engine SVG 序列化 + Canvas 栅格化（1x/2x/3x、透明底、折叠自动展开提示）（FR-IO-003/005）"
```

---

### Task 10: 清偿小包——摘要跳转链接 + 加入通知 + 通知深链 + isDuplicateKeyError 收敛

**Files:**
- Modify: `apps/server/src/jobs/digest.service.ts:85-95`（条目链接）、`apps/server/src/config/env.ts`（`WEB_ORIGIN` 可选，默认 `http://localhost:5174`，照 SMTP_HOST 的可选模式）
- Modify: `apps/server/src/share/share.service.ts`（joinByToken 成功 → owner 通知）、`apps/server/src/share/invite.service.ts`（acceptPendingForNewUser 成功 → owner 通知）
- Modify: `apps/server/src/files/files.service.ts`（star 的 isDuplicateKeyError 提为共享 util；grep 其他 dup-key 捕获点统一）
- Create: `apps/server/src/utils/duplicate-key.ts`
- Modify: `apps/web/src/pages/EditorPage.tsx`（装载后读 `?node=` 定位）、`apps/server/src/notify` 相关 payload（跳转 URL 带 node）
- Test: `apps/server/test/notify.e2e-spec.ts`（追加 2 例）、`apps/server/test/share.e2e-spec.ts`（追加 1 例）、`apps/web/e2e/notify.e2e.spec.ts`（追加深链）

**Interfaces:**
- Produces: digest 邮件每条目附 `${WEB_ORIGIN}/edit/${fileId}`，正文尾部「打开 Gmind」行；join/invite 回填 → owner 收 `type='permission'` 通知（payload `{fileId, title, memberName, action:'joined'}`，TYPE_LABELS.permission 已预留「权限」标签——核对文案键）；通知 payload 带 `nodeId` 时深链 URL 为 `/edit/:fileId?node=:nodeId`；EditorPage 装载完成且 `?node=` 有效时 `locateNode(nodeId)`。

- [ ] **Step 1: 失败测试**

```ts
// notify.e2e-spec.ts
it('清偿：摘要邮件条目含跳转链接与「打开 Gmind」行', async () => { /* 既有 :369 编排 + 断言 body 含 `/edit/${fileId}` 与 '打开 Gmind' */ });
it('清偿：join 后 owner 收 permission 通知（SSE + unread）', async () => { /* B joinByToken → owner unread-count+1、type permission、payload.memberName=B 昵称 */ });
// share.e2e-spec.ts：邀请回填成功 → owner 同样收 permission 通知（复用上一例断言）
// web notify spec：URL /edit/:fileId?node=X 打开后对应节点 .gm-selected（选中即定位语义，同评论面板定位）
```

- [ ] **Step 2: 实现**

digest：条目行改 `- [label] who：content — ${WEB_ORIGIN}/edit/${fileId}`（fileId 从 payload.fileId 取，缺失则不加链接）+ 尾部 `\n\n打开 Gmind：${WEB_ORIGIN}`。join 通知：joinByToken/回填成功处调 `notify.notify(ownerUserId, {type:'permission', payload:{fileId, title, memberName, action:'joined'}})`（核对 NotifyService.notify 签名与 payload 序列化模式，照 mention/reply 的写法；owner 自 join no-op 已有语义不重复通知）。深链：EditorPage 装载完成的既有 useEffect 里读 `new URLSearchParams(location.search).get('node')` → 有效则 `locateNode` 并 `history.replaceState` 清参（防刷新重复定位）。isDuplicateKeyError：提取 `apps/server/src/utils/duplicate-key.ts`（现 files.service 内实现原样搬移），files.service star() 与 invite accept 等调用点替换（grep `ER_DUP_ENTRY` 找全）。

- [ ] **Step 3: 通过 + 全量回归 + 提交**

```bash
git add -A && git commit -m "feat: 清偿小包——摘要跳转链接、加入通知、通知深链 ?node=、isDuplicateKeyError 收敛"
```

---

### Task 11: M4 验收文档

**Files:**
- Create: `docs/m4-acceptance.md`（照 m3b-acceptance.md 结构：核验日期/环境/标记约定/里程碑边界、准入 §7.10/7.11 收口证明表、FR-IO-001/002/003/004(XMind)/005 与 FR-VER-001/004 逐条表（e2e 用例行号 + 实现行号 + 手动项 + 诚实结果）、清偿小包表、支撑输出（当日 lint/typecheck/test/e2e 真实数字）、结论与待手动清单）
- Modify: `docs/m2-entry-checklist.md`（§7.10/7.11 已收口标注若 Task 1 已做则复核）

**Interfaces:** 无代码；引用各任务真实用例名与行号（当日 grep 核实，非转抄）。

- [ ] **Step 1: 当日全量实测**

Run: `pnpm lint && pnpm typecheck && pnpm test && pnpm --filter @gmind/server test:e2e && WEB_PORT=5174 API_ORIGIN=http://localhost:3001 pnpm --filter @gmind/web e2e`
将真实数字（含 skipped 与环境受限项）写入支撑输出节。

- [ ] **Step 2: 逐条列示**

必须覆盖的诚实登记点（逐条对照 PRD 验收标准原文）：
- FR-IO-001：20MB 超限拒绝 / 合法导入层级一致（server+web e2e）；「25MB」验收字面用 21MB buffer 等价边界——注明。
- FR-IO-002：降级项 toast（数量+类型）；XMind 样式类降级计数单测。
- FR-IO-003：PNG 3x IHDR 断言 + 折叠提示；JPG mime/成功 + 白底与透明底视觉待手动；透明背景开关存在。
- FR-IO-004：XMind 导出层级完整（往返 e2e）；「自动展开折叠」说明为数据层天然满足（注释引用）。
- FR-IO-005：>500 拒绝（防御分支，配额保证常态不触发——注明）。
- FR-VER-001：3 分钟节流+脏标记+卸载兜底（注入时钟 e2e）；「连续编辑 10 分钟≥3 快照」以注入时钟三连落行等价——真实墙钟时长待手动。
- FR-VER-004：恢复一致性/重建/广播/pre_restore 记录（server+web e2e）；恢复×评论「原节点已删除」产品裁定登记。
- 手动核验清单：导出图片视觉（透明底/白底/倍率清晰度）、双机恢复广播体验、邮件送达（MailHog 待环境）、版本面板视觉。

- [ ] **Step 3: 提交**

```bash
git add -A && git commit -m "docs: M4 验收清单与实测结果"
```

---

## Self-Review

1. **Spec 覆盖**：spec 里程碑表 M4 行五项（XMind 导入/导出、PNG/JPG 导出、3 分钟快照+90 天保留、版本面板时间轴/预览/恢复、恢复广播）→ T3/T4/T5/T6/T7/T8/T9；准入 §7.10/7.11 → T1；邀请对话框缺口 → T2；M3b 缺口顺手项 → T10；验收 → T11。FR-VER-002/003 与二期格式明确排除（Global Constraints）。
2. **占位扫描**：无 TBD/TODO；两处「核对现有签名」为防漂移指令而非占位（给出核对对象与兜底方案）——T8 的 e2e 造数方案在步骤内给了最终裁定（dev-only snapshot 路由）。
3. **类型一致性**：`parseXmind`/`buildXmind`/`XmindNode`/`DegradedItem`（T3 定义 → T4/T5 消费）；`VersionEntity`/`withLiveDocument`/`snapshotIfDue`/`snapshotIfDirty`（T6 定义 → T7/T8 消费）；`restoreFromSnapshot`/`ORIGIN_RESTORE`（T7 定义 → T8 间接消费）；`exportSceneSvg`/`exportImage`/`cloneExpanded`/`countCollapsedWithChildren`（T9 内自洽）；testid 命名（`export-menu`/`export-xmind`/`export-png-3x`/`import-button`/`import-input`/`invite-*`/`versions-*`/`version-*`）跨任务一致。
