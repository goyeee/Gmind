# Gmind M1b（渲染引擎与编辑器）实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 交付 M1 收官段：SVG 渲染引擎（三结构布局/主题/装饰/视口/选择/拖拽/文本编辑）、浏览器剪贴板层、编辑器页面（工具栏/底栏/富内容 UI）、文件内容端点与本地图片存储、2 秒自动保存与三态指示、500 节点 40fps 压测脚本，最终达成「PRD 第 3 章 P0 单机全过」。

**Architecture:** `packages/engine` 只依赖 `@gmind/core`，四层：测量适配器（注入函数）→ 布局纯函数（同输入必同输出，spec §6.1）→ SVG 场渲染器（按节点 id 协调更新）→ 交互层（手势/键盘全部经 core 操作 API）。apps/web 的编辑器页装配引擎与保存循环（Y.Doc → 2s 防抖 PUT doc-state）。图片走存储 Provider 接口（本地磁盘实现，MinIO 可用后换实现不换接口——M0 裁决）。

**Tech Stack:** TypeScript strict / Yjs(经 core) / Vitest + jsdom / React 18 / Playwright。无新运行时依赖（measureText 用浏览器 Canvas，测试注入桩）。

**Spec:** `docs/superpowers/specs/2026-09-18-gmind-phase1-design.md` §6（引擎）、§5.3/§5.10、PRD FR-EDT-001~030、FR-EDT-033/034、NFR-PERF-001/003。

**M1a 准入清单（终审定稿，本计划执行）：** 渲染遍历从 `ROOT_NODE_ID` 起（勿用 countAlive——不可达孤儿会被计入）；`capUndoStack` 统一在每次写后调用；错误映射需含 insertSpec 的 TypeError；富内容粘贴定义结构化 JSON 格式（SpecNode 只带文本，不够用）；样式值读回为 string。

## Global Constraints

- 引擎纯度：`packages/engine` 禁止 import yjs/@gmind/shared 以外的东西；DOM 仅允许 SVG 创建与事件（布局/测量逻辑必须可用注入桩在 node 环境测试）。
- 确定性布局（spec §6.1）：同输入必同输出；折叠节点按叶子处理；文本换行宽度上限取主题 `maxTextWidth`；中英混排逐字符贪心断行（无空格语言）。
- 视口：缩放 10%–400%，Ctrl/Cmd+滚轮以光标为中心（FR-EDT-027）；适应画布四周留白 ≤5%（FR-EDT-028）。
- 自动保存（FR-EDT-033/034）：编辑停顿 2s 内 PUT；状态三态「已保存 HH:MM / 保存中… / 保存失败，正在重试」（离线态 M2）；失败指数退避重试最多 3 次。
- 撤销（FR-EDT-004）：所有用户写经 user origin；每次写后统一 `capUndoStack(um)`（M1a 准入）；结构切换/主题套用纳入撤销（setDocMeta 默认 user origin 已满足）。
- 键盘（FR-EDT-001/004/006）：Enter 同级 / Tab 子级 / Shift+Tab 父级（root 上 Shift+Tab 提示「中心主题不支持添加父主题」）/ Delete/Backspace 删除（root 降级清空）/ Ctrl+Z、Ctrl+Y|Ctrl+Shift+Z / 方向键几何最近导航 / Home/End 同级首末 / Ctrl+A 全选 / Ctrl+/ 折叠。
- 文本编辑（FR-EDT-005）：双击或 Enter 进入编辑态；composition 期间只更新本地态、compositionend 提交；超 500 字截断并提示「节点文本长度已达上限」；Esc/空白点击退出保存。
- 图片（FR-EDT-020）：PNG/JPG/GIF/WebP、单张 ≤10MB、MIME+魔数校验；显示宽/高 ≤200px 等比。
- 图标（FR-EDT-021）：priority(1-9)/progress(0-100% 八档)/flag(6 色)/star(5 色)，组内替换跨组叠加，文本左侧展示。
- 提交 Conventional Commits 中文；每任务 TDD；gates = `pnpm lint && pnpm typecheck && pnpm test && pnpm --filter @gmind/server test:e2e` 全绿（web e2e 在相关任务跑）。

---

### Task 1: 服务端文件内容端点

**Files:**
- Modify: `apps/server/src/files/files.controller.ts`, `apps/server/src/files/files.service.ts`
- Test: `apps/server/test/file-content.e2e-spec.ts`

**Interfaces:**
- Produces:
  - `GET /api/files/:id` → `{ id, title, structure, themeId, nodeCount, docState: base64 }`（owner 或 collaborator；非本人且无权限 → 404 不泄露存在性；已删 → 404）
  - `PUT /api/files/:id/doc-state` body `{ docState: base64 }` → 服务端经 `docFromState`+`countNodes` 校验（解析失败 400）与配额 ≤500（超限 403 「文档节点数已达上限（500）」），回写 `doc_state`+`node_count`+`updated_at` → `{ nodeCount }`
  - `PATCH /api/files/:id` body `{ title }`（createFileSchema.title 复用）→ 重命名 → FileListItem
  - `POST /api/files/:id/open` → 回写 `last_opened_at` → `{ lastOpenedAt }`
- 复用 FilesService.toListItem；新增 `FilesService.getOwnedFileWithState(userId, id)`、`saveDocState(userId, id, state: Uint8Array)`、`rename(userId, id, title)`、`markOpened(userId, id)`；权限辅助 `assertCanRead(userId, file)`（owner 或 file_collaborators 存在行，一期 collaborator 即可编辑——spec §7.2）。

- [ ] **Step 1 失败测试**（file-content.e2e-spec.ts，用 createTestApp + SessionService 签发 token）：owner 读取返回 base64 可被 `docFromState` 还原且 meta 正确；非相关用户 GET → 404；PUT 合法状态（含 3 节点）→ nodeCount=3 且再次 GET 读回一致；PUT 非法字节 → 400「文档解析失败」；PUT 501 节点状态 → 403 上限文案；PATCH 改名 → GET title 变化且列表同步；POST open → lastOpenedAt 非空；已删文件全部端点 404。
- [ ] **Step 2** 跑 e2e 确认失败 → **Step 3** 实现 → **Step 4** 全部 gates → **Step 5**
- [ ] **Step 5: Commit** `git add apps/server && git commit -m "feat(server): 文件内容读写/改名/打开端点与配额校验"`

---

### Task 2: 本地磁盘图片存储 Provider

**Files:**
- Create: `apps/server/src/storage/storage.module.ts`, `storage.service.ts`, `local-disk.provider.ts`, `storage.controller.ts`
- Test: `apps/server/test/storage.e2e-spec.ts`

**Interfaces:**
- Produces:
  - `interface StorageProvider { put(key: string, data: Buffer, contentType: string): Promise<void>; get(key: string): Promise<{ data: Buffer; contentType: string } | null>; }`（MinIO Provider 二期换实现）
  - `StorageService` 包装：`saveImage(fileId, buffer) → { key }`——扩展名/魔数白名单（png `\x89PNG`、jpg `\xFF\xD8\xFF`、gif `GIF8`、webp `RIFF....WEBP`）、≤10MB（超限 413「图片大小超出 10MB 限制」）、键 `files/{fileId}/{ulid}.{ext}`
  - `GET /api/images/:key(*)`（通配）→ 200 + 正确 Content-Type + `Cache-Control: public, max-age=31536000, immutable`；不存在 → 404
  - `POST /api/files/:id/images`（multipart 字段 file）→ `{ key, w, h }`? —— 尺寸由前端读取（服务端不解析像素）→ 返回 `{ key }`
  - 存储目录：`env.STORAGE_DIR`（默认 `./.data/storage`，git-ignored——加入根 .gitignore）
- Key 安全：拒绝含 `..` 的 key；contentType 白名单映射。

- [ ] **Step 1 失败测试**：上传小 PNG（fixture 内嵌 1×1 png Buffer）→ key 返回且 GET 读回字节一致 + Content-Type image/png；上传 .txt 伪装 → 415「不支持的图片格式」；>10MB Buffer → 413 文案；GET 不存在 → 404；GET 带 `..` 的 key → 400。
- [ ] **Step 2-4** 失败→实现→gates（`.gitignore` 加 `.data/`）
- [ ] **Step 5: Commit** `git add apps/server .gitignore && git commit -m "feat(server): 本地磁盘图片存储 Provider 与上传/读取端点"`

---

### Task 3: engine 包骨架、测量适配器与数据结构

**Files:**
- Create: `packages/engine/package.json`, `tsconfig.json`, `vitest.config.ts`, `src/index.ts`, `src/types.ts`, `src/measure.ts`, `src/measure.test.ts`
- Modify: 根 `tsconfig.base.json`？不动；web 稍后接线

**Interfaces:**
- Produces:
  - `interface MeasureAdapter { measureTextLine(text: string, style: TextStyle): number; }`（宽度；引擎自算行高）
  - `TextStyle = { fontSize: number; fontWeight: number; fontFamily: string }`
  - `interface NodeBox { id: string; x: number; y: number; w: number; h: number; side: 'left' | 'right' | 'down'; depth: number }`（坐标为场景坐标，中心主题 (0,0) 居中）
  - `interface EdgeRoute { id: string; from: {x;y}; to: {x;y}; kind: 'bezier' | 'elbow' }`
  - `interface LayoutResult { nodes: NodeBox[]; edges: EdgeRoute[]; collapsedCounts: Map<string, number>; width: number; height: number }`
  - `measureNodeBox(text, style, theme): { w; h; lines: string[] }`——按 `\n` 分行、超 `theme.maxTextWidth` 逐字符贪心断行（中英文通用）、行高 = fontSize × 1.5、宽 = max 行宽 + 左图标区(theme.iconSlotWidth × 图标数) + 内边距(theme.nodePaddingX×2)
- engine 只依赖 `@gmind/core`（读快照类型）；tsconfig strict + typecheck 脚本；web 后续以 vite alias 引源码。

- [ ] **Step 1 失败测试**：单行文本宽度=桩返回值+padding；多行（`\n`）行高累计；超宽断行（10 字 × 每字 10px，maxTextWidth=50 → 2 行）；图标槽累加；空文本最小尺寸（theme.minNodeWidth）。
- [ ] **Step 2-4** 失败→实现→gates（engine 纳入根 typecheck/test：确认 `pnpm -r test` 收编）
- [ ] **Step 5: Commit** `git add packages/engine pnpm-lock.yaml && git commit -m "feat(engine): 包骨架、测量适配器与节点盒计算"`

---

### Task 4: 三结构布局算法 + 金样测试

**Files:**
- Create: `packages/engine/src/layout.ts`, `src/layout.test.ts`, `src/goldens/`（JSON 金样）

**Interfaces:**
- Produces: `layout(doc: Y.Doc, opts: { structure: StructureType; theme: ThemeTokens; measure: MeasureAdapter }): LayoutResult`
- 算法（全部纯函数、确定性）：
  1. 从 `ROOT_NODE_ID` 收集存活树（`getNode`/`childrenIds`，跳过墓碑；折叠节点按叶子 + 统计 `collapsedCounts`）
  2. 盒子：`measureNodeBox` per node（样式 = 主题派生 + node.style 覆盖：fontSize/color 等读 style map）
  3. **mindmap（左右分布）**：root 居中 (0,0)；一级子树按文档序贪心分侧——累计子树高过半即切到左侧（保序，右侧自上而下、左侧自上而下）；子级一律在父的同一侧延伸；垂直布局：子树高 = max(自身高, Σ子树高 + V_GAP×(n-1))，自底向上累加，兄弟间 V_GAP
  4. **logic（向右）**：全部子树在父右侧，同 mindmap 右侧规则
  5. **org（向下）**：子树宽 = max(自身宽, Σ子宽 + H_GAP×(n-1))，兄弟水平排布，父居子宽中点上方；边走 elbow
  6. 边锚点：mindmap/logic 左右节点取左右中点；org 取下/上中点；bezier 控制点水平外伸 clamp(60, dx×0.5)；collapsed 节点无子边
  7. 输出 bounding box（width/height）
- `ThemeTokens`（Task 5 正式定义，本任务先内联最小桩：`{ nodePaddingX: 12; iconSlotWidth: 20; V_GAP: 14; H_GAP: 40; maxTextWidth: 240; minNodeWidth: 40; ... }`）

- [ ] **Step 1 金样失败测试**：固定 measure 桩（每字符 10px×20px）+ 固定 3 层树 → 三结构各生成 JSON 金样（首次运行 `UPDATE_GOLDENS=1` 生成，提交入库）；不变量测试：任意树（属性化构造 5 棵固定树）三结构均无节点重叠（bbox 相交断言，兄弟/父子除外）、mindmap 一级左右均有、org 父居中、折叠子树不出盒子。
- [ ] **Step 2-4** 失败→实现→gates
- [ ] **Step 5: Commit** `git add packages/engine && git commit -m "feat(engine): 思维导图/逻辑图/组织架构图确定性布局与金样测试（FR-EDT-011/017）"`

---

### Task 5: 主题系统（3 套预置）

**Files:**
- Create: `packages/engine/src/themes.ts`, `src/themes.test.ts`

**Interfaces:**
- Produces:
  - `interface ThemeTokens`（补全 Task 4 桩）：node fill/border/borderRadius、root/level1/level2 分级默认 fill、text color、fontFamily/fontSize 分级、edge color/width、canvasBackground、maxTextWidth 等全部布局与渲染所需 token
  - `THEMES: Record<'gmind-blue' | 'gmind-warm' | 'gmind-accessible', ThemeTokens>`——blue（默认经典蓝）、warm（暖橙）、accessible（WCAG AA ≥4.5:1 高对比，色盲友好：蓝橙双色系避开红绿对比）
  - `resolveNodeStyle(theme, depth, nodeStyle: Record<string,string>): ResolvedNodeStyle`——主题派生 + 节点覆盖（fill/fontSize/color 等按 key 覆盖；颜色值合法性由 core setStyle 不校验、渲染时非法值回退主题值）
- core meta `themeId` 值域即这三枚 key（默认 gmind-blue——注意 M0 迁移里默认值是 'gmind-light'：**裁决：migration 默认 'gmind-light' 不改库，resolve 时 'gmind-light' 视作 'gmind-blue' 别名**，README 记录）。

- [ ] **Step 1 测试**：三主题 token 完整性（必备 key 齐全）；accessible 主题正文对比度 ≥4.5:1（对 level1 fill 计算对比度的纯函数 + 断言）；resolveNodeStyle 覆盖优先级；'gmind-light' 别名解析为 blue。
- [ ] **Step 2-4** 失败→实现→gates
- [ ] **Step 5: Commit** `git add packages/engine && git commit -m "feat(engine): 三套预置主题（含 WCAG AA 无障碍）与节点样式解析（FR-EDT-014）"`

---

### Task 6: SVG 场渲染器与协调更新

**Files:**
- Create: `packages/engine/src/render.ts`, `src/render.test.ts`

**Interfaces:**
- Produces:
  - `renderScene(container: SVGSVGElement, layout: LayoutResult, theme: ThemeTokens, texts: Map<string, {text; icons; note; href; image; collapsed}>, styleOf: (id) => ResolvedNodeStyle): SceneHandle`
  - `SceneHandle.update(layout, ...)` ——按节点 id diff：复用 `<g data-node-id>`、文本 tspan 重建、边 path d 重算；新增/删除以 id 集合差分；**更新后保持既有 DOM 元素引用**（焦点稳定性）
  - 层次：`<g class="edges">` 在下、`<g class="nodes">` 在上；节点 `<g>` 含 rect（圆角/填充/描边 per resolvedStyle）、text（tspan 多行）、图标组（icons 顺序 priority/progress/flag/star 左侧排列，字符占位渲染——正式图标字形用 emoji/字符映射表如 ⭐🚩、进度用 ◐◑ 圆环字符——M1b 用字符映射，视觉打磨后置）、note 角标（❗或 N 小标）、link 角标（🔗）、image `<image>`（href 走 `/api/images/{key}`，≤200px 等比）、折叠徽标 `<g class="collapse-badge" data-for-id>`（「+N」计数）
- 渲染不做任何事件绑定（交互层 Task 8/9 用事件委托）。

- [ ] **Step 1 jsdom 测试**：初次渲染节点/边数量正确、文本 tspan 行数正确、折叠徽标 +N 文案、image href 拼接、图标字符按组渲染；update 场景：改文本 → 同一 `<g>` 元素被复用（引用相等断言）、删节点 → 元素移除、增节点 → 新元素；结构切换 → 边 kind 变化。
- [ ] **Step 2-4** 失败→实现→gates
- [ ] **Step 5: Commit** `git add packages/engine && git commit -m "feat(engine): SVG 场渲染器与按 id 协调更新"`

---

### Task 7: 视口（平移/缩放/适应画布）

**Files:**
- Create: `packages/engine/src/viewport.ts`, `src/viewport.test.ts`

**Interfaces:**
- Produces:
  - `class Viewport { scale: number; tx: number; ty: number; attach(svg: SVGSVGElement, sceneRoot: SVGGElement): void; panBy(dx, dy); zoomAt(factor, cx, cy); zoomTo(scale); fit(layoutBox, viewportSize, maxPaddingRatio = 0.05): void; toScene(clientX, clientY): {x;y}; destroy(): void }`
  - 缩放 clamp 0.1–4.0；`zoomAt` 以 (cx, cy)（视口坐标）为中心：scale' = clamp(scale×factor)，tx' = cx - (cx - tx)×(scale'/scale)（cy 同理）；滚轮：wheel 无修饰 = 平移（dy 滚动）、ctrl/meta = zoomAt(1.1 / 1/1.1)；通过 apply() 把 transform 写到 sceneRoot（`translate(tx,ty) scale(s)`）
- [ ] **Step 1 jsdom 测试**：zoomAt 中心点场景坐标不变（光标中心缩放）；clamp 生效；fit 后布局包围盒含于视口且四周留白 ≤5%；toScene 往返一致。
- [ ] **Step 2-4** 失败→实现→gates
- [ ] **Step 5: Commit** `git add packages/engine && git commit -m "feat(engine): 视口平移/以光标为中心缩放/适应画布（FR-EDT-027/028）"`

---

### Task 8: 选择模型与键盘导航

**Files:**
- Create: `packages/engine/src/selection.ts`, `src/selection.test.ts`

**Interfaces:**
- Produces:
  - `class SelectionModel { selected: Set<string>; onChange; set(ids); toggle(id); clear(); isMarquee; beginMarquee(x,y); updateMarquee(x,y); endMarquee(): string[]（bbox 相交的节点 id，从 NodeBox[] 算） }`（几何相交判定接收 NodeBox[] 与 viewport 变换）
  - `navigate(currentId, direction: 'up'|'down'|'left'|'right', boxes: NodeBox[], structure): string | null`——纯函数：candidate 集合 = 同侧/父/子按方向过滤，取「方向投影距离 + 垂直偏移」最小者；无候选返回 null（FR-EDT-006 无匹配不动）
  - `siblingEnd(currentId, boxes, which: 'first'|'last')`——Home/End（同级首末）
- [ ] **Step 1 测试**：toggle 加减选互不影响他人；marquee 框住 3 个全中、部分相交算中（FR-EDT-008 相交即入选）；navigate 四方向在 mindmap 金样布局上的期望命中（构造固定断言）；无候选返回 null；siblingEnd 首末。
- [ ] **Step 2-4** 失败→实现→gates
- [ ] **Step 5: Commit** `git add packages/engine && git commit -m "feat(engine): 选择模型/框选/方向键几何导航（FR-EDT-006/008）"`

---

### Task 9: 拖拽换父、浮动主题与文本编辑覆盖层

**Files:**
- Create: `packages/engine/src/drag.ts`, `src/drag.test.ts`, `packages/engine/src/texteditor.ts`, `src/texteditor.test.ts`

**Interfaces:**
- Produces:
  - `class DragController { attach(svg, deps: { viewport; getBoxes(): NodeBox[]; onDrop(id, targetId | null): void; isDescendant(id, maybeChild): boolean; canReparent(id): boolean }): void; destroy(): void }`——pointerdown 于选中节点启动（阈值 4px）；拖动中每帧命中检测（视口坐标→场景坐标→bbox 命中，排除自身与后代）；命中 ≥300ms 高亮目标（`.drop-target` class）；释放：target 存在 → onDrop(id, targetId)，空白 → onDrop(id, null)（浮装主题 = moveNode(id, 'root')，页面层执行）；后代命中 → `.drop-forbidden` 且不触发
  - `class TextEditorOverlay { open(box, value, opts: { onCommit(text), onCancel() }): void; close(): void }`——HTML textarea 绝对定位覆盖节点（viewport 换算屏幕坐标，缩放同步 fontSize×scale）；compositionstart/end 期间仅本地态；commit 前 `text.length > 500 → slice(0,500)` 并回调 `onTruncated()`（页面层提示「节点文本长度已达上限」）；Esc → onCancel；blur → commit
- [ ] **Step 1 jsdom 测试**：DragController 用合成 PointerEvent 序列：down→move(>阈值)→悬停 target 模拟 300ms（fake timers）→up → onDrop 参数正确；空白释放 → null；后代目标 → forbidden 不回调；TextEditor：composition 中不 commit、end 后 commit；501 字截断回调与值截断；Esc onCancel。
- [ ] **Step 2-4** 失败→实现→gates
- [ ] **Step 5: Commit** `git add packages/engine && git commit -m "feat(engine): 拖拽换父/浮动主题手势与 IME 安全文本编辑覆盖层（FR-EDT-001/003/005）"`

---

### Task 10: 浏览器剪贴板层

**Files:**
- Create: `packages/engine/src/clipboard.ts`, `src/clipboard.test.ts`

**Interfaces:**
- Produces:
  - `copyNodes(doc, ids): { internal: ClipboardPayload; text: string }`——internal：`{ v: 1; nodes: Array<NodeSnapshot & {id...}> 森林 }`（含 style/icons/note/href/image——富内容粘贴，M1a 准入）；text：`subtreeToOutlineText` 森林拼接（多 root 依次）
  - `pastePayload(doc, parentId, index, payload, imageKeyRemap?: (key) => Promise<string>): Promise<string[]>`——internal 优先（新建 id、写回 style/icons/note/href/image——image 需 remap 时先复制对象存储取新 key）；否则 `outlineToSpec` + `insertSpec`（纯文本路径）
  - `cutNodes(doc, ids): payload` ——copy + deleteNodes（同事务语义：两步连续 user 操作，undo 两次? ——**裁决：cut = copy + delete 两个 user 事务**，Yjs captureTimeout 500ms 内自动合并为一个撤销单元，满足一次 Ctrl+Z 撤销剪切）
  - 剪贴板读写：`writeToSystemClipboard(payload)`（navigator.clipboard.write 提供两 MIME；jsdom 缺失时降级仅内部内存持有 lastPayload——M1b 页面内粘贴始终可用，跨应用文本路径降级记录 README）
- [ ] **Step 1 jsdom 测试**：copy 3 层含 style/icons/note → internal 森林字段完整 + text 缩进正确；pastePayload internal 路径重建全部富字段（id 全新）；纯文本路径走 outlineToSpec；cut 后节点消失 + payload 可 paste；image remap 回调被调用且写入新 key。
- [ ] **Step 2-4** 失败→实现→gates
- [ ] **Step 5: Commit** `git add packages/engine && git commit -m "feat(engine): 浏览器剪贴板层——内部结构化+文本大纲双格式（FR-EDT-009/010）"`

---

### Task 11: 编辑器页面装配（/edit/:fileId）

**Files:**
- Create: `apps/web/src/pages/EditorPage.tsx`, `apps/web/src/editor/useEditorDoc.ts`, `apps/web/src/editor/saveLoop.ts`, `apps/web/src/editor/keyboardMap.ts`
- Modify: `apps/web/src/App.tsx`（路由）, `apps/web/src/pages/WorkspacePage.tsx`（条目点击进编辑器）, `apps/web/src/api/client.ts`（如需扩展）
- Test: `apps/web/e2e/editor.e2e.spec.ts`

**Interfaces:**
- `useEditorDoc(fileId)`：加载 `GET /api/files/:id` → `docFromState(base64→Uint8Array)`；`POST open`；暴露 `{ doc, um, title, setTitle }`；title 编辑 = setDocMeta({title}) + 防抖 PATCH。
- `saveLoop(doc, fileId, setStatus)`：`doc.on('afterTransaction', ...)` 触发 2s 防抖（新事务重置计时）→ `PUT doc-state`（base64）→ setStatus('saved HH:MM')；请求中再触发 → 'saving'；失败指数退避（1s/2s/4s，3 次后 setStatus('error 保存失败，正在重试') 并保留待存状态、下次事务重置重试）。
- `keyboardMap`：Ctrl+Z/Ctrl+Y|Cmd+Z/Cmd+Shift+Z → undo/redo + capUndoStack 后无需（undo/redo 不进栈）；Enter（未编辑态：addChild(id, {index: 同级+1}) 进编辑）/ Tab（addChild child）/ Shift+Tab（父存在 → addChild(parent.parentId, index+1) 并把新节点插入原节点前？——**裁决：Shift+Tab 在当前节点与父之间插新父级 = addChild(grandparentId, 原节点在祖父 children 中的 index) 然后 moveNode(原节点, 新节点)**（保持原子树跟随）；root 上 Shift+Tab → toast「中心主题不支持添加父主题」；Delete/Backspace → deleteNodes(选中)（含 root 降级）/ Ctrl+A 全选存活节点 / Ctrl+/ toggleCollapse / 方向键 navigate / Home/End / 双击或 Enter 于选中节点 → TextEditorOverlay。
- 编辑器布局：顶部工具栏（结构下拉 3 项、主题下拉 3 项、撤销/重做按钮、标题输入）、右侧暂无面板（M3 评论）、底部栏（缩放 -/百分比/+/适应画布、节点计数 countAlive）、画布 SVG 全屏。
- undo/redo 按钮与快捷键统一走 `undo(um)`/`redo(um)`。
- 所有写后统一 `capUndoStack(um)`（M1a 准入——封装在 `afterUserWrite()` helper）。

- [ ] **Step 1 E2E 失败测试**（editor.e2e.spec.ts，复用 M0 登录 helper + 新建文件进编辑器）：
  1. 打开种子文件「本周计划」→ root 文本可见、子节点渲染
  2. 选中 root 按 Tab → 新节点进入编辑态 → 键入「新节点」Enter → 画布出现；保存指示先「保存中…」后「已保存」
  3. 刷新页面 → 「新节点」仍在（持久化闭环）
  4. Ctrl+Z → 节点消失；Ctrl+Y → 回来
  5. 结构切换到组织架构图 → 边形态变化（断言 class/path kind 标记）→ Ctrl+Z 恢复
  6. 折叠子节点 → 「+N」徽标出现 → 再展开消失
- [ ] **Step 2** 跑失败 → **Step 3** 实现（本任务是装配任务，允许体量大但文件职责按上面拆分）→ **Step 4** 全部 gates + `pnpm --filter @gmind/web e2e`（M0 三用例不回归）→ **Step 5**
- [ ] **Step 5: Commit** `git add apps/web && git commit -m "feat(web): 编辑器页面——引擎装配/键盘映射/自动保存与状态指示/结构主题切换"`

---

### Task 12: 富内容 UI（备注/链接/图片/图标）

**Files:**
- Create: `apps/web/src/editor/RichPanel.tsx`（右侧面板：备注编辑/链接/图片上传/图标选择）
- Modify: `apps/web/src/pages/EditorPage.tsx`（选中节点变化时面板联动、右键菜单最小实现：插入子级/同级/删除/复制/粘贴/备注）
- Test: `apps/web/e2e/rich-content.e2e.spec.ts`

**Interfaces:**
- 面板分区：备注（textarea → setNote，5000 上限截断提示）、链接（input+保存 → setHref，非法值提示「链接仅支持 http/https」）、图片（file input → 前端读尺寸（Image 对象）→ POST /api/files/:id/images → setImage({key,w:≤200 等比,h})；>10MB 前端预检提示「图片大小超出 10MB 限制」）、图标（四组选择器 → setIcon；同组点选即替换）
- 右键菜单（画布 contextmenu 委托）：插入子级/同级、删除、复制、剪切、粘贴、备注、折叠——全部映射 core/engine API
- 备注角标 hover 预览（title 属性 M1b 从简：`title={note.slice(0,200)}`）
- [ ] **Step 1 E2E 失败**：选中节点 → 面板写备注保存 → 节点角标出现；设链接 https://example.com → 链接角标；上传 1×1 png → 图片渲染（`<image>` 元素存在）；图标组替换（flag 红→蓝仅剩蓝，与 progress 并存）；右键插入子级可用；刷新后富内容均在。
- [ ] **Step 2-5** 失败→实现→gates（web e2e 全绿）→ Commit `feat(web): 富内容面板——备注/链接/图片上传/图标与右键菜单（FR-EDT-018~021）`

---

### Task 13: 500 节点性能压测脚本（40fps）

**Files:**
- Create: `apps/web/e2e/perf-editor.spec.ts`（`test.describe.skip(!process.env.PERF)` 手动触发）, `docs/perf-m1.md`（结果记录）

**Interfaces:**
- 流程：登录 → API 建 500 节点文件（服务端测试辅助？**裁决：页面上下文内用 @gmind/core 直接构 doc + PUT doc-state**（vi­te 已 alias core）→ 打开编辑器 → rAF 采样：连续执行 60s 混合脚本（增删 50 节点、折叠/展开×20、缩放×20、拖拽×10）→ 统计中位 FPS 与每操作 P95 耗时（performance.now 包裹操作至下一帧）→ 断言中位 FPS ≥40 且操作 P95 <100ms → 写入 docs/perf-m1.md
- 非 CI 门（本地验证工具，文档注明「发布验收时在基准机重跑」——spec §6.1.1 验证方式）
- [ ] **Step 1** 写脚本 → 本地 `PERF=1 pnpm --filter @gmind/web exec playwright test perf-editor.spec.ts` 跑通并记录数字（若不达标：BLOCKED 报数据，禁改阈值）
- [ ] **Step 2: Commit** `test(web): 500 节点编辑器性能压测脚本与 M1 基线（NFR-PERF-001/003）`

---

### Task 14: M1 验收清单与全量回归

**Files:**
- Create: `docs/m1-acceptance.md`
- [ ] **Step 1** 按 PRD 第 3 章 P0 FR 逐条列表（FR-EDT-001~012/014/015/017~021/027~030/033/034），每条映射「E2E 用例名 / 手动核验步骤」并执行勾选；NFR-PERF-001/003 引用 Task 13 实测数据
- [ ] **Step 2** 全量回归 `pnpm lint && pnpm typecheck && pnpm test && pnpm --filter @gmind/server test:e2e && pnpm --filter @gmind/web e2e`
- [ ] **Step 3: Commit** `docs: M1 验收清单与实测结果`

## 里程碑边界（本计划不做）

实时协同/Awareness/离线（M2）、评论/分享/回收站（M3）、XMind 导入导出与版本（M4）、大纲视图/公式（三期）、小地图（P1 二期）、移动端（M5）、导出 PNG/JPG（M4）。
