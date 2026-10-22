# 多画布 · 计划二：engine 参数化 实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把 engine 从「根节点写死 'root'、一场景一套固定 defs id、视口状态不可存取」参数化为「rootId 可传、defs id 场景前缀、视口状态可存取恢复」，行为零变化（金样零 diff），为计划三（web 页签切换）铺路。

**Architecture:** 只增不改——全部新参数带缺省值 `'root'`/无前缀，旧调用方零感知；布局金样三件套（mindmap/logic/org）逐字节不变的验证是本计划的收口门禁。

**Tech Stack:** TypeScript + 现有 engine 包（无新依赖）。

**Spec:** `docs/superpowers/specs/2026-10-21-multi-canvas-ruling.md`（裁定 3/4/7/8 的 engine 侧前提）；计划一（core 层）已合并 main（a1b903a）

**执行环境裁定（需求方 2026-10-22 明确指令）：直接在 main 分支实现，不建 worktree**（SDD 常规隔离要求经需求方明示豁免）；文件混合需分开提交时先问需求方。

## Global Constraints

- **engine 只增不改**（AGENTS.md §三.5）：不得变更既有节点/边行为；布局金样变更仅限新增字段——本计划目标是**金样零 diff**，任何金样变化 = 失败
- **缺省兼容**：所有新参数可选，缺省值 = 现状行为；既有调用方（web/server/测试）零改动全绿
- **门禁**：`pnpm lint && pnpm typecheck && pnpm --filter @gmind/engine test` 每 Task 收尾必跑；engine 基线 420/420
- 生产代码 `'root'` 字面量现状盘点（2026-10-22 grep 实证）：**仅两处**——`layout.ts:211`（`return build('root', 0)`）与 `selection.ts:176`（`navigate` 空焦点回退）；drag.ts 仅注释提及。测试/金样里的 'root' 是夹具数据，不动

---

### Task 1: layout 与 navigate 的 rootId 参数化

**Files:**
- Modify: `packages/engine/src/layout.ts`（LayoutOptions 增 rootId、build 入口、头注）
- Modify: `packages/engine/src/selection.ts`（navigate 增 rootId 参）
- Modify: `packages/engine/src/export.ts`（exportSceneSvg 透传 rootId——计划三裁定 8「PNG 只出当前画布」的引擎前提）
- Test: `packages/engine/src/layout.test.ts`、`packages/engine/src/selection.test.ts`

**Interfaces:**
- Consumes: 无（core 画布化已合并 main，本任务不依赖 core 新 API——engine 不 import core 的纪律保持）
- Produces（计划三 web 消费）：
  - `LayoutOptions.rootId?: string`（缺省 `'root'`）
  - `navigate(currentId, direction, boxes, structure, rootId = 'root')`（第 5 参可选）
  - `exportSceneSvg(reader, opts)` 的 opts 增 `rootId?: string` 透传 layout

- [ ] **Step 1: 失败测试**

layout.test.ts 追加：
```ts
it('rootId 参数化：异根文档从指定根布局（缺省仍 root，金样不变）', () => {
  // 夹具：两个根 'root' 与 'root2' 各挂一子（reader 形态同既有夹具）
  const a = layout(reader, { ...baseOpts, rootId: 'root2' });
  expect(boxOf(a, 'root2')).toBeDefined();
  expect(boxOf(a, 'root')).toBeUndefined(); // 另一棵树不入场
  expect(layout(reader, baseOpts)).toEqual(layout(reader, { ...baseOpts, rootId: 'root' })); // 缺省等价
});
```
selection.test.ts 追加：`navigate(null, d, boxes, 'mindmap', 'root2')` 返回 'root2'；缺省仍 'root'。

- [ ] **Step 2: 跑红** — `pnpm --filter @gmind/engine test -- layout.test selection.test`
- [ ] **Step 3: 实现**

```ts
// layout.ts LayoutOptions 增：
  /** 多画布（2026-10-22）：布局起始根 id。缺省 'root'——旧调用方与金样逐字节不变。 */
  rootId?: string;
// collectTree 内：return build(rootId, 0);（函数签名透传，头注 L7/L124 同步改写）
// selection.ts navigate 签名：rootId: string = 'root' 第 5 参；L176 改 return rootId;
// export.ts exportSceneSvg opts 增 rootId 透传 layout 调用
```
- [ ] **Step 4: 跑绿＋金样验证** — `pnpm --filter @gmind/engine test` 全绿；`UPDATE_GOLDENS=1 pnpm --filter @gmind/engine test -- layout.test` 后 `git diff packages/engine/src/goldens` **必须为空**（不为空 = 行为漂移，回查）
- [ ] **Step 5: Commit** — `feat(engine): 多画布计划二 Task1 rootId 参数化（layout/navigate/export 透传，金样零 diff）`

---

### Task 2: defs clipPath 场景前缀化

**Files:**
- Modify: `packages/engine/src/render.ts`（createScene 增 idPrefix 选项，gm-avatar-clip 及所有 url(#…) 引用）
- Modify: `packages/engine/src/cursors.ts`（gm-cursor-clip 同款）
- Test: `packages/engine/src/render.test.ts`、`packages/engine/src/cursors.test.ts`

**Interfaces:**
- Produces：`createScene(svg, opts?: { idPrefix?: string })`；缺省无前缀 = 现状 id（既有断言 `url(#gm-avatar-clip)` 不动）
- 背景：同一 HTML 文档里两个 svg 场景（主画布 + 版本快照预览）共享 document 级 id 命名空间，`url(#gm-avatar-clip)` 取首个匹配——今天几何相同无可见 bug；多画布/预览并存时需可区分

- [ ] **Step 1: 失败测试**——`createScene(svg, { idPrefix: 'p2-' })` 后 `svg.querySelector('#p2-gm-avatar-clip')` 存在且节点引用 `url(#p2-gm-avatar-clip)`；缺省调用断言不变（既有用例绿即证）
- [ ] **Step 2-4**: 红 → 实现（createScene 内部把 prefix 传进 defs 构建与引用拼装；cursors.createCursorLayer 接收同一 prefix 或从 scene 派生）→ 绿
- [ ] **Step 5: Commit** — `feat(engine): 多画布计划二 Task2 defs clipPath 场景前缀化（缺省兼容）`

---

### Task 3: Viewport 状态存取公开 API

**Files:**
- Modify: `packages/engine/src/viewport.ts`（`getState()` / `restore(state)`）
- Test: `packages/engine/src/viewport.test.ts`

**Interfaces:**
- Produces（计划三切画布时存/取每画布视口）：
  - `Viewport.getState(): ViewportState`（`{ scale, tx, ty }` 快照，现有 interface 复用）
  - `Viewport.restore(state: ViewportState): void`（公开；内部走既有 `private set`＋`apply`，scale 经 clampScale）

- [ ] **Step 1: 失败测试**——panBy/zoomTo 后 getState 快照；再改动后 restore 快照，transform 属性逐值还原；restore 非法 scale（0/NaN）经 clampScale 钳制
- [ ] **Step 2-4**: 红 → 实现 → 绿
- [ ] **Step 5: Commit** — `feat(engine): 多画布计划二 Task3 Viewport 状态存取公开 API`

---

### Task 4: 收口门禁

- [ ] **Step 1**: `pnpm lint && pnpm typecheck && pnpm --filter @gmind/engine test`（420+ 全绿，新增用例计入）
- [ ] **Step 2**: `pnpm test` 全仓单测绿（core 367/368 含 bench 存量红口径不变）；web 未改动预期全绿
- [ ] **Step 3**: 金样终验（UPDATE_GOLDENS=1 后 git diff goldens 为空）
- [ ] **Step 4**: 更新 `docs/project-status.md` 多画布行追加「计划二 engine ✅」，commit
- [ ] **Step 5**: 启动计划三（web UI 页签条）编写

## Self-Review 记录

- **Spec 覆盖**：裁定 8 的引擎前提（export rootId）在 Task 1；裁定 3/4/7 无 engine 面（视口存取=切换体验前提，Task 3）；「金样零 diff」双任务双验证（T1 Step4 + T4 Step3）
- **类型一致**：rootId 三处签名一致；ViewportState 复用现有 interface（viewport.ts:36-40 区域）
- **留白登记**：cursors.ts 的 prefix 派生方式（独立参 vs 从 scene 取）留执行者按代码现状取简
