# 导入导出（XMind 进出 + PNG/JPG 导出）

> 功能逻辑文档（AGENTS.md §四 五栏目，写给人看）。核对日期与代码版本见文末「最后核对」；行号是核对当日读码所得，后续代码变动请当日重新 grep 再引用。2026-11-14 导入保真度升级后的口径（进度/表情/图标/图片/概要/超链接/样式全接入）。

## ① 这是什么

两个方向的能力：

- **导入 .xmind**：把 XMind 做的文件搬进来变成一张 Gmind 脑图。入口在工作台首页的「导入文件」卡（`apps/web/src/pages/WorkspacePage.tsx:871`，点开后走隐藏的文件选择框 `:790`）。只支持 `.xmind` 一种格式（XMind 8 和 XMind 2020+ 两种内部格式都能读，见规则 2）；单文件上限 20MB。
- **导出**：编辑器顶栏「分享」旁的导出菜单（下载 XMind `.xmind`、PNG/JPG 图片）。XMind 导出把当前文件的**全部画布**写成一个多 Sheet 文件，XMind 打开能直接用。

导入后降级提示会**逐项点名**哪些东西没搬进来（比如「未导入：图标 2、外框 1」）；全搬进来了就提示「已完整导入」。

## ② 规则（逐条）

1. **两种内部格式都认**：打开 .xmind（zip 包）后，有 `content.json`（XMind 2020+）优先按新格式读，否则读 `content.xml`（XMind 8 旧格式）（`packages/xmind-io/src/index.ts:94-98`）。XMind 8 的根元素是 `<xmap-content>`，合成夹具历史形状 `<map>` 也兼容（`packages/xmind-io/src/parse-xml.ts:283-289`）。
2. **20MB 上限**：超过直接拒绝，提示「文件大小超过 20MB 上限，请压缩后重试」，文件不会被解析（`apps/web/src/editor/xmind-import.ts:64`、`:149`）。
3. **画布对应关系**：XMind 的每个 Sheet 进来变成 Gmind 的一张画布：第一个 Sheet 进首画布（画布名=Sheet 名，根文本=Sheet 根标题），其余 Sheet 逐个新建画布，画布自己的布局结构也一并带过来（`apps/web/src/editor/xmind-import.ts:257-282`、`:172-175`；多画布能力见 `packages/gmind-core/src/canvas-ops.ts:72`）。反过来导出时全部画布逐个出 Sheet（`apps/web/src/editor/xmind-export.ts:82-87`）。
4. **布局结构三映射**：根节点上声明的布局按三档认——`org.xmind.ui.logic.right`→逻辑图（向右）、`org.xmind.ui.map.*`→思维导图、`org.xmind.ui.org-chart.*`→组织架构图；认不出的值记一条「结构覆盖」降级、画布落默认布局；**非根节点**上的布局声明一律丢弃并逐条计「结构覆盖」（`packages/xmind-io/src/parse-json.ts:123-130`、`:218-220`；XML 侧 `parse-xml.ts:203`、`:308`）。**思维导图画布的根分支分侧规则**（2026-11-15 按需求方源文件校准，替换 11-14 首版「轻侧贪心」——首版与 XMind 真实平衡不符被打回）：**子树权重最大的分支锚定左侧，文档序在它之前的分支全部居右（保持文档序），它之后的分支随它居左**；引擎右列文档序自上而下、左列文档序倒排，视觉顺序即与 XMind 一致。此前 addChild 固定「右侧最多 3 个」配额也一并替换（10 分支文件右侧只进 3 个的问题）。逻辑图/组织架构图侧别无语义不处理（`apps/web/src/editor/xmind-import.ts:235-246` 规则实现、`:277-278` 落盘走 `packages/gmind-core/src/operations.ts:368` setNodeSide）。
5. **标记（图标）映射**：XMind 的小图标按映射表转成 Gmind 八组制标记，表分「实测/推断」两档置信级（真实文件见过的 id 才算实测；推测补全的记推断，证伪就删行；无法核对的宁可丢弃不乱映射）——映射表单源在 `packages/xmind-io/src/markers.ts:70-105`（导入表）、`:153`（导入逻辑）。要点：
   - 进度 9 档：`task-start/oct/quar/3oct/half/5oct/3quar/7oct/done` → 未开始/12.5%…87.5%/完成；写进标记会**联动任务进度百分比**（`packages/gmind-core/src/constants.ts:98-108` 的换算表）；
   - 表情族：smiley-smile/sad/cry 同名落「心情」，smiley-laugh（大笑）形近映射为「心情 微笑」；
   - 人物族六色全部落「其他·人员」（颜色丢）；符号族 plus/question/wrong/right/idea 与 c_symbol_like（下划线精确 id）落「其他」对应值（wrong→取消、right→完成）；
   - 箭头四向同名落「箭头」（颜色丢）；优先级 1-9 落 P0~low（8/9 按 M7a 口径折到 low）；flag-\* 任意颜色落「旗帜」；star-\* 任意颜色落「其他·重要」；
   - **认不出的图标（如 arrow-refresh、symbol-minus）丢弃并计入提示的「图标」数**（`markers.ts:175-177`）。
6. **同节点重复图标**：单选组（优先级/旗帜/进度/心情/箭头）一个节点只留第一枚，后面的丢弃计数；「其他」组可并存多枚，同值重复也算丢弃（`markers.ts:108`、`:179-191`）。
7. **图片**：.xmind 里内嵌的图片**会提取上传入库**，挂到对应节点上（2026-11-14 推翻 M4「图片只计数不提取」旧裁定）。规则：格式只收 png/jpg/gif/webp 四种（按文件头魔数判断，`packages/xmind-io/src/index.ts:39-65`）；**长边钳到 200px 等比缩小**（与手动传图同规则，`apps/web/src/editor/imageUpload.ts:65-74`）；单张超 10MB 拒传；一张节点只取第一张图，多余图片逐张计入提示；任何一张图失败只丢那张、导入继续（`apps/web/src/editor/xmind-import.ts:311-337`）。图片的四方向槽位（上/下/左/右）跟着源文件的 align 走，缺省挂节点下方（`xmind-import.ts:336`）。
8. **图片是两段式导入**：文件里**有图**时，先建文件→逐张传图→最后回写一次完整文档状态（`xmind-import.ts:296-302`）；**没图**走老的单步建文件，行为不变。用的接口就是页面手动传图同两款：`POST /api/files/:id/images`（`apps/server/src/storage/storage.controller.ts:38`）和 `PUT /api/files/:id/doc-state`（`apps/server/src/files/files.controller.ts:146`）。
9. **概要（大括号）两段式搬进来**：XMind 的概要=「父节点记录覆盖哪几个子节点（范围）+ 一条标签文本」。进来后用 `setSummary` 落盘（`apps/web/src/editor/xmind-import.ts:201-210`；core 写入口 `packages/gmind-core/src/summary.ts:105`）。范围写法 `(1,3)` 表示盖住第 2~3 个子节点（闭区间下标，`packages/xmind-io/src/parse-json.ts:60`）；范围非法/倒序/越界的丢弃计数。标签文本：2020+ 格式在 `children.summary` 桶按 id 对号（`parse-json.ts:177-202`）；XMind 8 在 `<topics type="summary">` 桶按 topic-id 对号（`parse-xml.ts:158-181`，2026-11-14 真实文件冒烟修正——旧实现只在 detached 桶找，真实文件标签会全变空）。
10. **节点样式四键**：只映射 4 个样式——文字颜色（fo:color）、填充色（svg:fill）、边框色（svg:stroke-color）、字号（fo:font-size，去掉 px 取整）；其余样式（字体/加粗/线宽/行高/对齐…）逐条计入「样式属性」降级（`parse-json.ts:89-120`）。XMind 8 的样式放在 styles.xml 里按 style-id 间接引用，解析时先查表（`parse-xml.ts:83-115`，查不到按条计数）。
11. **超链接**：只搬 http/https 链接；`xapp:` 内部跳转和相对路径丢弃计「超链接」（`parse-json.ts:221-226`；`parse-xml.ts:217-222`）。
12. **折叠状态**：2020+ 格式的 `branch:"folded"` 折叠态会跟着进来（`parse-json.ts:261`）；XMind 8 格式没有这个概念。落盘走 `setCollapsed`（`xmind-import.ts:220`；core `operations.ts:1202`）。
13. **降级提示逐项点名**：导入完成后 toast 恒弹。全零=「已完整导入」；否则「未导入：」开头，**只列非零项、按固定目录序、「、」连接**，目录 14 类依次是：图标/标签/样式属性/图片/附件/备注图片/超链接/标注/外框/漂浮主题/任务信息/结构覆盖/概要/空画布（目录定义 `packages/xmind-io/src/types.ts:64-101`；文案组装 `apps/web/src/editor/xmind-import.ts:95-100`）。解析层与胶水层的计数会在合并后按同一目录排序去零（`xmind-import.ts:115-132`）。
14. **画布主题（sheet theme）与图例（legend）都不计入提示**：画布主题自 2026-11-14 起不再计入「未导入」（需求方拍板：主题由 Gmind 自有主题替换呈现，属有意替换非内容丢失——导入后配色观感与 XMind 不同属预期；解析层不计数，`parse-xml.ts:306-307`、`parse-json.ts:317-318` 注释，目录键已移除 `types.ts:61-64`）；图例 legend 同为忽略不提示（解析层不读 legend，行为由 `packages/xmind-io/src/parse.test.ts:344` 断言钉住）。
15. **XMind 导出写回范围**：层级/文本/备注/任务描述/标记（有原生对应的值）/超链接/样式四键会写出去（`apps/web/src/editor/xmind-export.ts:35-78`、`packages/xmind-io/src/build.ts:47-74`；样式逆映射 `build.ts:18-41`，字号产回 `<n>px` 形状）。标记导出原则是**不造 XMind 不存在的 marker-id**：进度 8 档写 task-\*（未开始不写）、心情只写 smile→smiley-laugh（难过/哭/爱心眼/飞吻不写）、其他组六值写 symbol 族与 c_symbol_like、人员写 people-orange、箭头四向同名；**emoji 组、数字组与其余值不写**（`markers.ts:197-229`）。
16. **导出不写回清单**：图片、概要、折叠状态、emoji/数字标记、颜色形状信息——这些导出后不在 XMind 文件里（候选后续任务，见 m4-acceptance 2026-11-14 补记的残余损失清单）。导出文件名=编辑器标题+`.xmind`（`xmind-export.ts:93-105`）。
17. **PNG/JPG 导出**：1x/2x/3x 三档，PNG 可勾透明底（默认勾选——`apps/web/src/pages/EditorPage.tsx:746` `useState(true)`、勾选框 `:4417-4418`；JPG 恒白底）；有折叠节点时先弹确认「检测到 N 处折叠，将自动展开后导出」（`apps/web/src/pages/EditorPage.tsx:1294-1295`），导出的快照含全部子节点、画布折叠态不变（`apps/web/src/editor/image-export.ts:64` exportImage、`:77` cloneExpanded、`:94` toBlob png/jpeg）。单文档超 500 节点拒绝导出（`apps/web/src/editor/image-export.ts:73`，`countAliveReachable > MAX_DOC_NODES`）。
18. **权限**：导入是你自己账号的新文件（创建者=owner）；导出要求能打开该文件（只读会话导出 PNG 同样可用——图片导出是纯读操作）。
19. **文件名与中心主题**（2026-11-14 需求方拍板）：**文件名=原文件名去掉 .xmind 后缀**（`apps/web/src/editor/xmind-import.ts:166-171`，文件名只剩后缀时回落根主题标题 `:173` 覆写 meta.title）；**画布中心主题的文本恒为 XMind 根主题原文**，不跟着文件名变（`xmind-import.ts:162-165`——createTemplateDoc 的 title 同时喂根文本与 meta.title，故随后用 setDocMeta 只覆写文件名；工作台列表名与编辑器中心主题从此可以不同）。

## ③ 特殊情况

- **文件损坏/不是 .xmind**：提示「文件已损坏，无法解析，请检查文件后重试」（zip 打不开、content 格式不对、组装超限都归这句，`apps/web/src/editor/xmind-import.ts:156-160`、`:282-291`）；zip 里既无 content.json 也无 content.xml → 「无法识别的文件格式（仅支持 .xmind），请更换文件后重试」。
- **根主题没有标题**：文件名照用（原文件名去后缀优先，`xmind-import.ts:166-171`）；中心主题文本为空。
- **Sheet 为空**：第一个 Sheet 没根主题=整份损坏；后续 Sheet 没根主题计「空画布」跳过、不中断（`parse-json.ts:306-315`、`parse-xml.ts:293-296`）。
- **图片引用坏了**（zip 里查不到那个文件/格式不在白名单）：该图计「图片」降级、节点照常进来只是没图（`parse-json.ts:160-162`）。
- **概要标签超长**：core 的 setSummary 会拒绝（超 200 字整单拒绝），捕获后计「概要」降级，文档不留残缺条目（`xmind-import.ts:194-203`；校验先于事务，doc 零残缺）。
- **同图多节点引用**：每个引用节点各传一次图、各挂各的 key（`apps/web/src/editor/xmind-import.test.ts:449` 用例钉住的现行行为）。
- **认不出的标记/样式/结构**：一律「丢弃+如实计数」，不猜不硬塞（2026-11-14 需求方裁定：宁可少映射不可歪映射）。
- **任务进度联动**：进度标记写入会联动任务百分比、双向同步（`packages/gmind-core/src/constants.ts:92-108` 注释口径）；所以 XMind 的进度进来后表格/任务面板/筛选直接可用。
- **导入中断**：单张图失败/单枚图标超上限都只丢那一项，其余照常；只有整个文档组装失败（文本超限/树太深）才整体报「文件已损坏」。

## ④ 待需求方确认

以下细节是 agent 按当前实现如实登记的，需求方尚未逐字认过；要改就是新任务。

1. **smiley-laugh（大笑）→「心情 微笑」是形近映射**：agent 决定（spec §3.1 标注「可否决改丢弃」）；若你希望大笑直接丢弃，改一行映射即可。
2. **legend（图例）忽略不计提示**：agent 决定不提示（图例是画布装饰，不是内容）；如需计入降级提示可改。
3. **同图多节点逐节点重复上传**（不共享存储键）：现行为如实登记；去重（同字节只传一次）是候选后续任务（T4 评审挂账）。
4. ** setDescription 超 200 字整单拒绝**：XMind 侧描述字段仅 2020+ 自定义键往返（Gmind 自产自销），他方文件无此字段；概要标签超 200 字按「概要」降级丢弃（T4 评审挂账口径）。
5. **残余损失清单**（导出对称性）：emoji(28)/数字(10) 组往返仍丢；颜色/形状有损（旗帜恒红、人员恒蓝、箭头恒蓝、星星恒橙）；心情仅 smile 可导出；进度「未开始」不导出；图片/概要/折叠不导出写回；字体/线宽/行高不映射；非 http(s) 链接丢弃；XMind 8 格式无任务描述字段。
6. **有图导入中途失败时文件已建**：两段式先建文件后传图，若传图/回写环节整体失败（如断网），文件已存在但停在无图初态——可重新打开再手动补图；是否要改成「失败即回收文件」属产品裁定（T4 评审挂账；putDocState 失败行为有单测钉形，`apps/web/src/editor/xmind-import.test.ts`「putDocState 拒绝」用例）。
7. **setStyle 无键白名单**：core 的 setStyle 写入口不校验键是否在目录内（`packages/gmind-core/src/operations.ts:1245`）——导入路径只产四键所以实际无影响，但属 core 独立缺口，候选后续任务（T5 评审挂账）。
8. **概要标签引用查无时产空标签条目**：标签 topic 的 id 与 summaries[].topicId 对不上（如 topicId 拼写对不上任何标签 topic）时不丢弃计数，而是产一条**空标签**的概要条目（T2 拍板、`packages/xmind-io/src/parse.test.ts` ghost 用例钉死；要不要改成丢弃计数由你定）。
9. **三个边角静默丢失（终审 Minor#5 挂账登记，不改代码）**：①被概要/外框引用的标签 topic 若自带子树，子树内容零计数消失（标签 topic 只取 title 当文本、不进树也不计降级）；②孤儿标签 topic 静默消失（在 summary/boundary 标签桶里但没有任何引用指向它——不进树、不计漂浮也不计其他降级）；③JSON 的 `summaries` 键若不是数组则静默跳过（当无概要处理，不计数）。以上都是真实文件里极罕见的边角，当前行为=安静丢，要改成逐条计数属新任务。
10. **思维导图分侧规则是按单一文件校准的近似**（2026-11-15）：XMind 的平衡算法没有官方文档、也不写进文件，规则 4 的「最大分支锚左、前右后左」以你这份 Gmind问题汇总.xmind 校准（逐支吻合）；其他形态的文件（如最大分支在文档中部之后、或有多个大分支）不保证与 XMind 逐字一致——发现不对的文件发来，继续校准。

## ⑤ 最后核对

- 核对日期：2026-11-14（同日两批：主升级＋下午跟进批，行号以后批当日 grep 为准）
- 代码版本：工作树（未提交，基于 commit f2cbf6e）
- 当日自动化背书：xmind-io 单测 69/69（parse 38＋build 8＋roundtrip 6＋markers 17）、web 单测 163/163、import-export e2e 9/9、error-copy e2e 11/11、web e2e 全量 215 passed＋1 skipped＋0 failed；真实文件（需求方本机 吾盛待办10.27.xmind，XMind 8 XML）冒烟通过——toast「未导入：图标 2、画布主题 2、结构覆盖 1」、2 画布双 logic、图片 108×200 挂节点下方、38 概要全落位、86 标记按映射落位。
- **同日跟进批（下午，规则 4 均衡定侧/13-14 目录去画布主题/19 文件名，需求方复测 Gmind问题汇总.xmind 反馈三项后拍板）**：修复后吾盛待办10.27.xmind 新预期提示=「未导入：图标 2、结构覆盖 1」，Gmind问题汇总.xmind 预期=「已完整导入」；跟进批背书=xmind-import.test.ts:152/:203/:211/:239、parse.test.ts:317/:342/:724、import-export+canvas-scope e2e 10/10、全量 web e2e 215+1skip+0 failed。早期冒烟截图（含业务内容）不留存。
