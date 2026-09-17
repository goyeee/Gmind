# Gmind M1a（gmind-core 完整操作内核）实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把 `@gmind/core` 从「模板文档构建」扩展为完整的文档操作内核：树读取/增删改移、repair 收敛、富内容与样式字段、撤销栈（仅本人、100 步）、剪贴板数据层——M1b 的渲染引擎与编辑器页面只调用这些 API，绝不直接操作 Y.Map。

**Architecture:** 扁平节点表 + `parentId`(LWW) + `children`(Y.Array) 的树模型（spec §4.1）；所有写操作在一个 `doc.transact` 内完成并打 origin（user 可撤销 / system 不可撤销）；每次写事务后由 `normalizeTree` 以 parentId 为唯一真值收敛 children 数组——这是全项目唯一自研共识点（spec §4.2）。剪贴板提供「子树 ⇄ 缩进大纲文本」双向数据层（FR-EDT-009/010 的内核部分，浏览器剪贴板事件在 M1b）。

**Tech Stack:** TypeScript(strict) / Yjs ^13.6 / ulid / Vitest。无 DOM 依赖（浏览器与服务端共用）。

**Spec:** `docs/superpowers/specs/2026-09-18-gmind-phase1-design.md` §4（数据模型/冲突策略/撤销）；PRD FR-EDT-001~010、FR-EDT-011/012/014/015、FR-EDT-021/030。

**M0 遗留入门槛（本计划 Task 1 落实）：** `@gmind/core` 声明 `"@gmind/shared": "workspace:*"` 并移除 tsconfig paths 临时解析（终审 triage）。

## Global Constraints

- 字段名与 spec §4.1 逐字一致：meta `title`/`structureType`/`themeId`；node `text`/`parentId`/`children`/`note`/`href`/`image`/`icons`/`style`/`collapsed`/`deleted`。
- 中心主题 `root`：不可删除（删除降级为清空全部子节点，FR-EDT-002）、不可添加父级（FR-EDT-001）、不可移动；其 `parentId` 恒为 `''`。
- 撤销语义（FR-EDT-004）：仅 user origin 进撤销栈；栈深 100；撤销后新编辑清空重做栈；折叠（collapsed）与 repair、远端应用不可撤销。
- 文本 ≤500 字、备注 ≤5000 字（超限抛错，UI 负责截断与提示，FR-EDT-005/018）；`href` 仅允许空串或 http/https；图标四组 `priority/progress/flag/star`，组内替换跨组叠加（FR-EDT-021）。
- 结构切换只改 `meta.structureType`，不动节点数据（FR-EDT-012 无损）；样式作用域支持 `subtree | single`（FR-EDT-015）。
- 所有写操作后必须调用 `normalizeTree`（system origin）；repair 规则必须只是文档状态的纯函数（多端确定性收敛，spec §4.2）。
- 每任务 TDD：先写失败测试并运行取证，再实现转绿；`pnpm --filter @gmind/core test && pnpm --filter @gmind/core typecheck && pnpm lint` 全绿后 commit（Conventional Commits，中文）。
- 本计划范围内禁止：任何 DOM/浏览器 API、任何对 yjs 之外新运行时依赖、超出接口清单的额外 API（YAGNI）。

---

### Task 1: 包地基——shared 依赖声明与模块骨架

**Files:**
- Modify: `packages/gmind-core/package.json`, `packages/gmind-core/tsconfig.json`
- Create: `packages/gmind-core/src/constants.ts`, `packages/gmind-core/src/errors.ts`（先建骨架，Task 2+ 填实现）

**Interfaces:**
- Produces: `constants.ts` 导出 `MAX_TEXT_LENGTH = 500`、`MAX_NOTE_LENGTH = 5000`、`ICON_GROUPS = ['priority','progress','flag','star'] as const`、`IconGroup` 类型；`errors.ts` 导出 `GmindCoreError extends Error`（`code` 字段，code 联合类型 `'NODE_NOT_FOUND'|'NODE_DELETED'|'ROOT_FORBIDDEN'|'CYCLE_FORBIDDEN'|'TEXT_TOO_LONG'|'NOTE_TOO_LONG'|'INVALID_HREF'|'INVALID_ICON_GROUP'`，中文 message）。

- [ ] **Step 1: 声明依赖、去掉 paths hack**

`packages/gmind-core/package.json` dependencies 增加 `"@gmind/shared": "workspace:*"`；`packages/gmind-core/tsconfig.json` 删除 `baseUrl`/`paths`（tsc 经 workspace 符号链接 + package.json main 解析 TS 源码）。运行 `pnpm install` 后 `pnpm --filter @gmind/core typecheck && pnpm --filter @gmind/core test` 必须仍然全绿（现有 3 个测试与模板构建不受影响）；若 tsc 解析失败，恢复 paths 并 BLOCKED 上报（不要引入 build 步骤）。

- [ ] **Step 2: 写 constants.ts 与 errors.ts**

```ts
// constants.ts
export const MAX_TEXT_LENGTH = 500;
export const MAX_NOTE_LENGTH = 5000;
export const ICON_GROUPS = ['priority', 'progress', 'flag', 'star'] as const;
export type IconGroup = (typeof ICON_GROUPS)[number];
```

```ts
// errors.ts
export type GmindCoreErrorCode =
  | 'NODE_NOT_FOUND' | 'NODE_DELETED' | 'ROOT_FORBIDDEN' | 'CYCLE_FORBIDDEN'
  | 'TEXT_TOO_LONG' | 'NOTE_TOO_LONG' | 'INVALID_HREF' | 'INVALID_ICON_GROUP';

export class GmindCoreError extends Error {
  constructor(readonly code: GmindCoreErrorCode, message: string) {
    super(message);
    this.name = 'GmindCoreError';
  }
}
```

- [ ] **Step 3: 验证** `pnpm install && pnpm --filter @gmind/core test && pnpm --filter @gmind/core typecheck && pnpm lint` 全绿。

- [ ] **Step 4: Commit** `git add packages/gmind-core pnpm-lock.yaml && git commit -m "chore(core): 声明 shared 依赖、错误与常量骨架（终审入门槛）"`

---

### Task 2: 树读取 API（read.ts）

**Files:**
- Create: `packages/gmind-core/src/read.ts`, `packages/gmind-core/src/read.test.ts`
- Modify: `packages/gmind-core/src/index.ts`（追加 `export * from './constants'; export * from './errors'; export * from './read';`）

**Interfaces:**
- Produces（全部为纯函数，不改文档）:
  - `getMeta(doc): { title: string; structureType: StructureType; themeId: string }`
  - `setDocMeta(doc, patch: Partial<{title; structureType; themeId}>, origin?: string): void`（写入 meta，user origin 默认——结构切换/改名可撤销，FR-EDT-012）
  - `getNode(doc, id): NodeSnapshot | null`；`NodeSnapshot = { id; text; parentId; childIds: string[]; note: string; href: string; image: {key,w,h}|null; icons: Partial<Record<IconGroup,string>>; style: Record<string,string>; collapsed: boolean; deleted: boolean }`
  - `childrenIds(doc, id): string[]`、`isAlive(doc, id): boolean`、`subtreeIds(doc, id, includeDeleted=false): string[]`（先序）、`pathToRoot(doc, id): string[]`、`countAlive(doc): number`（不含 root）、`requireAliveNode(doc, id): Y.Map<unknown>`（内部用，缺失抛 NODE_NOT_FOUND、已删抛 NODE_DELETED）

- [ ] **Step 1: 失败测试** `read.test.ts`：用 `createTemplateDoc` 构 2 层树断言 `getMeta`/`getNode` 快照字段全正确（childIds 顺序、默认 note=''/href=''/image=null/icons={}/style={}/collapsed=false/deleted=false）；`subtreeIds` 先序；`pathToRoot(叶子)=[叶子id,'root']`；`countAlive`；对不存在 id 返回 null / requireAlive 抛 NODE_NOT_FOUND；对墓碑 isAlive=false。
- [ ] **Step 2:** 运行 `pnpm --filter @gmind/core test` 确认失败（模块不存在）。
- [ ] **Step 3: 实现 read.ts**（Y.Map/Y.Array 读取 + 默认值兜底；icons/style 从 Y.Map 转 record）。
- [ ] **Step 4:** 测试转绿 + typecheck + lint。
- [ ] **Step 5: Commit** `git add packages/gmind-core && git commit -m "feat(core): 树读取 API 与节点快照（spec §4.1）"`

---

### Task 3: 写操作底座与「增」（operations.ts）

**Files:**
- Create: `packages/gmind-core/src/operations.ts`, `packages/gmind-core/src/operations.test.ts`
- Modify: `packages/gmind-core/src/index.ts`（追加导出）

**Interfaces:**
- Produces:
  - `type WriteOrigin = string`；`import { ORIGIN_USER, ORIGIN_SYSTEM } from './undo'` 先占位（Task 6 落地前先在本文件导出常量，Task 6 迁移至 undo.ts 并 re-export 保持兼容）——**裁决：本任务先在 operations.ts 定义并导出 `ORIGIN_USER='user'`、`ORIGIN_SYSTEM='system'`，Task 6 移到 undo.ts、operations.ts re-export**
  - `withTransaction<T>(doc, origin, fn: () => T, opts?: { normalize?: boolean }): T`——统一写入口：`doc.transact(fn, origin)` + 事务后 `normalizeTree`（normalize 默认 true；normalize 自身不抛错）
  - `addChild(doc, parentId, opts?: { index?: number; text?: string }, origin?): string`——校验：parent 存在且存活（否则 NODE_NOT_FOUND/NODE_DELETED；root 合法）；index 越界按 clamp 处理；返回新 ULID；新节点字段按 §4.1 默认值（text 默认 `''`）
  - `setText(doc, id, text, origin?)`——存活校验；长度 >500 抛 `TEXT_TOO_LONG('节点文本长度已达上限')`
- 依赖：Task 2 的 `requireAliveNode`；repair 的 `normalizeTree` 本任务先建桩（`packages/gmind-core/src/repair.ts` 导出空实现 `normalizeTree(doc): number { return 0 }`，Task 5 填充）——**裁决：空桩使 TDD 分层推进，Task 5 的测试会锁死真实行为**

- [ ] **Step 1: 失败测试** `operations.test.ts`：addChild 返回 ULID 且 getNode 可读、默认字段齐；指定 index 插入位置正确（childrenIds 顺序）；index 越界 clamp 到末尾；对 root addChild 合法；对不存在/已删 parent 抛对应错误；setText 正常写入；setText 501 字抛 TEXT_TOO_LONG 且文档未被修改（事务回滚语义：抛错发生在 transact 内，Yjs 事务抛错则无变更——测试断言 text 不变）。
- [ ] **Step 2:** 跑测试确认失败。
- [ ] **Step 3: 实现** withTransaction + addChild + setText（+repair.ts 空桩）。
- [ ] **Step 4:** 转绿 + typecheck + lint。
- [ ] **Step 5: Commit** `git add packages/gmind-core && git commit -m "feat(core): 统一写事务底座与 addChild/setText"`

---

### Task 4: 删除与移动（operations.ts 续）

**Files:**
- Modify: `packages/gmind-core/src/operations.ts`, `packages/gmind-core/src/operations.test.ts`

**Interfaces:**
- Produces:
  - `deleteNodes(doc, ids: string[], origin?): void`——单事务内：对每个 id（忽略不存在的）：若 id==='root' 则降级「清空 root 全部子节点」（递归墓碑所有后代，FR-EDT-002），否则墓碑该节点及其全部后代（`deleted=true`），并从其 parent 的 children 中移除该 id；后代节点的 children 数组保留不动（快照可还原）。全清空/全删后 normalize。
  - `moveNode(doc, id, newParentId, index?, origin?): void`——校验：id 非 root（ROOT_FORBIDDEN）、存活；newParent 存活且非 id 自身与后代（CYCLE_FORBIDDEN，用 `subtreeIds` 判）；然后同事务：从旧 parent children 移除、写 parentId、插入新 parent children 指定位置（clamp）。

- [ ] **Step 1: 失败测试**：删叶子 → deleted=true 且从父 children 消失、其余树不动；删中间节点 → 整个子树全部墓碑；deleteNodes(['root']) → root 存活、原全部子孙墓碑；deleteNodes 混入不存在 id 静默忽略；移动到新父 → parentId 更新、两侧 children 正确；同父内移动重排；move 到自己后代抛 CYCLE_FORBIDDEN 且树无变化；move(root) 抛 ROOT_FORBIDDEN；move 到已删节点抛 NODE_DELETED。
- [ ] **Step 2:** 确认失败。**Step 3: 实现。** **Step 4:** 转绿 + gates。
- [ ] **Step 5: Commit** `git add packages/gmind-core && git commit -m "feat(core): 墓碑级联删除与换父移动（FR-EDT-002/003）"`

---

### Task 5: repair 收敛（repair.ts 正式实现 + 交错一致性测试）

**Files:**
- Modify: `packages/gmind-core/src/repair.ts`（替换空桩）, 新增 `packages/gmind-core/src/repair.test.ts`

**Interfaces:**
- Produces: `normalizeTree(doc, origin = ORIGIN_SYSTEM): number`——规则（纯文档状态函数，spec §4.2）：① children 数组去重；② 移除指向不存在节点或墓碑节点的项；③ 移除「parentId !== 本节点 id」的项（并发换父的败者侧清理）；④ 存活非 root 节点若不在 parentId 的 children 中 → 追加到末尾；⑤ root 缺失则重建（防御）。返回修复次数。**实现必须只在 system origin 的事务里写**；无修复时不开启事务。

- [ ] **Step 1: 失败测试** `repair.test.ts`：
  - 破坏场景构造（用 withTransaction 直接改 Y.Map 模拟并发残留）：同一 id 出现在两个 children → normalize 后仅剩 parentId 所指那个，返回值 >0；
  - children 含不存在 id / 墓碑 id → 被清除；
  - 存活节点不在父 children → 追加到末尾；
  - 干净文档 normalize 返回 0 且树无任何变化（快照对比）；
  - **交错一致性（FR-COL-003 单机预演）**：docA=createTemplateDoc；docB=docFromState(docToState(docA))。脚本 A：moveNode(X→P1)；脚本 B：deleteNodes([Y])（X 不相关）。A 的 update 应用到 B、B 的应用到 A，双方 normalize 后 `getNode` 全量快照逐节点 deep-equal；再构造「A/B 并发把同一节点 X 换父到 P1/P2」：各自本地 op → 交换 update → 双方 normalize → 断言 X 的 parentId 在两文档一致且 children 数组一致（LWW 定胜者，repair 清败者）。
- [ ] **Step 2:** 确认失败。**Step 3: 实现。** **Step 4:** 转绿 + gates。
- [ ] **Step 5: Commit** `git add packages/gmind-core && git commit -m "feat(core): repair 收敛规则与交错一致性测试（spec §4.2）"`

---

### Task 6: 撤销栈（undo.ts）

**Files:**
- Create: `packages/gmind-core/src/undo.ts`, `packages/gmind-core/src/undo.test.ts`
- Modify: `packages/gmind-core/src/operations.ts`（ORIGIN_* 迁至 undo.ts 并 re-export）、`index.ts`

**Interfaces:**
- Produces:
  - `ORIGIN_USER`/`ORIGIN_SYSTEM` 常量定义在 undo.ts（operations.ts `export { ORIGIN_USER, ORIGIN_SYSTEM } from './undo'` 保持既有导入路径可用）
  - `createUndoManager(doc): Y.UndoManager`——`trackedOrigins: new Set([ORIGIN_USER])`、`captureTimeout: 500`
  - `capUndoStack(um, max = 100): void`——`while (um.undoStack.length > max) um.undoStack.shift()`（FR-EDT-004 栈深 100）
  - `undo(um)/redo(um): boolean`——包装 Yjs 调用并返回是否生效
- 折叠等 system origin 的写（Task 7 的 setCollapsed）天然不进栈。

- [ ] **Step 1: 失败测试** `undo.test.ts`：addChild(默认 origin) 后 undo 可撤销（节点消失）、redo 恢复；ORIGIN_SYSTEM 写（setDocMeta 用 system 调用一次）不进栈（undo 返回 false 且该变更仍在）；连续 105 次 addChild 后 capUndoStack，undoStack.length===100，逐步 undo 恰好 100 次后栈空；撤销后再新编辑 → redoStack 被清空（FR-EDT-004）；captureTimeout 内连续两次 addChild 合并为一条撤销单元（Yjs 默认行为，断言 undoStack.length===1）。
- [ ] **Step 2:** 确认失败。**Step 3: 实现。** **Step 4:** 转绿 + gates（全量单测含前面任务的都得绿）。
- [ ] **Step 5: Commit** `git add packages/gmind-core && git commit -m "feat(core): 撤销栈——仅本人操作、深度 100（FR-EDT-004）"`

---

### Task 7: 富内容与样式字段（operations.ts 续）

**Files:**
- Modify: `packages/gmind-core/src/operations.ts`, `packages/gmind-core/src/operations.test.ts`

**Interfaces:**
- Produces（全部存活校验 + withTransaction 包裹）:
  - `setNote(doc, id, note, origin?)`——>5000 抛 NOTE_TOO_LONG('备注长度已达上限')
  - `setHref(doc, id, href, origin?)`——空串或 `/^https?:\/\//i`，否则 INVALID_HREF('链接仅支持 http/https')
  - `setImage(doc, id, image: { key: string; w: number; h: number } | null, origin?)`
  - `setIcon(doc, id, group: IconGroup, value: string | null, origin?)`——group 非法抛 INVALID_ICON_GROUP('未知的图标分组')；value null 删除该组；组内替换即覆盖（FR-EDT-021）
  - `setCollapsed(doc, id, collapsed: boolean, origin = ORIGIN_SYSTEM)`——同步但不可撤销（spec §4.2 第 5 条裁决）
  - `setStyle(doc, id, patch: Record<string, string | number | null>, origin?)`——null 删除键
  - `applyStyle(doc, rootIds: string[], patch, scope: 'subtree' | 'single', origin?)`——single 只写自身；subtree 对每个 root 的 `subtreeIds` 全部写入；**一个事务内完成**（FR-EDT-015 多选 3 节点同时生效、撤销一次全回）
  - `toggleCollapse(doc, id, origin = ORIGIN_SYSTEM)`

- [ ] **Step 1: 失败测试**：note 5001 抛错/5000 通过；href 三态（合法 http/https、空串、`javascript:alert(1)` 抛 INVALID_HREF）；setImage 写入与清 null；setIcon 同组替换（flag 红→蓝仅剩蓝）跨组叠加（flag+priority+progress 并存）；非法组名抛错；setCollapsed 后 undo 不回退折叠；setStyle null 删键；applyStyle subtree 对 3 层子树全部生效且单次 undo 全回滚；single 仅自身。
- [ ] **Step 2:** 确认失败。**Step 3: 实现。** **Step 4:** 转绿 + gates。
- [ ] **Step 5: Commit** `git add packages/gmind-core && git commit -m "feat(core): 富内容/图标/折叠/样式字段与子树样式作用域（FR-EDT-015/018~021/030）"`

---

### Task 8: 剪贴板数据层（clipboard.ts）

**Files:**
- Create: `packages/gmind-core/src/clipboard.ts`, `packages/gmind-core/src/clipboard.test.ts`
- Modify: `packages/gmind-core/src/index.ts`

**Interfaces:**
- Produces:
  - `subtreeToOutlineText(doc, id): string`——Tab 按层级缩进的纯文本大纲；存活校验；节点 text 内的换行折叠为单个空格（文档化限制，避免多行文本破坏层级语义）；墓碑节点不可导出（抛 NODE_DELETED）
  - `outlineToSpec(text): { text: string; children: [] }[]`——解析 Tab 或偶数空格缩进（空格数 ÷2 取整为层级）；跳过空行/纯空白行；返回森林 spec
  - `insertSpec(doc, parentId, index, spec, origin?): string[]`——按 addChild 逐层插入，返回新建节点 id（先序）；parentId 校验同 addChild
- M1b 的浏览器剪贴板事件层组合这三个函数 + 系统剪贴板（内部结构化格式用 JSON 序列化的 spec + 资源清单，本任务不涉及）。

- [ ] **Step 1: 失败测试**：三层子树导出 → 每行缩进数 = 深度个 Tab；含换行 text 导出折为空格；outlineToSpec 解析 Tab 缩进、2/4 空格缩进、跳过空行；「导出→解析→insertSpec 到另一文档」往返后两树 getNode 快照一致（id 不同、结构文本一致）；insertSpec 返回 id 数量与 spec 节点数一致；粘贴目标为墓碑抛 NODE_DELETED。
- [ ] **Step 2:** 确认失败。**Step 3: 实现。** **Step 4:** 转绿 + gates。
- [ ] **Step 5: Commit** `git add packages/gmind-core && git commit -m "feat(core): 子树⇄缩进大纲剪贴板数据层（FR-EDT-009/010 内核）"`

---

### Task 9: 性能冒烟与 500 节点基准

**Files:**
- Create: `packages/gmind-core/src/bench.test.ts`

**Interfaces:**
- Produces: 内部基准（无新公共 API）。用 `outlineToSpec` 生成 500 节点 spec → `insertSpec` 建树；断言：①建树 <1s；②1 万次混合操作（addChild/setText/moveNode/deleteNodes/normalizeTree）<3s（宽松冒烟阈值，锁死「操作复杂度无意外超线性」；正式 40fps 渲染压测在 M1b 引擎层）。测试标注 `describe.skipIf(process.env.CI)` 防慢机器误报？**裁决：不 skip**——阈值足够宽松（本机实测预计 <1s），CI 慢机器仍留 3 倍余量。

- [ ] **Step 1: 写测试（含实现后的自然通过预期，先跑一次确认在未优化实现上即达标——若不达标属性能缺陷，BLOCKED 上报而非调阈值）**
- [ ] **Step 2:** 全量 gates + `pnpm --filter @gmind/core test` 计时输出留档。
- [ ] **Step 3: Commit** `git add packages/gmind-core && git commit -m "test(core): 500 节点操作内核性能冒烟基准"`

---

### Task 10: 收尾——导出面整理与 M1a 验收

**Files:**
- Modify: `packages/gmind-core/src/index.ts`, `packages/gmind-core/README.md`（新建，接口清单）

- [ ] **Step 1:** index.ts 统一导出顺序：constants/errors → read → operations → repair → undo → clipboard → doc/templates；`pnpm --filter @gmind/shared typecheck` 无循环依赖告警（如有 `import type` 循环，改为仅类型导入并记录）。
- [ ] **Step 2:** README.md 列出全部公共 API 一行签名（M1b 的契约面）。
- [ ] **Step 3:** 全仓回归 `pnpm lint && pnpm typecheck && pnpm test && pnpm --filter @gmind/server test:e2e`（15/16 用例不得回归——实际 16/16）。
- [ ] **Step 4: Commit** `git add packages/gmind-core && git commit -m "docs(core): M1a 公共 API 清单与导出面整理"`

## 里程碑边界（本计划不做）

渲染/布局/SVG（M1b）、浏览器剪贴板与键盘事件层（M1b）、编辑器页面与自动保存（M1b）、主题视觉资源（M1b）、真实双端 WS 协同与正式混沌压测（M2）、Awareness 光标（M2）。
