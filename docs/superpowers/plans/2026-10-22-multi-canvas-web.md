# 多画布 · 计划三：web UI（页签条与画布切换） 实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 用户可见的多画布——编辑器底部画布页签条（新建/切换/重命名/删除/排序），全部既有功能接「当前画布」口径，移动端只读可翻看（裁定 7）。

**Architecture:** EditorPage 增 `activeCanvasId` 状态为唯一事实源；`readerOf/handleOf` 绑定当前画布；切画布 = 保存旧视口 → rebuildScene（新 rootId）→ 恢复新画布视口 → 换 UndoManager。core/engine 接口已在计划一/二备齐（addCanvas 等 canvas-ops、rootId 参数化、idPrefix、getState/restore）。

**Tech Stack:** React 18 + 既有栈；无新依赖。

**Spec:** `docs/superpowers/specs/2026-10-21-multi-canvas-ruling.md`（本计划落实裁定 3/4/7 与 web 侧全部口径）

**执行环境：主仓 main 分支直接实现（需求方 2026-10-22 指令）；文件混合需分开提交时先问需求方。**

## Global Constraints

- **testid 契约**（AGENTS.md §三.6）：既有 testid 一个不破；新增一律 `canvas-tab-*` / `canvas-add` / `canvas-menu-*`
- **唯一写入口/校验先于事务**：全部写经 core canvas-ops/ops（计划一已交付）
- **错误文案两段式**=原因+下一步（NFR-USE-005）
- **engine 只增不改**：本计划不动 engine（计划二已交付全部所需接口）
- **移动端**：页签条只读可见可切（裁定 7），不装配编辑类控件
- **XMind 导出中间态（登记）**：本计划导出 XMind = 当前画布单 Sheet；裁定 8「XMind 全画布多 Sheet」由计划四 xmind-io 落地，验收文档登记中间态
- **idPrefix 契约**（计划二终审建议）：场景前缀只从画布 ULID 派生（纯字母数字），禁止从画布名派生
- **门禁五件套**收口：`pnpm lint && pnpm typecheck && pnpm test && pnpm --filter @gmind/server test:e2e && WEB_PORT=5174 API_ORIGIN=http://localhost:3001 pnpm --filter @gmind/web e2e`
- web e2e 基线：181 passed / 3 failed（workspace file-card strict-mode 存量，main 同档）/ 5 skipped

## 关键现状锚点（已读码实证）

- `apps/web/src/pages/EditorPage.tsx:4661` `readerOf(d: Y.Doc): DocReader`——画布绑定点：`getNode(d, id, canvasId)` / `childrenIds(d, id, canvasId)` / `listSummaries(d, canvasId)` / `getMeta(d, canvasId)`（core 计划一签名已就绪）
- 同文件 `handleOf`（:4671）写 API 适配——ops 末位 canvasId 透传
- `rebuildScene`（:3146）：已含视口字段拷贝先例（:3174-3179）；计划二交付 `vp.getState()/restore()` 后改用之
- 底栏 JSX `:4529+`（node-count/视图/缩放）——页签条挂这里（企微形态：状态栏左侧画布页签）
- root 兜底点清单：`primaryId()` :1162、`centerRoot()` :1122、`handleSelectAll` :1766、粘贴/落点 `moveNode(d, id, ROOT_NODE_ID)` 兜底、装载后 `selection.selectOnly(ROOT_NODE_ID)` :3581、FindReplace collectMatchIds、TaskTable subtreeIds(doc, ROOT_NODE_ID)、thumbnail.ts buildThumbSvg、VersionPanel renderPreview
- 光标：`buildRemoteCursors`（collab.ts:157）产裸 nodeId 列表；engine cursors 层对「不在场景的 nodeId 优雅跳过」——切画布后重渲染即天然隐藏（裁定 4 需测试钉死而非新代码）

---

### Task 1: 画布状态中枢（activeCanvasId + reader/handle 绑定 + 切换编排）

**Files:**
- Modify: `apps/web/src/pages/EditorPage.tsx`（状态、readerOf/handleOf、rebuildScene、装配 effect）
- Create: `apps/web/src/editor/useActiveCanvas.ts`（状态＋切换编排抽离，EditorPage 已 4700 行不再加肉）
- Test: `apps/web/src/editor/useActiveCanvas.test.tsx`（或同域单测）

**Interfaces:**
- Consumes：core `listCanvases/resolveCanvasId/setActiveCanvas/rootIdOf`；engine `layout rootId`、`vp.getState/restore`、`createUndoManager(doc, canvasId)`
- Produces（后续 Task 消费）：
  - `useActiveCanvas(doc): { activeCanvasId, canvases: CanvasInfo[], switchCanvas(id), refresh() }`
  - `switchCanvas` 编排：保存旧画布 `vp.getState()` 入 `Map<canvasId, ViewportState>` → `setActiveCanvas(doc, id)`（ORIGIN_SYSTEM）→ rebuildScene（reader 绑新画布、createScene idPrefix=`c${id}-`）→ 恢复新画布视口（无存档则 fit）→ 换 UndoManager（`createUndoManager(doc, id)`，每画布缓存一个实例）→ 清空选区/关行内编辑
  - EditorPage 内 `activeCanvasIdRef` 供全部写路径透传 canvasId

- [ ] **Step 1: 失败测试**——双画布 doc：switchCanvas 后 reader 读到 c2 的树；UndoManager 隔离（c1 编辑撤销不触 c2）；视口 Map 存取正确
- [ ] **Step 2-4**: 红 → 实现 → 绿（`pnpm --filter @gmind/web test`）
- [ ] **Step 5: 既有 web 单测全绿**（单画布默认路径行为不变）
- [ ] **Step 6: Commit** — `feat(web): 多画布计划三 Task1 画布状态中枢（reader/handle 绑定+切换编排）`

---

### Task 2: 底部画布页签条（桌面）

**Files:**
- Create: `apps/web/src/editor/CanvasTabBar.tsx` + `CanvasTabBar.css`（样式令牌对齐工作台外壳：圆角 10px、菜单阴影 0 8px 24px）
- Modify: `apps/web/src/pages/EditorPage.tsx`（底栏装配）
- Test: `apps/web/e2e/canvas-tabs.e2e.spec.ts`（新套件）

**Interfaces:**
- Consumes：Task 1 的 useActiveCanvas；core `addCanvas/renameCanvas/deleteCanvas/reorderCanvases`
- Produces：
  - `<CanvasTabBar doc activeCanvasId onSwitch onChanged />`——页签（`data-testid="canvas-tab-${id}"`，当前 `canvas-tab-active` 类）＋`canvas-add` ＋双击重命名行内 input（`canvas-rename-input`，Enter/失焦提交、Esc 取消）＋右键菜单（重命名/删除，`canvas-menu-rename`/`canvas-menu-delete`）＋HTML5 拖拽排序
  - 删除确认走 window.confirm 先例（查现状）或两段式文案 toast；最后一张删除被 core 拦截（CANVAS_LAST_FORBIDDEN）→ 两段式 toast「这是最后一张画布。画布不可全部删除」
  - 新建后自动切到新画布（addCanvas 已置 activeCanvasId）

- [ ] **Step 1: e2e 先红**——新建画布→页签+1 且自动切换→双击重命名持久化→右键删除→刷新后页签/名字仍在
- [ ] **Step 2-4**: 红 → 实现 → 绿
- [ ] **Step 5: Commit** — `feat(web): 多画布计划三 Task2 底部画布页签条`

---

### Task 3: 移动端只读页签（裁定 7）

**Files:**
- Modify: `apps/web/src/editor/CanvasTabBar.tsx`（readOnly prop：隐藏 ＋/重命名/删除/排序，保留切换）
- Modify: `apps/web/src/pages/EditorPage.tsx`（readOnly 分支装配）
- Test: `apps/web/e2e/mobile-readonly.e2e.spec.ts`（追加用例）＋ `canvas-tabs.e2e.spec.ts`

- [ ] **Step 1: e2e 先红**——≤768px 视口：页签可见可切换、`canvas-add` `toHaveCount(0)`、编辑类控件不装配断言不破（既有 mobile-readonly 全绿）
- [ ] **Step 2-4**: 红 → 实现 → 绿
- [ ] **Step 5: Commit** — `feat(web): 多画布计划三 Task3 移动端只读页签`

---

### Task 4: 口径接线扫荡（当前画布 vs 全文档）

**Files:**
- Modify: `apps/web/src/pages/EditorPage.tsx`（root 兜底点清单逐项）、`apps/web/src/editor/FindReplace.tsx`、`apps/web/src/editor/TaskTable.tsx`、`apps/web/src/editor/thumbnail.ts`、`apps/web/src/editor/VersionPanel.tsx`、`apps/web/src/editor/image-export.ts`
- Test: 各域既有测试适配＋新增口径用例

**逐项口径（逐项核对打勾，testid 不破）：**
1. `primaryId()` → `rootIdOf(doc, activeCanvasId)`
2. `centerRoot()` / `fitCanvas` → 当前画布 layout（Task 1 已使 reader 绑定，此处只换根查找）
3. `handleSelectAll` → `subtreeIds(doc, rootIdOf(doc, activeCanvasId), activeCanvasId)`
4. 粘贴/拖拽落空白兜底 `moveNode(d, id, ROOT_NODE_ID)` → 当前画布 rootId
5. 装载后 `selection.selectOnly(ROOT_NODE_ID)` → 当前画布 rootId
6. FindReplace collectMatchIds → 当前画布子树
7. 底栏 `node-count` → `countAliveReachable(doc, activeCanvasId)`（当前画布口径）
8. 导出 PNG/JPG → `exportSceneSvg` 传当前画布 rootId（计划二接口）；文件名 = 文件标题＋画布名（多画布时）
9. 缩略图（裁定 3）→ `buildThumbSvg` 恒取**第一画布**（canvasOrder 首个存活）
10. 结构/主题切换 → `setDocMeta(doc, {...}, undefined, activeCanvasId)`（画布级，裁定 5）
11. 版本快照预览 → 快照 doc 中**同 canvasId** 的画布（找不到回退第一画布）
12. XMind 导出 → 当前画布单 Sheet（中间态，Global Constraints 已登记）

- [ ] **Step 1: 逐项单测/e2e 先红**（多画布 doc 下计数/查找/导出范围断言）
- [ ] **Step 2-4**: 红 → 实现 → 绿
- [ ] **Step 5: Commit** — `feat(web): 多画布计划三 Task4 全功能当前画布口径接线`

---

### Task 5: 裁定 4 光标隐藏钉死 + 评论跨画布定位（默认假设 4）

**Files:**
- Modify: `packages/gmind-core/src/canvas.ts`（新增 `canvasIdOfNode(doc, nodeId): string | null`——遍历存活画布 nodes map，TDD）
- Modify: `apps/web/src/pages/EditorPage.tsx`（评论 onLocate：节点不在当前画布 → 先 switchCanvas 再定位）
- Test: core `canvas.test.ts` 追加；`apps/web/e2e/collab.e2e.spec.ts` 追加裁定 4 用例；`comments.e2e.spec.ts` 追加跨画布定位用例

- [ ] **Step 1: 先红**——canvasIdOfNode 单测；e2e：双上下文，B 端在画布 2 选节点，A 端画布 1 画布内**不出现** B 的光标（现有「不存在于场景优雅跳过」机制的钉死，非新代码）；评论定位跨画布：画布 1 评论指向画布 2 节点 → 点击后活动画布=画布 2 且节点选中
- [ ] **Step 2-4**: 红 → 实现 → 绿
- [ ] **Step 5: Commit** — `feat(core,web): 多画布计划三 Task5 光标跨画布隐藏钉死+评论跨画布定位`

---

### Task 6: server 配额按画布（计划一终审 Important-4）

**Files:**
- Modify: `apps/server/src/collab/collab.service.ts`（storeDocument 配额校验）、`apps/server/src/files/files.service.ts`（saveDocState 校验）
- Modify: `packages/gmind-core/src/read.ts`（如需 `countAliveReachableAll(doc): Map<canvasId, number>` 或逐画布校验 helper）
- Test: `apps/server/test` 相应 e2e 追加

**口径**：裁定 1「按画布」——**每张画布各自 ≤ MAX_DOC_NODES(500)**；files.node_count 存全文档合计（展示口径，注释登记）；crafted activeCanvasId 藏节点绕过校验的漏洞随本任务关闭。

- [ ] **Step 1: e2e 先红**——crafted doc_state（active 画布 10 节点 + 第二画布 600 节点）PUT 被拒（两段式文案）
- [ ] **Step 2-4**: 红 → 实现 → 绿（server e2e 197→199 全绿）
- [ ] **Step 5: Commit** — `feat(server): 多画布计划三 Task6 配额按画布逐张校验`

---

### Task 7: 收口门禁与文档

- [ ] **Step 1**: 门禁五件套全绿（web e2e 基线 181+新增，3 红存量口径不变）
- [ ] **Step 2**: `docs/project-status.md` 多画布行追加「计划三 web UI ✅」；§三「已裁定待排期」bullet 更新
- [ ] **Step 3**: README 进度行按口径评估（终审建议 3 的联动义务）
- [ ] **Step 4**: Commit `docs: 多画布计划三收口登记`
- [ ] **Step 5**: 启动计划四（xmind-io 多 Sheet＋验收文档）

## Self-Review 记录

- **Spec 覆盖**：裁定 3（T4.9）、4（T5）、5（T4.10）、7（T3）；假设 1（T2 命名/重命名）、2（T4 TaskTable 现状即当前画布）、4（T5）、5（T2 最后一张禁删）；裁定 8 的 PNG 半（T4.8）＋XMind 半（中间态登记→计划四）；终审 Important-4（T6）；idPrefix 契约（Global Constraints）
- **类型一致**：useActiveCanvas 产出在 T1 定义、T2/T3/T5 消费一致；canvasIdOfNode 在 T5 定义
- **留白登记**：删除确认的 UI 先例（confirm vs 自绘弹层）由执行者查现状取齐；T4 逐项清单执行时以现文件行号复核（4700 行文件行号漂移容忍）
