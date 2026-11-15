# 导出返工批（轮 1 验收反馈）实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 修复导出 .xmind 在 XMind 8 打不开的缺陷；图片导出改按当前折叠态（剥交互折叠钮、保留 +N 徽标、删自动展开与确认框）；Excel 列宽自适应内容。

**Architecture:** XMind 修复=对照本机真实 Zen JSON 金样（张智建2025-08-01，creator Vana 24.01）补齐 sheet/topic `id`、rootTopic `structureClass`、`manifest.json`、metadata creator 对象形状——根因即缺 id（Zen 解析器 parseTopic 对 id 断言非空，报错栈 SheetDeserializer.parseTopic:231 null argument）。图片改造=快照克隆改走 docToState→docFromState 装载通道（保留 collapsed，core 零改动）＋SVG 剥 `.gm-collapse-toggle`（交互钮）保 `.gm-collapse-badge`（+N 徽标，engine 渲染层现成）＋删确认框。列宽=xlsx `<cols>` 按显示宽度（CJK×2）计算。

**Tech Stack:** 现有栈零新依赖；id 用 `crypto.randomUUID()`（测试经注入 idFactory 钉死确定性）。

**Spec:** 需求方 2026-11-15 三条验收反馈：①图片不带折叠按钮、展开按钮和数量要展示、按现有折叠状态导出不自动展开 ②CSV/Excel 列宽适应内容（不好做可不做）③导出 xmind 在 XMind 8 报 `SheetDeserializer.parseTopic null argument` 打不开。

## Global Constraints

- 不 commit（等验收指令）；不派发子代理（实现者）；只动本计划列出的文件。
- engine/core 只增不改：T2 不得改 packages/engine 任何文件（含注释——engine/src/export.ts:10 头注的「克隆展开」描述将过期，登记 features 文档说明，不改引擎）。
- XMind 往返兼容：parseXmind(本批产物) 必须仍绿（id/structureClass/manifest 对解析侧均为宽容键）；e2e 夹具 `buildXmind(sheets, extra)` 第二参开口行为不变。
- testid 契约：本批无新增/删除 testid（`export-jpg-{1,2,3}x` 等原样）。
- 门禁五件套收官：`pnpm lint && pnpm typecheck && pnpm test && pnpm --filter @gmind/server test:e2e && WEB_PORT=5174 API_ORIGIN=http://localhost:3001 pnpm --filter @gmind/web e2e`。

---

### Task 1: XMind 导出修复（id/structureClass/manifest/metadata）

**Files:**
- Modify: `packages/xmind-io/src/build.ts`（核心修复）
- Modify: `packages/xmind-io/src/build.test.ts`（金样改注入 idFactory + 新断言）
- Modify: `packages/xmind-io/src/roundtrip.test.ts`（往返+结构断言）

**Interfaces:**
- Produces: `buildXmind(sheets: XmindSheet[], extra?, idFactory?: () => string)`——第三参可选（缺省 `() => crypto.randomUUID()`），测试注入确定性工厂。调用方（xmind-export.ts/夹具）零改动。

- [ ] **Step 1: 失败测试先行**（build.test 追加）：
  - 注入 `const seq = (p:string)=>()=>`${p}-${++n}`` 的 idFactory，断言产物 content.json（JSON.parse）每层 topic 都有非空 `id`、sheet 有 `id`；
  - `structureType: 'logic'` 的 sheet → rootTopic.structureClass === `'org.xmind.ui.logic.right'`；`'mindmap'` → `'org.xmind.ui.map.unbalanced'`；`'org'` → `'org.xmind.ui.org-chart.balanced'`；无 structureType → 不产该键；
  - 结构类只出现在 rootTopic（子 topic 无 structureClass——解析侧 ：218 非根 structureClass 计 structureOverride 降级）；
  - zip 含 `manifest.json` 且 `JSON.parse` 后 `file-entries` 含 content.json/metadata.json；
  - metadata.json 为 `{"creator":{"name":"Gmind","version":"1.0"}}`。
  先跑确认红（现产物无 id/manifest）。
- [ ] **Step 2: build.ts 实现**：
  - `topic(n, path)` 内加 `id: idFactory()`；sheet 对象加 `id: idFactory()`；rootTopic 加 `...(s.structureType ? { structureClass: STRUCTURE_EXPORT_MAP[s.structureType] } : {})`，`STRUCTURE_EXPORT_MAP = { mindmap:'org.xmind.ui.map.unbalanced', logic:'org.xmind.ui.logic.right', org:'org.xmind.ui.org-chart.balanced' }`（金样实证前两值；org 值为 XMind 标准结构 id 且解析侧前缀匹配）；
  - zipSync 增加 `'manifest.json': strToU8('{"file-entries":{"content.json":{},"metadata.json":{}}}')`；metadata 改 `strToU8('{"creator":{"name":"Gmind","version":"1.0"}}')`；
  - 签名 `buildXmind(sheets, extra?, idFactory = () => crypto.randomUUID())`；头注补一段 v2.1 说明（id/结构/manifest 写回依据=2026-11-15 需求方 XMind 8 打不开反馈+本机金样对照）。
- [ ] **Step 3: 既有金样用例改注入 idFactory**（build.test 现有逐字节金样断言全部传确定性工厂，期望值更新——XmindSheet 类型若无 structureType 字段先在 types.ts 补可选字段——只增）；roundtrip.test 追加「build→parseXmind 往返层级不变（带 structureType 断言 structureType 还原）」。
- [ ] **Step 4: 验证**：`pnpm --filter @gmind/xmind-io test` 全绿；`pnpm --filter @gmind/xmind-io exec tsc --noEmit` 过。**待人工登记（T4 落 docs）**：导出件在需求方 XMind 8 实开验证。

### Task 2: 图片导出折叠态改造（保留折叠、剥交互钮、删确认框）

**Files:**
- Modify: `apps/web/src/editor/image-export.ts`（克隆通道+剥 toggle+头注）
- Modify: `apps/web/src/pages/EditorPage.tsx`（runImageExport 删确认框分支）
- Test: `apps/web/src/editor/image-export.test.ts`（追加 stripCollapseToggles 纯函数用例）

**Interfaces:**
- Consumes: `docToState`/`docFromState`（@gmind/core 既有，装载通道）。
- Produces: `stripCollapseToggles(svg: string): string`（命名导出，供 T4 e2e 语义参照；exportImage 内部在同一 DOMParser 遍历中与 inlineImages 串联）。

- [ ] **Step 1: 失败测试**：image-export.test.ts 追加——构造含 `<g class="gm-collapse-badge">…</g>` 与 `<g class="gm-collapse-toggle"><g class="gm-collapse-toggle-hit"/>…</g>` 的最小 SVG 字符串，断言 `stripCollapseToggles` 后 badge 保留、toggle 整组消失、其余节点原样（parse/serialize 往返）。先红后绿。
- [ ] **Step 2: 实现**：`stripCollapseToggles` 用 DOMParser 遍历删除所有 `g.gm-collapse-toggle`；`exportImage` 内 `cloneExpanded(doc, canvasId)` 改为 `docFromState(docToState(doc))`（快照独立于活文档，collapsed 原样保留；canvasId 参数语义不变——layout/render 对折叠节点按叶子布局并产 collapsedCount，渲染层 ：973 出 +N 徽标），`finally` 块改为销毁该克隆；SVG 处理链 = inlineImages → stripCollapseToggles（或同一 DOM 遍历完成两者）；头注改写（2026-11-15 需求方裁定：按当前折叠态导出、不自动展开；+N 徽标保留、交互折叠钮剥离）。
- [ ] **Step 3: EditorPage.tsx**：`runImageExport` 删除 `countCollapsedWithChildren` 计数与 `window.confirm` 分支（该函数其余调用点不动，先 grep 确认）；相关头注同步。
- [ ] **Step 4: 验证**：`pnpm --filter @gmind/web test`（含新用例）+ `tsc --noEmit` 过；`grep -n 'cloneExpanded' apps/web/src` 仅剩既有其他用途（若有）。
- [ ] **Step 5: 引擎不动核对**：`git diff --stat packages/engine` 为空。

### Task 3: Excel 列宽自适应

**Files:**
- Modify: `apps/web/src/editor/docExport.ts`（buildXlsxBytes 加 `<cols>`）
- Test: `apps/web/src/editor/docExport.test.ts`（追加用例）

**Interfaces:** 不变（buildXlsxBytes 签名不动，内部加列宽）。

- [ ] **Step 1: 失败测试**：rows 含中文长标题时 `sheet1.xml` 含 `<cols>` 与 `<col min="2" max="2" width="N" customWidth="1"/>`；宽度=列内最大显示宽（CJK/全角记 2、其余记 1）+2，且钳制上限 60、下限 8；短表（全 1 字符列）宽=8。
- [ ] **Step 2: 实现**：`buildXlsxBytes` 内按列扫描 rows 计算显示宽（`[...s]` 码点展开，CJK 区间 `⺀-鿿豈-﩯＀-￯` 记 2），`width = Math.min(60, Math.max(8, maxW + 2))`，sheet1.xml 在 `<sheetData>` 前产 `<cols>`（仅 7 列各一 col）。
- [ ] **Step 3: 验证**：`pnpm --filter @gmind/web test -- docExport` 全绿（既有 4 例不回归）。

### Task 4: e2e 更新 + 文档三件套 + 收官门禁

**Files:**
- Modify: `apps/web/e2e/import-export.e2e.spec.ts`（用例 5 重写）
- Modify: `docs/features/import-export.md`、`docs/m4-acceptance.md`、`docs/project-status.md`

- [ ] **Step 1: 用例 5 重写**：标题改「折叠态导出：不弹确认框、产物含折叠、画布折叠态不变」——折叠 root → export-jpg-1x → `dialogCount === 0`（**不再有 confirm**）→ 下载成功 `.jpg` → 画布徽标仍在/孙节点仍隐藏；删除「检测到 1 处折叠」断言。用例 4（无折叠）不变。
- [ ] **Step 2: 跑受影响 e2e**：`WEB_PORT=5174 API_ORIGIN=http://localhost:3001 pnpm --filter @gmind/web exec playwright test e2e/import-export.e2e.spec.ts e2e/share-export.e2e.spec.ts e2e/canvas-scope.e2e.spec.ts`（全绿；share-export 的 XMind 用例顺带背书新产物可被 parseXmind 解析）。
- [ ] **Step 3: 文档三件套（当日 grep 行号）**：
  - features/import-export.md：图片导出规则改口径（当前折叠态/不自动展开/+N 徽标保留/无交互折叠钮/无确认框——含「计数徽标=被隐藏存活后代数」引用 engine render 行号）；XMind 导出规则补（sheet/topic id、rootTopic structureClass 反向映射表、manifest.json、metadata creator——注明依据 2026-11-15 需求方 XMind 8 报错+本机真实 Zen 金样对照）；④ 登记引擎 export.ts:10 头注「克隆展开」描述已过期不改（engine 只增不改）。
  - m4-acceptance.md：追加「返工批（2026-11-15 验收反馈三条）」节——三条反馈、根因诊断（金样对照过程：缺 id→parseTopic 断言；王春龙文件 content.json CRC 损坏靠 XML 打开的旁证顺带登记）、测试数字。
  - project-status.md：待人工清单加「导出 .xmind 在需求方 XMind 8 实开冒烟（2026-11-15 返工批）」。
- [ ] **Step 4: 收官门禁五件套全绿**（数字如实带回，含 flaky 判定流程）。

## Self-Review

- 反馈覆盖：①T2 ②T3（CSV 无列宽概念——纯文本格式，交付汇报说明）③T1+T4 待人工 ③T1+T4 待人工 ✓
- 类型一致性：buildXmind 第三参 idFactory 仅 T1 内消费；stripCollapseToggles T2 产出、T4 e2e 不直接消费（语义经由用例 5 行为断言）✓；XmindSheet.structureType 若需补字段在 T1 内完成（types.ts 只增）✓
- 接缝：T1 改产物 → share-export/import-export XMind 用例在 T4 重跑背书；T2 删 confirm → 用例 5 在 T4 重写；互不越文件 ✓
