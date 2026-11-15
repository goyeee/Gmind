# 导出保真第三波（图片写回 + XMind 主题质感）实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task.

**Goal:** 导出 .xmind 携带节点图片（resources/ 打包+manifest 登记）与 XMind 默认主题（圆角连接线 roundedElbow 等，消除「直愣愣」直线观感），导出链异步化。

**Architecture:** theme/image 形状全部取自本机真实 Zen 金样（张智建总结计划 2025-08-01，creator Vana 24.01）逐字借用——theme=`{mainTopic,subTopic,…}` 每层 `{id,properties}`，关键键 `line-class:'org.xmind.branchConnection.roundedElbow'`；图片=`topic.image {src:'xap:resources/<名>',width,height,align}` + zip `resources/<名>` + manifest 登记（顺带清偿轮 1 ④16「manifest 不登记 extra」）。web 导出链：exportXmind 异步化（fetch /api/images/{key}，同 key 去重，失败跳过计数）。

**Tech Stack:** 现有栈零新依赖；fetch 同源公开 GET（image-export inlineImages 先例）。

**Spec:** 需求方 2026-11-15 验收反馈：「新导出的 Gmind问题汇总 (2).xmind 可以打开（XMind 8 修复验证通过），但图片没导出来」「样式有点丑…分支的连接线都是直愣愣的，和 xmind 软件创建的不一样」。M4 挂账「图片导出不写回」就此清偿；概要/folded 写回仍挂账不动。

## Global Constraints

- 不 commit；不派子代理（实现者）；engine/core/xmind-io 既有函数只增不改。
- buildXmind 签名保持 `(sheets, extra?, idFactory?)` 同步不变（异步只在 web 侧）。
- theme 值逐字取金样，**不自己造任何样式值**；id 用金样字面 UUID（主题内部 id 跨文件无唯一性要求）。
- 图片失败不中断导出：单图 fetch 失败→该节点跳过图片+计数，其余照常。
- align 一一映射：Gmind placement top/bottom/left/right ↔ XMind image.align（IMG_ALIGNS 同值集，parse-json.ts:63）。
- 门禁五件套收官（T3）。

---

### Task 1: build 层 theme + 图片写回 + manifest 登记 extra

**Files:**
- Modify: `packages/xmind-io/src/build.ts`（DEFAULT_THEME 常量+sheet theme+topic.image+manifest）
- Modify: `packages/xmind-io/src/build.test.ts`、`packages/xmind-io/src/roundtrip.test.ts`（金样/新断言）

**Interfaces:**
- Produces: 产物 content.json 每 sheet 带 `theme`（含 mainTopic/subTopic `line-class`）与 topic 级 `image {src,width,height,align}`；manifest `file-entries` 登记 extra 全部键。签名不变。

- [ ] **Step 1: 失败测试**（build.test 追加，注入 idFactory）：①产物每 sheet 有 `theme.mainTopic.properties['line-class']==='org.xmind.branchConnection.roundedElbow'` 与 subTopic 同值 ②XmindNode 带 `image:{path:'p.png',w:100,h:50,align:'top'}` 时 topic.image === `{src:'xap:resources/p.png',width:100,height:50,align:'top'}`（w/h/align 缺省不产键）③extra 传 `{'resources/a.png':bytes}` 时 manifest file-entries 含 `resources/a.png`。先跑红。
- [ ] **Step 2: 实现**：DEFAULT_THEME 常量（十二层全部从金样逐字抄录——centralTopic/mainTopic/subTopic/summaryTopic/calloutTopic/floatingTopic/boundary/summary/relationship/map/importantTopic/minorTopic，值即金样 properties 全文，含 map 层 multi-line-colors/color-list）；sheet 对象加 `theme: DEFAULT_THEME`；topic() 内加 image 三键展开；manifest 改 `JSON.stringify({'file-entries':{'content.json':{},'metadata.json':{},...Object.fromEntries(Object.keys(extra ?? {}).map((k)=>[k,{}]))}})`；头注 v2.3 段（依据=2026-11-15 需求方「图片没导出来/连接线直愣愣」反馈+金样对照）。
- [ ] **Step 3: 金样用例更新**（期望字节加 theme/manifest 变化）+ roundtrip 补「build(带 image)→parseXmind 还原 image{path,w,h,align}」断言（roundtrip 已有 unzip 通道）。
- [ ] **Step 4: 验证**：`pnpm --filter @gmind/xmind-io test` 全绿 + tsc。

### Task 2: web 导出链异步化 + 图片抓取打包

**Files:**
- Modify: `apps/web/src/editor/xmind-export.ts`（walk 收集图片任务→fetch→extra+node.image）
- Modify: `apps/web/src/pages/EditorPage.tsx`、`apps/web/src/editor/ShareDialog.tsx`（异步调用点适配）
- Test: `apps/web/src/editor/xmind-export.test.ts`（mock fetch 用例）

**Interfaces:**
- Produces: `exportXmind(doc, title): Promise<{missingImages: number}>`（原 void）；`docToXmindTree` 增第二返回值或挂载 image（实现者定，保持既有调用 docToXmindSheets 兼容）。

- [ ] **Step 1: 失败测试**（vi.stubGlobal mock fetch）：①带 image 节点（key='files/f1/x.png',w=200,h=100,placement='top'）→ exportXmind 产物 zip 含 `resources/x.png` 且字节=mock 字节、topic.image.src='xap:resources/x.png'、manifest 登记之 ②同 key 两节点→resources 仅一份 ③fetch reject→该节点无 image+missingImages=1+其余导出正常 ④无图文档 missingImages=0。先红后绿。
- [ ] **Step 2: 实现**：docToXmindTree walk 内读 `snap.image`（core 快照 {key,w,h,placement}）收集 `imageTasks[{nodeRef,key,w,h,placement}]`；exportXmind 改 async：逐唯一 key fetch `/api/images/${key}`（res.ok 校验+arrayBuffer→Uint8Array；失败计 missingImages 跳过）→资源名 `resources/${key.split('/').pop()}`→`node.image={path:名,w,h,align:placement}`→`buildXmind(sheets,{[名]:bytes,…})`→返回 {missingImages}；头注更新（图片写回 2026-11-15 需求方反馈，M4 挂账清偿）。
- [ ] **Step 3: 调用点适配**：EditorPage 工具栏 export-xmind 分支与 ShareDialog onExport('xmind') 走的同一闭包——`exportXmind(...).then(r=>{if(r.missingImages>0) showToast(`${r.missingImages} 张图片未能包含在导出中`)})`，catch 既有错误 toast 保留；ShareDialog 的 runExport 已 async 兼容。
- [ ] **Step 4: 验证**：web test 全绿+tsc+eslint 三文件；`pnpm --filter @gmind/xmind-io test` 零回归。

### Task 3: e2e + 文档 + README + 门禁收官

**Files:**
- Modify: `apps/web/e2e/share-export.e2e.spec.ts`（XMind 用例补 theme/manifest 断言；如可行补图片资源断言）
- Modify: `docs/features/import-export.md`、`docs/m4-acceptance.md`、`docs/project-status.md`、`README.md`

- [ ] **Step 1: e2e**：share-export XMind 用例追加——unzipEntries(bytes) 后 content.json 断言 `theme.subTopic.properties['line-class']`、manifest file-entries 含 content.json；图片断言：若种子文档无图则用导入夹具链路造带图文档后导出断言 resources/（实现者按夹具现状选最短路径，如实记录）。跑受影响 e2e 全绿。
- [ ] **Step 2: 文档**：features 规则 15 扩（theme 注入/图片写回链路/manifest 登记 extra——M4 挂账清偿注记）、m4 §十三补记（两条反馈：图片缺失=挂账清偿、线条=theme 缺失根因+金样 theme 借用口径）、project-status（待人工更新：XMind 8 查曲线与图片；§三指针行）、README 进度行补「2026-11-15 追加」（XMind 导出保真+主题/图片写回——整批收口口径）。
- [ ] **Step 3: 收官门禁五件套全绿**（数字如实带回；flaky 判定流程照旧）。

## Self-Review

- 反馈覆盖：图片缺失→T1+T2（M4 挂账清偿）；线条直愣愣→T1 theme（roundedElbow=金样实证的 XMind 软件质感来源）✓
- 类型一致：XmindNode.image 已存在 {path,w,h,align}（types.ts:40）复用不新造 ✓；buildXmind 签名不变 ✓；exportXmind 返回类型变更在 T2 内完成调用点同步 ✓
- 接缝：T1 产物变化→T2/T3 e2e 重跑背书；夹具 xmind-fixture 走 buildXmind+extra——manifest 新登记 extra 条目改变夹具 zip 形状（多一个 manifest.json），导入侧不读 manifest 无害，T3 顺带核对夹具行为 ✓
