# 轮 2 筛选双层化 实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task.

**Goal:** 删掉老的「生效范围 对所有人/对本人」切换（`Filter.scope` 概念退役），改为原型 11-14 的双层模型：改动默认**仅你可见**（筛选按钮标「· 仅你可见」），可点「对所有人生效」写入文件成为团队公共筛选；他人发布公共筛选时，**未在做个人调整的人自动跟随 + toast「xx 更改了筛选条件」**，**正在做个人调整的人筛选不动、只弹 toast**。

**Architecture:** 公共筛选 = gmind-core 文档级新字段 `meta.sharedFilter`（专属 op `setSharedFilter`，setTableView 先例 operations.ts:942-950），随 Yjs 协同自动同步；**不随版本回滚**（随 restore.ts meta.title 排除先例「视图偏好不随版本回滚」）。个人筛选 = EditorPage 会话内 React state（关标签页即回公共）。订阅文档 meta 变化 → 按「是否有个人筛选」二分：无→跟随 + toast；有→仅 toast，「· 仅你可见」标记保留，可手动「恢复为公共筛选」。

**Tech Stack:** 现有栈零新依赖；core Y.Map meta 写、web React state、现有 toast 组件复用。

**Spec:** 需求方 2026-11-15 三轮 AskUserQuestion 拍定：①公共筛选**不含 keyword**（原型口径，keyword 仅本次会话）；②localStorage 旧视图 `scope:'me'` **自动迁移**为「负责人=我」；③提示**复用 toast**，话术「xx 更改了筛选条件」；④**冲突保护**=正在做个人调整的人不被覆盖（推荐项）。原型交互细节（`Gmind脑图表格产品/src/components/FilterBar.tsx:82-101`）：筛选按钮后缀「· 仅你可见」；弹窗头「✓已同步给所有人」徽章 vs「调整仅你可见 / 对所有人生效 / ⋯恢复为公共筛选」。

## Global Constraints

- 不 commit；不派子代理（实现者）；engine/core 只增不改。
- 公共筛选 schema 不含 `keyword` 键（会话级，永不入文档）。
- `meta.sharedFilter` 读取防御：crafted doc_state 可注入任意形状，非法形状→`undefined`（视为无公共筛选）。
- 公共筛选的 `owners`/`statuses` 用 JSON 数组存（不用 Set），读侧转回 Set。
- 「已同步给所有人」判定 = 当前生效筛选与公共筛选**逐字段相等**（keyword 不参与比较）。
- 「无个人调整」判定 = 当前筛选与**事件前**的公共筛选逐字段相等；keyword 不参与。
- toast 中「xx」= 发布者昵称，从协同 awareness 取；拿不到回退「有成员」。
- 门禁五件套收官（T4）。

## Review Focus

1. **crafted doc_state 注入非法 sharedFilter**（字符串/数组/null/带 keyword 键）→ 读侧归一为 `undefined`，不抛错不崩溃。**测试**：T1 Step 1 用例⑤。
2. **A 发布时 B 正在编辑个人筛选** → B 的筛选不动，「· 仅你可见」保留，toast 仍弹。**测试**：T4 e2e 双浏览器用例②。
3. **A 发布时 B 只输了 keyword 没动结构化条件** → B 视为「无个人调整」→ 跟随新公共；keyword 保留（keyword 不参与判定）。**测试**：T3 Step 1 用例③。
4. **A 连续发布两次相同筛选** → 第二次同值守 guard 短路，零事务零 toast 噪音。**测试**：T1 Step 1 用例④ + T3 同值守 guard。
5. **空文档首次有人发布公共筛选** → 此前 `sharedFilter` 键不存在，发布后所有人从「无筛选」跳到新公共筛选。**测试**：T4 e2e 用例①覆盖。
6. **恢复为公共筛选但公共为空** → 清空当前筛选（结构化条件清零、keyword 不动）。**测试**：T2 Step 1 用例④。

---

### Task 1: gmind-core 加 sharedFilter 文档级 op

**Files:**
- Modify: `packages/gmind-core/src/types.ts`（`DocMeta.sharedFilter?: SharedFilter`、`SharedFilter` 类型导出）
- Modify: `packages/gmind-core/src/read.ts`（`getMeta` 读 `sharedFilter` + 防御归一）
- Modify: `packages/gmind-core/src/operations.ts`（新增 `setSharedFilter` op，setTableView 同款形状）
- Modify: `packages/gmind-core/src/restore.ts`（diff 范围排除 `sharedFilter`——meta.title 排除先例扩展）
- Modify: `packages/gmind-core/src/repair.ts`（规则⑧扩展：`sharedFilter` 非法形状收敛）
- Test: `packages/gmind-core/src/operations.test.ts`、`read.test.ts`、`restore.test.ts`、`repair.test.ts`

**Interfaces:**
- Produces:
  ```ts
  // types.ts
  export interface SharedFilter {
    owners: string[];            // 负责人 id 集
    statuses: TaskStatus[];      // 状态集
    overdueOnly: boolean;
    unassignedOnly: boolean;
    conds: FilterCond[];         // 字段条件
    grp: string;                 // '' = 不限
    dept: string;                // '' = 不限
    // 注意：无 scope、无 keyword
  }
  // DocMeta 增键
  sharedFilter?: SharedFilter;   // undefined = 从未有人发布

  // operations.ts
  export function setSharedFilter(
    doc: Y.Doc,
    filter: SharedFilter | null,  // null = 清除公共筛选
    origin?: WriteOrigin,
  ): void;

  // read.ts getMeta 返回的 DocMeta 带 sharedFilter（防御归一后）
  ```
- Consumes: 无（首个任务）。

- [ ] **Step 1: 失败测试**
  - operations.test.ts：
    ①`setSharedFilter(doc, {owners:['u1'],statuses:[],overdueOnly:false,unassignedOnly:false,conds:[],grp:'',dept:''})` → `getMeta(doc).sharedFilter` 逐字段相等；
    ②`setSharedFilter(doc, null)` → `sharedFilter === undefined`；
    ③入参带 `keyword` 键 → 抛 `SHARED_FILTER_INVALID`（keyword 不允许入文档）；
    ④同值守 guard：现值与入参 JSON 全同 → 零事务（`doc.on('update')` 计数 == 0）；
    ⑤非对象入参（string/number/array）→ 抛 `SHARED_FILTER_INVALID`。
  - read.test.ts：
    ⑥meta 手工塞 `sharedFilter: 'garbage'` → `getMeta` 返回 `undefined`（不抛错）；
    ⑦meta 塞 `sharedFilter: {owners:'not-array', ...}` → 字段级防御（owners 归 []、statuses 归 []、其余按默认）。
  - restore.test.ts：
    ⑧snapshot 有 `sharedFilter: A`、target 有 `sharedFilter: B` → 恢复后 target 仍为 B（不随版本回滚）。
  - repair.test.ts：
    ⑨meta.sharedFilter 为字符串 → normalizeTree 后归 `undefined`；带 keyword 键 → 剔除该键。
- [ ] **Step 2: 验证失败**：`pnpm --filter @gmind/core test` 相关用例红。
- [ ] **Step 3: 实现**
  - types.ts 增 `SharedFilter`、`DocMeta.sharedFilter`（只增）。
  - read.ts `getMeta` 读 `meta.get('sharedFilter')`，经 `canonicalSharedFilter`（新私有函数）归一：非对象→`undefined`；带 `keyword` 键→剔除该键；`owners`/`statuses` 非数组→`[]`；`conds` 非数组→`[]`；布尔/字符串字段按类型回退默认。
  - operations.ts 新增 `setSharedFilter`：入参非对象且非 null → 抛 `SHARED_FILTER_INVALID`；含 `keyword` 键 → 抛错；同值守 guard（canonical 后 JSON 全同）→ 零事务；`null` → 删键；否则 canonical 后写 `meta.set('sharedFilter', canonical)`，`origin = ORIGIN_SYSTEM`（视图偏好不进撤销栈，setTableView 同款裁定）。
  - restore.ts：在 diff 范围注释中明确 `sharedFilter` 与 `meta.title` 同排除（实际 diff 只走 nodes/canvases/customColumns/tableView，`sharedFilter` 天然不在范围——补一条显式注释钉死语义，防未来扩 diff 时误含）。
  - repair.ts 规则⑧扩展：`meta.sharedFilter` 非对象→删键；带 keyword→剔除该键。
- [ ] **Step 4: 验证**：`pnpm --filter @gmind/core test` 全绿 + tsc。

### Task 2: web 类型与 MapFilterBar 改造（去 scope + 双层 UI）

**Files:**
- Modify: `apps/web/src/editor/TaskTable.tsx`（`Filters` 删 `scope`；`EMPTY_FILTERS` 删 scope；`taskFilter` 内 `scope==='me'` 判定删）
- Modify: `apps/web/src/editor/taskFilter.ts`（删 scope 谓词）
- Modify: `apps/web/src/editor/MapFilterBar.tsx`（删 scope 切换 UI；新增「· 仅你可见」后缀、「对所有人生效」「恢复为公共筛选」「✓已同步给所有人」；「我的待办」预设改 `owners:[meId]`；旧视图 `scope:'me'` 自动迁移）
- Test: `apps/web/src/editor/taskFilter.test.ts`、`MapFilterBar.test.ts`（如不存在则新建）

**Interfaces:**
- Consumes: T1 `SharedFilter` 类型（web 侧 `Filters` 与其一一对应，差异仅在 `owners`/`statuses` 用 Set 而 SharedFilter 用数组）。
- Produces:
  ```ts
  // TaskTable.tsx Filters（去 scope 后）
  interface Filters {
    keyword: string;
    owners: Set<string>;
    statuses: Set<TaskStatus>;
    overdueOnly: boolean;
    unassignedOnly: boolean;
    conds: FilterCond[];
    grp: string;
    dept: string;
  }
  // MapFilterBar 新增 props
  interface MapFilterBarProps {
    // ...既有
    sharedFilter: Filters | null;       // 公共筛选（不含 keyword；null=从未发布）
    onPublish: () => void;              // 点「对所有人生效」
    onRestoreShared: () => void;        // 点「恢复为公共筛选」
  }
  ```

- [ ] **Step 1: 失败测试**
  - taskFilter.test.ts：删 scope 相关用例，新增「owners 含 meId 时命中」等价用例（替代旧 `scope:'me'` 行为）。
  - MapFilterBar.test.ts（新建）：
    ①`filters` 与 `sharedFilter` 逐字段相等 → 弹窗头显示「✓已同步给所有人」；
    ②不等 → 筛选按钮尾巴「· 仅你可见」+ 弹窗头「对所有人生效」可点；
    ③点「对所有人生效」→ `onPublish` 被调；
    ④点「恢复为公共筛选」→ `onRestoreShared` 被调；
    ⑤`sharedFilter === null` 时点「恢复为公共筛选」→ 清空当前筛选（keyword 不动）；
    ⑥「我的待办」预设 → `filters.owners.has(meId) === true`、无 `scope` 键。
  - 旧视图迁移：构造 localStorage 含 `scope:'me'` 的 SavedView → `deserialize` 后 `owners.has(meId)`、`scope` 键不存在。
- [ ] **Step 2: 验证失败**：web test 相关用例红。
- [ ] **Step 3: 实现**
  - TaskTable.tsx `Filters` 删 `scope` 键、`EMPTY_FILTERS` 同步删；`taskFilter` 内 `filters.scope === 'me' && !owners.includes(meId)` 分支删除（owners 谓词已覆盖等价语义）。
  - MapFilterBar.tsx：
    - 删 `.mf-scope` 整段（:266-283）。
    - 筛选按钮：`{personal && <span>· 仅你可见</span>}`，`personal = !isEqualToShared(filters, sharedFilter)`（逐字段比较，keyword 除外）。
    - 弹窗头：`personal ? '调整仅你可见 [对所有人生效] [⋯恢复为公共筛选]' : '✓已同步给所有人'`。
    - 「对所有人生效」按钮在 `!personal` 时置灰。
    - 「恢复为公共筛选」在 `!personal` 时不渲染。
    - 「我的待办」预设：`{...EMPTY_FILTERS, owners: new Set([meId])}`（原 `scope:'me'`）。
    - `serialize`/`deserialize` 删 `scope` 键；`deserialize` 遇旧数据 `v.scope === 'me'` → `owners.add(meId)`（一次性迁移，写回时 `scope` 键不再出现）。
  - testid 新增：`map-filter-personal-badge`（「· 仅你可见」）、`map-filter-publish`（「对所有人生效」）、`map-filter-restore-shared`（「恢复为公共筛选」）、`map-filter-synced-badge`（「✓已同步给所有人」）。
- [ ] **Step 4: 验证**：web test 全绿 + tsc + eslint。

### Task 3: EditorPage 接线（公共筛选读写 + 协同跟随 + toast）

**Files:**
- Modify: `apps/web/src/pages/EditorPage.tsx`（`sharedFilter` state、`onPublish`/`onRestoreShared` 实现、meta 订阅协同跟随、toast 提示）
- Modify: `apps/web/src/editor/collab.ts`（如需从 awareness 取发布者昵称——看现有 buildPresence 是否够用）
- Test: `apps/web/src/pages/EditorPage.filter.test.ts`（新建，测跟随/保护逻辑）

**Interfaces:**
- Consumes: T1 `setSharedFilter`/`DocMeta.sharedFilter`；T2 MapFilterBar 新 props。
- Produces: EditorPage 内 `sharedFilter: Filters | null` state（从 `getMeta(doc).sharedFilter` 派生）、`publishSharedFilter()`/`restoreSharedFilter()` 闭包、meta 变化订阅副作用。

- [ ] **Step 1: 失败测试**（EditorPage.filter.test.ts 新建，mock doc + awareness）
  ①初始 `doc` 有 `sharedFilter: A` → `tableFilters` 初始化为 A；
  ②点「对所有人生效」→ `setSharedFilter` 被调，参数 = 当前 filters（去 keyword）；
  ③B 场景：本地 filters == 旧 sharedFilter（无个人调整），远端 meta.sharedFilter 变为 B → 本地 filters 自动跟随到 B + toast「xx 更改了筛选条件」弹出；
  ④B 场景：本地 filters != 旧 sharedFilter（有个人调整），远端变化 → 本地 filters **不变**，toast 仍弹，「· 仅你可见」保留；
  ⑤本地 filters 与旧 sharedFilter 仅 keyword 不同 → 视为「无个人调整」→ 跟随新公共（keyword 保留）；
  ⑥点「恢复为公共筛选」→ filters 设为新 sharedFilter；
  ⑦toast 中昵称取自 awareness 对应 userId；拿不到时回退「有成员」。
- [ ] **Step 2: 验证失败**：相关用例红。
- [ ] **Step 3: 实现**
  - EditorPage 增 `sharedFilter: Filters | null` state，初值 = `getMeta(doc).sharedFilter ? deserializeShared(getMeta(doc).sharedFilter) : null`。
  - 订阅 `doc.getMap('meta').observe` 或经 collab 通道：meta.sharedFilter 变化时——
    - 取旧 sharedFilter（事件前的本地 state）；
    - 比较 `tableFiltersRef.current` 与旧 sharedFilter（keyword 除外）：
      - 相等 → `setTableFilters(deserializeShared(newShared))` + `setSharedFilter(newShared)` + `showToast('{nickname} 更改了筛选条件')`；
      - 不等 → 仅 `setSharedFilter(newShared)` + toast；filters 不动。
  - `publishSharedFilter`：从 `tableFiltersRef.current` 构造 `SharedFilter`（去 keyword）→ `setSharedFilter(doc, payload)` → 本地 `setSharedFilter(payload)`。
  - `restoreSharedFilter`：`sharedFilter` 为 null → `setTableFilters(EMPTY_FILTERS)`；否则 → `setTableFilters({...deserializeShared(sharedFilter), keyword: tableFiltersRef.current.keyword})`（keyword 不动）。
  - toast 昵称：从 awareness `states` 找触发者（协同变化时最近的 remote update 来源）；简化方案 = 取 `collab.buildPresence()` 里最近活跃的他人昵称；拿不到回退「有成员」。
- [ ] **Step 4: 验证**：web test 全绿 + tsc + eslint。

### Task 4: e2e + 文档 + 门禁收官

**Files:**
- Create: `apps/web/e2e/filter-two-tier.e2e.spec.ts`
- Modify: `docs/features/filter.md`（如不存在则新建，按 AGENTS.md §四五栏目模板）
- Modify: `docs/m4-acceptance.md`（§十六补记）
- Modify: `docs/project-status.md`（§三指针行）
- Modify: `README.md`（进度行）

- [ ] **Step 1: e2e 用例**
  - 用例①（基础双层）：A 浏览器设筛选 → 断言「· 仅你可见」出现 → 点「对所有人生效」→ B 浏览器（新会话）打开同文件 → 断言 B 看到相同筛选生效。
  - 用例②（协同跟随 + 冲突保护）：A、B 双浏览器同时在线；B 未做个人调整 → A 发布公共 → B 自动跟随 + toast 出现；B 有个人调整 → A 发布 → B 筛选不动 + toast 出现 + 「· 仅你可见」保留。
  - 用例③（恢复为公共）：B 有个人调整 → 点「恢复为公共筛选」→ B 回到公共筛选。
  - 用例④（keyword 隔离）：A 发布公共筛选后，B 在搜索框输 keyword → 不影响公共筛选；A 端看不到 B 的 keyword。
  - 用例⑤（旧视图迁移）：localStorage 预置带 `scope:'me'` 的旧视图 → 打开筛选视图 → 点该视图 → 断言 `owners` 含 meId、无 scope 概念。
- [ ] **Step 2: 验证**：`WEB_PORT=5174 API_ORIGIN=http://localhost:3001 pnpm --filter @gmind/web e2e` 新用例全绿。
- [ ] **Step 3: 文档**
  - features/filter.md 新建（五栏目：这是什么/规则含 file:line 当日 grep/特殊情况/待需求方确认/最后核对）。
  - m4-acceptance.md §十六补记（轮 2 交付：需求三轮拍板记录、scope 退役、双层模型、协同跟随 + 冲突保护、旧视图迁移）。
  - project-status.md §三加指针行。
  - README.md 进度行追加「2026-11-15 轮 2 筛选双层化」。
- [ ] **Step 4: 收官门禁五件套全绿**（lint/typecheck/test/server e2e/web e2e @WEB_PORT=5174；数字带回；已知观察项 canvas-tabs:46、collab:566、editor:78）。

## Self-Review

- 需求覆盖：删 scope ✓（T2）；「· 仅你可见」✓（T2）；「对所有人生效」✓（T2+T3）；「恢复为公共筛选」✓（T2+T3）；「✓已同步给所有人」✓（T2）；协同跟随 + toast ✓（T3）；冲突保护 ✓（T3 Step 1 用例④）；keyword 隔离 ✓（T1 抛错 + T3 判定除外）；旧视图迁移 ✓（T2）；不随版本回滚 ✓（T1 restore）。
- 类型一致：`SharedFilter`（T1 产）↔ `Filters`（T2 改）字段一一对应，差异仅在 Set vs Array 与 keyword，序列化边界在 T2/T3 明确 ✓。
- 接缝：T1 op → T3 调用；T2 props → T3 传入；T3 协同逻辑 → T4 e2e 双浏览器背书 ✓。
- Review Focus 全部 6 项均落到具体任务的具体测试用例 ✓。
- 比例：4 任务对应「core 字段 + web UI + web 接线 + e2e/文档」自然分层，无冗余 ✓。
