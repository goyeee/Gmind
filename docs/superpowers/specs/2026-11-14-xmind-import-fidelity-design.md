# XMind 导入保真度升级 — 设计文档（2026-11-14）

> 需求方拍板记录 + 映射表全量 + 真实文件真值。实施计划在 `docs/superpowers/plans/2026-11-14-xmind-import-fidelity.md`。

## 一、需求方裁定（2026-11-14，全部已拍板）

1. **范围 = 导入修全＋样式映射＋导出对称**。起因：真实文件 `吾盛待办10.27.xmind` 导入后提示「已降级处理 xx 项」，图片/表情/图标/进度全没进；探查证明进度九档与 XMind 八档设计上同构（core constants.ts「XMind 进度八档同构」注释），纯映射缺失。
2. **对不上的图标：丢弃＋如实计入提示**（不塞文字 emoji、不硬映射歪语义）。本文件受影响仅 arrow-refresh、symbol-minus 2 个。
3. **降级提示改逐项点名**：「未导入：图标 2、外框 1」（按固定目录序，仅列非零项）；全零提示「已完整导入」，toast 恒弹。
4. **推翻两个旧裁定**（记入 project-status §三，注日期 2026-11-14）：
   - M4「.xmind 内嵌图片不提取、按 media 降级计数」（docs/m4-acceptance.md）→ 图片提取入库（uploadImage→setImage）。
   - M7b「emoji 组不从 XMind 导入」（xmind-io markers.ts 头注）→ 落点 = smiley 族映射 mood 组入内；emoji unicode 组（28 字符）仍无 XMind 原生源，导入不产出、导出不写回。

## 二、真实文件真值（需求方本机文件，2026-11-14 实测；业务隐私，禁止入库/进夹具）

| 文件 | 格式 | 标记 | 图片 | 概要 | 结构 | 其他 |
| --- | --- | --- | --- | --- | --- | --- |
| 吾盛待办10.27.xmind | content.xml（XMind 8） | 86 个（见下） | 1（512KB PNG 188×348 align bottom） | 38 | 两画布根 `org.xmind.ui.logic.right`＋非根 1（商城端） | legend×2（忽略）；sheet theme 是**属性** |
| 农千问待办10.27.xmind | content.json（2020+） | `markers:[{markerId}]` 数组形状：task-done/task-half/symbol-idea/symbol-right/c_symbol_like | 4（`image:{src:"xap:resources/…png",width:79.9(float),height:178,align:"right"/"left"/"bottom"}`） | 44（两段式：标签文本在 `children.summary:[{id,title}]`，父节点 `summaries:[{id,topicId,range:"(6,6)"}]` 引用） | rootTopic `structureClass` | `branch:"folded"` 折叠态；sheet 含 legend/theme/style 键 |
| 吾盛待办-2026.11.06.xmind | content.json | 同上形状 | 1 | 21 | — | — |
| 国机培训 2026-10-30.xmind | content.json | 同上形状 | 18 | 12 | — | — |
| Gmind问题汇总.xmind | content.xml | 无 | 0 | 0 | `org.xmind.ui.map.unbalanced` | — |

XML 实测 marker id 全集：task-done×36、task-3quar×5、task-oct×4、task-7oct×1、c_symbol_like×28（**下划线**）、symbol-plus×1、symbol-question×2、symbol-wrong×1、symbol-minus×1、symbol-right×2、smiley-laugh×1、people-orange×1、star-red×1、arrow-up×1、arrow-refresh×1。JSON 新增实测：task-half、symbol-idea。

XML 其他真值：图片元素 `<img align="bottom" svg:width="188" svg:height="348" xhtml:src="xap:resources/<uuid>.png">`；概要 `<summary range="(s,e)" topic-id="…"/>`，label 文本在被 topic-id 引用的 **detached topic** 上；zip 媒体在 `resources/<uuid>.png`（注意 zip 里有 `resources/` 目录条目，扫描时跳过目录项）。

## 三、双向标记映射表（单源落 `packages/xmind-io/src/markers.ts`，本地镜像注释「与 core 同步」）

置信级说明：**实测** = 真实文件见过该 id；**推断** = 同族命名规律补全（XMind 8 进度族 8 档中 5 档已实测，规律 task-oct/quar/3oct/half/5oct/3quar/7oct/done 内洽）；**不收** = 无法核实，宁可少映射不可歪映射（需求方裁定 2）。

### 3.1 导入方向 markersToIcons v2：XMind marker-id → Gmind 组.值

| XMind id | → | 置信 | 备注 |
| --- | --- | --- | --- |
| priority-1..9（regex） | priority 九档（PRIORITY_LEGACY_MAP 镜像，8/9 clamp） | 既有 | |
| flag-*（前缀） | flag.flag | 既有 | 颜色/形状丢 |
| star-*（前缀） | other.important | 既有 | 颜色丢（橙星） |
| task-start / task-oct / task-quar / task-3oct / task-half / task-5oct / task-3quar / task-7oct / task-done | progress.none/p12/p25/p37/p50/p62/p75/p87/done | start=推断，其余 5 实测+3 推断 | setIcon 进度组写入自动联动 task.progress；task-start 若后续证伪删行即可 |
| smiley-smile → mood.smile；smiley-sad → mood.sad；smiley-cry → mood.cry | mood | 推断 | |
| smiley-laugh → mood.smile | mood | 实测 | **形近映射（大笑→微笑），agent 决定，需求方可否决改丢弃** |
| people-red/orange/yellow/green/blue/purple（前缀 `people-` 亦可） | other.person | orange 实测，余推断 | 全族语义同一（人），前缀匹配无歪语义风险；颜色丢（蓝人） |
| symbol-plus / symbol-question / symbol-wrong / symbol-right / symbol-idea | other.plus/question/cancel/done/idea | 实测 | |
| c_symbol_like（精确，下划线） | other.like | 实测 | |
| arrow-up / arrow-down / arrow-left / arrow-right | arrow.up/down/left/right | up 实测，余推断 | 颜色丢（蓝） |
| arrow-refresh、symbol-minus 及一切陌生族（week-*/month-*/c_number-*…） | 丢弃→图标计数 | — | 需求方点名 |
| emoji 组、number 组 | 恒不产出 | — | 无原生源（裁定 4 落地形态） |

单选组（priority/flag/progress/mood/arrow）重复「首个胜、后续计丢弃」（现行规则）；other 组 multi 并存（上限 8 由 setIcon 拒绝→捕获计图标）。**smiley-love/smiley-kiss 不收**（无法核实拼写）。

### 3.2 导出方向 iconsToMarkerIds v2：Gmind 组值 → XMind marker-id

原则不变：**不造 XMind 不存在的 marker-id**。只写 3.1 表中「实测或推断」id 的逆映射：

| Gmind | → XMind id | 备注 |
| --- | --- | --- |
| priority 9 档 | priority-N（现行 PRIORITY_EXPORT） | 既有 |
| flag 3 值 | flag-red | 既有；形状丢 |
| other.important | star-red | 既有 |
| progress p12/p25/p37/p50/p62/p75/p87/done | task-oct/quar/3oct/half/5oct/3quar/7oct/done | none→**不写**（task-start 未实测） |
| mood.smile | smiley-laugh | 实测 id，形近逆映射；sad/cry/love/kiss→不写 |
| other.like/question/plus/cancel/done/idea | c_symbol_like/symbol-question/symbol-plus/symbol-wrong/symbol-right/symbol-idea | 实测 |
| other.person | people-orange | 实测 id 作代表 |
| arrow.up/down/left/right | arrow-up/down/left/right | 推断对称 |
| emoji 28 / number 10 / other 其余 slug | **不写** | 登记往返残余 |

roundtrip 口径：原生族「导入→导出→导入」**Gmind 值级集合稳定**（marker-id 层允许形近改写，如 smiley-laugh→smile→smiley-laugh 恒稳定）。

## 四、解析层 v2（`packages/xmind-io`）

- **契约**：`XmindNode` 增 `href?` / `image?:{path,w?,h?,align?}` / `summaries?:{start,end,label}[]` / `style?:Record<'fill'|'border'|'color'|'fontSize',string>` / `folded?`；`ParseResult` 增 `resources:Record<path,{bytes:Uint8Array,mime}>`；降级计数三类改**命名条目制** `DegradedItem={key,count}`，目录与标签（DEGRADED_LABELS 导出）：图标 icon/标签 label/样式属性 styleProp/画布主题 theme/图片 image/附件 attachment/备注图片 noteImage/超链接 link/标注 callout/外框 boundary/漂浮主题 floating/任务信息 taskInfo/结构覆盖 structureOverride/概要 summary/空画布 sheet。
- **图片**：JSON `image.src` 剥 `xap:`；XML `<img>` 属性按 xhtml:src→src→xlink:href→href 兜底，`align` ∈ top/bottom/left/right 缺省 bottom；多图取首张余者逐张计图片；mime 魔数嗅探（png `\x89PNG`/jpg `\xFF\xD8\xFF`/gif `GIF8`/webp `RIFF…WEBP`）白名单外或 zip 查无键→计图片跳过；zip 目录项跳过；w/h float 取整。
- **概要**：JSON 标签=`children.summary[].title`（按 id 映射）+ `summaries[].{topicId,range}`；XML 标签=同父 detached 中 id 匹配 topic 的 title。range 正则 `/^\((\d+),(\d+)\)$/`，children 下标闭区间；非法/越界→计概要跳过。**被概要/外框消费的 detached topic 豁免漂浮计数**（整树不下钻）。
- **超链接**：JSON `topic.href`；XML topic 的 xlink:href。非 http/https（xapp:/相对路径）→计 link（setHref 会拒，解析层预判）。
- **样式**：键映射 fo:color→color、svg:fill→fill、svg:stroke-color→border、fo:font-size→fontSize（去 px/pt 取整，非法/≤0→计样式属性）；其余键（fo:font-family/fo:font-weight/线宽/行高/对齐…）逐键计样式属性。JSON `style.properties` 直读；XML topic style-id→**styles.xml 间接表**（parseXmind 预解析 Map 传入；缺表逐个计数）。
- **结构**：根 structureClass/structure-class→structureType（org.xmind.ui.logic.right→logic；org.xmind.ui.map.*→mindmap；org.xmind.ui.org-chart.*→org；其余→计结构覆盖落缺省）；非根 structure-class 逐个计结构覆盖。sheet theme（JSON 键/XML 属性，子元素兜底）→计画布主题。legend 忽略不计（agent 决定，可否决）。
- **折叠**：JSON `branch==="folded"` → `folded:true`（XML 8 无此概念）。胶水 setCollapsed。**agent 新增决定，交付时可否决**。
- callout/boundary/task-info/labels：逐个计数丢弃（callout 按子树节点数，同漂浮口径）；detached 未被消费者按整树节点数计漂浮。detached 子树内部不细计（m4 挂账口径延续）。

## 五、导入胶水 v2（`apps/web/src/editor/xmind-import.ts`）

- `importXmindFile(file, deps:{createFile, uploadImage, putDocState})`：**无图快路径**走现状单段 POST /files（现有 e2e 时序零扰动）；**有图两段式**：先建文件（无图 docState）→ 逐图 readImageSize→clampImageSize（复用 200px 钳制，与手动上传同规则；登记缩放）→10MB 预检→uploadImage→setImage({key,w,h,placement:align??'bottom'})→PUT /files/:id/doc-state（不传 baseUpdatedAt，服务端缺省恒放行）。任意图失败→计图片＋继续。
- 落盘接线：addChild/setText/setNote/setIcon（v2 映射）＋setDescription（补既有缺口）＋setHref＋setStyle＋setSummary（kids.slice(start,end+1)，SUMMARY_INVALID 捕获计概要）＋setDocMeta/addCanvas structureType＋setCollapsed(folded)。walk 递归携带节点 id。
- **顺手修**：现胶水把 canvasId 传进 origin 形参位（addChild 第 4 参）——统一显式 `'system'` origin、canvasId 归位。
- `degradedSummary` v2：全零→「已完整导入」；否则「未导入：图标 2、外框 1」（DEGRADED_LABELS 目录序，仅列非零）。toast 恒弹。

## 六、导出对称（`build.ts`＋`xmind-export.ts`）

- `iconsToMarkerIds` v2（§3.2）；`docToXmindTree` walk 补 href/style 五键（非空才产）；`buildXmind(sheets, extra?:Record<string,Uint8Array>)` 第二参仅为 e2e 夹具开口（导出本身不产 resources/）。EditorPage/ShareDialog 调用点零改动。不写回：图片、概要、folded、emoji/number 组。

## 七、能力边界与残余损失（交付汇报如实登记）

emoji(28)/number(10) 组往返仍丢；颜色/形状有损；mood 仅 smile 可导出（smiley-laugh）；progress none 不导出；图片与概要不导出写回（候选后续任务）；图片 200px 钳制；每节点 1 图；字体/线宽/行高不映射；非 http(s) 链接丢弃；legend 忽略。

## 八、零改动证据

- **engine**：logic 布局 layout.ts:285-298、org :313-322、概要渲染 :538+、八组徽章 MARKER_CATALOG、图片 render.ts:791——全已存在。
- **gmind-core**：setIcon 进度联动、setSummary、setHref/setDescription/setStyle、setDocMeta structureType、setCollapsed——签名逐一核实（operations.ts:182/229/395/419/443/473/535/1245，summary.ts:105，read.ts:153，canvas-ops.ts:72）。
- **server**：POST /files/:id/images（storage.controller.ts:38，10MB/魔数白名单）、PUT /files/:id/doc-state（files.controller.ts:146，baseUpdatedAt 缺省恒放行 files.service.ts:666-673）——零改动。
