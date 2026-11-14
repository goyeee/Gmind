# XMind 导入保真度升级 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** XMind 导入修全（进度/表情/图标/图片/概要/超链接/样式/结构）＋降级提示逐项点名＋导出对称写回。

**Architecture:** 改动全部落 `packages/xmind-io`（本地镜像映射表+解析层）与 `apps/web/src/editor`（导入/导出胶水）。engine/gmind-core/server 三包零改动（设计文档 §八 已核实）。有图导入走「先建文件→传图→setImage→PUT doc-state」两段式，无图走现状单段快路径。

**Tech Stack:** TypeScript、fflate（仅 xmind-io 内）、vitest、Playwright。

**Spec:** `docs/superpowers/specs/2026-11-14-xmind-import-fidelity-design.md`（裁定记录、映射表全量、真实文件真值——实施者 T1/T2 开工前必读）。

## Global Constraints

- **禁止 `git commit` / `git push`**（AGENTS.md §二）：每个任务停在「验证绿」，提交等需求方指令。
- **需求方真实 .xmind 文件（`~/工作/个人项目/Gmind/` 下 5 份）绝不入库、绝不进测试夹具**；夹具一律程序化构造、标题中性。
- fflate 只允许出现在 `packages/xmind-io`（web 不直引，error-copy.e2e.spec.ts:24 注释先例）。
- xmind-io 与 @gmind/core 的目录映射保持「本地镜像 + 注释标注与 core 同步」模式（markers.ts 现行头注先例），xmind-io **不得**新增对 gmind/* 的依赖。
- engine / gmind-core / apps/server 三包零改动；任何任务若发现必须动这三包，停下上报，不得自行扩面。
- testid 契约不动；新增用户可见文案两段式（原因+下一步）。
- 映射表置信纪律：设计文档标注「不收」的 id 一律不入表（宁可少映射不可歪映射）。
- 每任务完成跑对应包测试；全量门禁五件套只在 T7 跑。

## Review Focus

1. **真实 XMind 8 文件（86 标记）只允许 2 个降级**（arrow-refresh、symbol-minus）→ T2 用合成等价 XML 夹具单测钉死计数；T7 用真实文件人工冒烟钉真值。
2. **新版 content.json 形状**：`markers:[{markerId}]` 数组、`children.summary[].title` + `summaries[].{topicId,range}` 两段式概要、`branch:"folded"` → T2 单测逐一钉死（解析错形状=静默丢失，正是本次要修的病根）。
3. **有图导入中途上传失败**（网络断/服务端 4xx）→ 导入不中断、该图计图片降级、文件可用 → T4 单测。
4. **概要 range 非法/越界、label 超 500** → 计概要降级、不崩、不建残缺概要 → T2（解析）+ T4（SUMMARY_INVALID 捕获）。
5. **往返稳定**：原生族导入→导出→导入 Gmind 值级集合不变；emoji/number 组导出**零虚增 marker-id** → T3 roundtrip 单测。

---

### Task 1: 标记双向映射表 v2（markers.ts）

**Files:**
- Modify: `packages/xmind-io/src/markers.ts`
- Create: `packages/xmind-io/src/markers.test.ts`
- Test: `packages/xmind-io/src/markers.test.ts`

**Interfaces:**
- Consumes: 现有 `markersToIcons(ids): {icons: XmindIcons; dropped: number}` 与 `iconsToMarkerIds(icons): string[]` 签名不变；`XmindIcons`（types.ts）形状不变。
- Produces: 同名两函数 v2 行为（映射表见 spec §三，置信级逐行照抄）；`dropped` 语义=未映射/被吞 id 数（T2 消费，落 DegradedItem icon）。头注更新：推翻「emoji 组不从 XMind 导入」段落，改述 smiley 族入表口径与日期。

- [ ] **Step 1: 写失败测试**（TDD）——`markers.test.ts` 按 spec §三逐行断言：
  - 导入：进度九档（task-start→none、task-oct→p12、task-quar→p25、task-3oct→p37、task-half→p50、task-5oct→p62、task-3quar→p75、task-7oct→p87、task-done→done）；smiley-smile/sad/cry→mood 同名、smiley-laugh→mood.smile；people-orange→other.person；symbol-plus/question/wrong/right/idea→other.plus/question/cancel/done/idea；c_symbol_like→other.like；arrow-up/down/left/right→arrow 同名；既有 priority-1..9 / flag-red / star-red 不回归。
  - 丢弃：arrow-refresh、symbol-minus、'week-1'、'month-01'、'c_number_1'、空串、非字符串 → dropped 计数。
  - 单选组吞噬：同节点 task-done+task-half → progress=[done]、dropped+1；multi 组 other.like+other.question 并存。
  - 导出：progress 九档→task-*（none→不产出）；mood.smile→smiley-laugh（sad/cry/love/kiss 不产出）；other.like/question/plus/cancel/done/idea→symbol 族/c_symbol_like；other.person→people-orange；arrow.up→arrow-up（leftright 不产出）；emoji/number 组与其余 other slug → 空输出；既有 priority/flag/important 不回归。
  - 往返：smiley-laugh→mood.smile→smiley-laugh 恒等；c_symbol_like→like→c_symbol_like 恒等。
- [ ] **Step 2: 跑测试确认失败**：`pnpm --filter @gmind/xmind-io test`，预期 markers 相关断言 FAIL。
- [ ] **Step 3: 实现 v2**——markers.ts 重写 `markersToIcons`/`iconsToMarkerIds`：精确表 `MARKER_IMPORT_MAP: Record<string,{group;value}>`（spec §3.1 逐行）+ 保留既有 priority-N regex 与 flag-*/star-* 前缀分支；单选组 first-wins 计 dropped 逻辑沿用；新增单选组 mood/arrow/progress 的 first-wins；导出按 spec §3.2 新增 PROGRESS/MOOD/OTHER/ARROW/PERSON 五张镜像表。头注按 Global Constraints 镜像注释模式重写。
- [ ] **Step 4: 跑测试确认通过**：`pnpm --filter @gmind/xmind-io test` 全绿。
- [ ] **Step 5: 停在验证绿**，汇报改动摘要（不 commit）。

### Task 2: 解析层 v2——命名制降级＋全字段提取

**Files:**
- Modify: `packages/xmind-io/src/types.ts`、`parse-json.ts`、`parse-xml.ts`、`index.ts`
- Test: `packages/xmind-io/src/parse.test.ts`（扩展）

**Interfaces:**
- Consumes: Task 1 的 `markersToIcons`（dropped→icon 计数）。
- Produces（types.ts，T4/T5/T6 消费）:
  - `export type DegradedKey = 'icon'|'label'|'styleProp'|'theme'|'image'|'attachment'|'noteImage'|'link'|'callout'|'boundary'|'floating'|'taskInfo'|'structureOverride'|'summary'|'sheet'`
  - `export interface DegradedItem { key: DegradedKey; count: number }`
  - `export const DEGRADED_LABELS: Record<DegradedKey, string>`（键序=目录序：图标/标签/样式属性/画布主题/图片/附件/备注图片/超链接/标注/外框/漂浮主题/任务信息/结构覆盖/概要/空画布）
  - `XmindNode` 增 `href?: string; image?: {path: string; w?: number; h?: number; align?: 'top'|'bottom'|'left'|'right'}; summaries?: {start: number; end: number; label: string}[]; style?: Record<string,string>; folded?: boolean`（既有字段一律不动）
  - parseXmind 返回值增 `resources: Record<string, {bytes: Uint8Array; mime: string}>`（additive，旧消费方零破坏）
  - 降级返回从三类计数改 `DegradedItem[]`（**web 胶水 T4 同步适配，属预期 breaking**）

- [ ] **Step 1: 写失败测试**（parse.test.ts 扩展，JSON/XML 双路径全覆盖）：
  - markers：XML `<marker-ref marker-id>` 与 JSON `markers:[{markerId}]` 双形状→icons 落位（task-done→done、symbol-idea→idea、task-half→p50）；未映射 id→DegradedItem icon。
  - 概要：XML `<summary range="(0,2)" topic-id>` + detached label；JSON `children.summary[].title` + `summaries[].{topicId,range}`；`(0,0)` 单点、`(0,2)` 区间；range 非法（"abc"、"(2,1)"、越界）→计 summary 不产条目；被消费 detached 豁免 floating（豁免者子树不下钻）。
  - 图片：XML `xhtml:src="xap:resources/x.png"` 与 JSON `image.src`；resources 返回字节+mime（png 魔数）；zip 缺键→计 image；非白名单字节（魔数不符）→计 image；多图取首张余者计 image；zip 目录项跳过；w/h float 取整。
  - href：JSON `href` 与 XML `xlink:href`——http/https 透传；`xapp:…`/相对路径→计 link。
  - 样式：JSON style.properties 四键映射；`fo:font-size:"14px"`→"14"；非法值→计 styleProp；不支持键逐键计 styleProp；XML style-id→styles.xml 间接表（styles.xml 在 zip）；缺表→逐个计。
  - 结构：根 structure-class logic.right/map.unbalanced/org-chart→logic/mindmap/org；非根→计 structureOverride；XML sheet theme **属性**与子元素都计 theme；legend 忽略。
  - folded：JSON `branch:"folded"`→folded:true；无键→undefined。
  - callout/boundary/task-info/labels/attachments/备注 img→各自计数。
  - 损坏 zip/无 content 条目→既有 UNSUPPORTED_FORMAT 行为不回归。
- [ ] **Step 2: 跑测试确认失败**：`pnpm --filter @gmind/xmind-io test`。
- [ ] **Step 3: 实现**——types.ts 契约（上述 Produces）；index.ts parseXmind：跳过目录条目、收集 resources（魔数嗅探 png `\x89PNG`/jpg `\xFF\xD8\xFF`/gif `GIF8`/webp `RIFF..WEBP`，白名单外不入表）、预解析 styles.xml（存在时）传给 parse-xml；parse-json/parse-xml 按 spec §四规则实现（DetachedCollector 改造为命名制、detached 豁免集由概要/外框引用先行收集）。形状真值以 spec §二为准（`markerId`、`topicId`、`children.summary`、`branch:"folded"`、sheet theme 属性）。
- [ ] **Step 4: 跑测试确认通过**：`pnpm --filter @gmind/xmind-io test` 全绿（含 Task 1 测试不回归）。
- [ ] **Step 5: 停在验证绿**，汇报（不 commit）。

### Task 3: 导出写回 v2（build.ts + roundtrip）

**Files:**
- Modify: `packages/xmind-io/src/build.ts`、`types.ts`（build 输入类型如需 href/style）
- Test: `packages/xmind-io/src/build.test.ts`、`packages/xmind-io/src/roundtrip.test.ts`

**Interfaces:**
- Consumes: Task 1 `iconsToMarkerIds` v2；Task 2 types。
- Produces: `buildXmind(sheets, extra?: Record<string, Uint8Array>): Uint8Array`——第二参合入 zip（键原样，如 `resources/pic.png`；**仅为测试夹具开口**，导出自身调用不传）；build 输入 topic 支持 `href?: string`、`style?: Record<string,string>`（有值键才产出 `style:{properties:{…}}`，fontSize 产 `"<n>px"`）。

- [ ] **Step 1: 写失败测试**：build.test.ts——topic 带 href/style 产出对应 content.json 键；无值不产键；fontSize 带 px；extra 参数合入 zip 条目且不传时产物与现状逐字节一致。roundtrip.test.ts——「导入（含原生族标记/样式/href）→导出→再导入」Gmind icons 值级集合稳定；emoji/number 组节点导出产物 markers 数组不含任何虚增 id。
- [ ] **Step 2: 跑测试确认失败**。
- [ ] **Step 3: 实现**——build.ts topic() 写 href/style；`zipSync` 载荷合并 extra。
- [ ] **Step 4: 跑测试确认通过**：`pnpm --filter @gmind/xmind-io test` 全绿。
- [ ] **Step 5: 停在验证绿**，汇报（不 commit）。

### Task 4: web 导入胶水两段式＋降级 v2 文案

**Files:**
- Modify: `apps/web/src/editor/xmind-import.ts`、`apps/web/src/pages/WorkspacePage.tsx`（importXmind 与 toast，:655-664 一带）
- Test: `apps/web/src/editor/xmind-import.test.ts`（扩展/重写受影响用例）

**Interfaces:**
- Consumes: Task 2 全部契约（DegradedItem/DEGRADED_LABELS/resources/XmindNode 新字段）；gmind-core 现有 setDescription/setHref/setStyle/setSummary/setDocMeta/setCollapsed/setImage（签名见 spec §八，先读源码核实再调用）。
- Produces:
  - `export interface ImportDeps { createFile: (title: string, docStateB64: string) => Promise<{id: string}>; uploadImage: (fileId: string, file: File) => Promise<{key: string; w: number; h: number}>; putDocState: (fileId: string, docStateB64: string) => Promise<void> }`（实施者先读 `apps/web/src/editor/imageUpload.ts` 的 uploadImage/readImageSize/clampImageSize 真实签名，deps 类型与之对齐、**复用不复制**）
  - `importXmindFile(file: File, deps: ImportDeps): Promise<{title: string; fileId: string | null; state: string; degraded: DegradedItem[]}>`——fileId=null 表示快路径（无图），调用方照旧 POST /files；fileId 非 null 表示两段式已建文件已回写 doc-state，调用方跳过 POST。
  - `degradedSummary(degraded: DegradedItem[]): string`——全零「已完整导入」；否则「未导入：」+ DEGRADED_LABELS 目录序非零项「、」连接。
  - WorkspacePage：deps 注入真实 api（apiPost/apiPut/uploadImage）；toast **恒弹**；快/慢路径按 fileId 分流。

- [ ] **Step 1: 写失败测试**：
  - degradedSummary 全文案矩阵：全零、单项、多项目录序、未知 key 容错。
  - 快路径：resources 空→uploadImage/putDocState 不被调、createFile 不被调（返回 fileId=null）。
  - 两段式：有 1 图→createFile→uploadImage→setImage→putDocState 调用时序（mock 断言顺序）；setImage 参数 {key,w,h,placement:align??'bottom'}；uploadImage 拒绝（throw）→degraded 含 image、导入继续返回可用 docState；10MB 超限→不发起 uploadImage 直接计 image。
  - 落盘：docFromState 回读断言 setDescription/setHref/setStyle/setSummary/setCollapsed(folded)/structureType（首画布 setDocMeta、次画布 addCanvas）真实生效；概要 label 超长抛 SUMMARY_INVALID→计 summary 且 doc 无残缺条目。
  - origin 修正：addChild/setText/… 的 origin 参数为 'system'、canvasId 归位（spy 形参位断言）。
  - 既有 12 用例适配新签名后语义不回归。
- [ ] **Step 2: 跑测试确认失败**：`pnpm --filter @gmind/web test`（按仓库实际单测命令，实施者先查 apps/web package.json scripts）。
- [ ] **Step 3: 实现**——xmind-import.ts 重构（walk 携带节点 id；两段式；ORIGIN='system' 常量）；WorkspacePage 接线。
- [ ] **Step 4: 跑测试确认通过** + `pnpm --filter @gmind/xmind-io test`（契约对齐不回归）。
- [ ] **Step 5: 停在验证绿**，汇报（不 commit）。

### Task 5: web 导出胶水

**Files:**
- Modify: `apps/web/src/editor/xmind-export.ts`
- Test: `apps/web/src/editor/xmind-export.test.ts`

**Interfaces:**
- Consumes: Task 3 build 输入类型（href/style）；docToXmindTree 现有签名不变，`exportXmind` 与 EditorPage.tsx:4400-4408、ShareDialog :5168-5174 调用点零改动。
- Produces: docToXmindTree walk 输出补 `href`（snap.href 非 http(s) 不产——与导入口径对称）与 `style`（fill/border/color/fontSize 非空才产；先读 gmind-core read.ts NodeSnapshot.style 确认键名）。

- [ ] **Step 1: 写失败测试**：带 href/style 的 doc→树含对应键；无则不产键；fontSize 数值化；icons 全组透传不过滤（过滤在 iconsToMarkerIds）。
- [ ] **Step 2: 跑测试确认失败**。
- [ ] **Step 3: 实现**（预计 ~40 行）。
- [ ] **Step 4: 跑测试确认通过**：`pnpm --filter @gmind/web test` 全绿。
- [ ] **Step 5: 停在验证绿**，汇报（不 commit）。

### Task 6: e2e 合成夹具＋导入导出用例扩展

**Files:**
- Create: `apps/web/e2e/helpers/xmind-fixture.ts`（合成 .xmind 构造器：经 `@gmind/xmind-io` 的 buildXmind extra 参数内嵌 4×4 PNG 字节常量；中性标题；含 progress/mood/other/arrow 族标记、1 概要、1 href、fill/color/fontSize 样式、structure-class logic.right）
- Modify: `apps/web/e2e/import-export.e2e.spec.ts`、必要时 `apps/web/e2e/error-copy.e2e.spec.ts:106-126`
- Test: 同上

**Interfaces:**
- Consumes: Task 3 buildXmind extra；Task 4 导入行为；既有 e2e 登录 helper（`apps/web/e2e/helpers/auth.ts`）。
- Produces: 夹具构造器 `buildFixtureXmind(): Buffer`（导出给 spec 用）。

- [ ] **Step 1: 写失败用例**（import-export.e2e.spec.ts 追加，不改动既有用例除非文案断言必须同步）：
  - 导入夹具→画布断言：进度徽章可见（`.gm-marker-badge` title 含「进度」字样目录 label）、mood/other/arrow 徽章数、`.gm-image` 可见且 `data-image-placement` 正确、`.gm-summary-label` 文本、`.gm-link-badge` 可见、节点 style 抽查（fill）、logic 布局（画布结构切换控件状态或节点横坐标全在根右侧）。
  - toast 文案：夹具含 1 个陌生标记→「未导入：图标 1」逐项点名；纯净水树→「已完整导入」。
  - 往返：导入产物经导出菜单导出→下载文件 parse 断言（node 端 jszip 换 xmind-io parseXmind——在 spec 进程内 import @gmind/xmind-io）marker 集合值级稳定。
- [ ] **Step 2: 跑用例确认失败**：`pnpm --filter @gmind/web exec playwright test e2e/import-export.e2e.spec.ts`（先起 `PORT=3001 pnpm --filter @gmind/server dev`，`WEB_PORT=5174 API_ORIGIN=http://localhost:3001`）。
- [ ] **Step 3: 实现**（夹具+断言修补）。
- [ ] **Step 4: 跑用例确认通过**＋error-copy.e2e.spec.ts 全绿（归因文案未动则零改动）。
- [ ] **Step 5: 停在验证绿**，汇报（不 commit）。

### Task 7: 文档同步＋门禁＋真实文件人工冒烟

**Files:**
- Modify: `docs/m4-acceptance.md`（当日补记：自动化用例名+行号当日 grep，禁止转抄）、`docs/project-status.md` §三（两裁定推翻：M4 图片不提取、M7b emoji 不导入；注日期 2026-11-14；**该文件有需求方未提交改动，只追加不覆写**）、`README.md`（进度行追加一句；**同样只追加**）
- Create: `docs/features/import-export.md`（AGENTS.md §四 五栏目：是什么/规则逐条带 file:line 当日读码/特殊情况/待需求方确认/最后核对；残余损失清单如实登记）

**Interfaces:**
- Consumes: T1-T6 全部落地代码（file:line 当日 grep）。
- Produces: 文档与代码一致的真相源。

- [ ] **Step 1: 跑门禁五件套**全绿：`pnpm lint && pnpm typecheck && pnpm test && pnpm --filter @gmind/server test:e2e && WEB_PORT=5174 API_ORIGIN=http://localhost:3001 pnpm --filter @gmind/web e2e`（server 需在 3001 运行；基础设施 `pnpm compose:up`）。
- [ ] **Step 2: 真实文件人工冒烟**（不入库）：dev 服务起后经 UI 重导入 `吾盛待办10.27.xmind`——核对：toast「未导入：图标 2」；46 进度落位（done 36/p75 5/p12 4/p87 1）；c_symbol_like 28、symbol 族 7、smiley-laugh、people-orange、star-red、arrow-up 落位；图片挂节点下方；38 概要可见；两画布 logic 布局；「商城端」子树结构覆盖计入提示（与图标合计）。截图/记录进 m4-acceptance 手动项。
- [ ] **Step 3: 文档同步**（m4-acceptance、project-status §三、docs/features/import-export.md、README 追加）。
- [ ] **Step 4: 停在验证绿**，汇报全套改动清单（不 commit，等需求方指令）。
