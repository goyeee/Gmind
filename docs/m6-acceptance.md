# M6 验收清单（企微对标包——前置连线修复 ＋ 九任务交付 ＋ 需求方排除项台账）

核验日期：2026-09-28。范围＝M6 计划（docs/superpowers/plans/2026-09-27-gmind-m6-wecom-parity.md，b5759f1 起）全部 10 个任务与前置修复；本会话逐条执行/核对——全部 e2e 用例名与行号、实现位置行号均**当日 grep 源码核实**，非转抄历史报告；门禁数字为当日实跑（见「五、支撑输出」）。

验收环境：本机 dev（NestJS tsx `PORT=3001` ＋ vite `WEB_PORT=5174`，`API_ORIGIN=http://localhost:3001`；两进程验收全程共用未重启，当日会话起验前已在跑、env 经 `ps eww` 核实匹配）。登录口径＝新手机号＋开发环境固定验证码 `123456`（与全部 e2e 同源；任务说明提及的 13800000001/123456 为既有账号口径，两者等价走同一登录链路）。

结果标记约定（同 M1~M5）：**通过**＝有当日通过的自动化用例背书（注明出处）；**部分达成/登记**＝如实列出未覆盖面；**待需求方裁定**＝实现忠实执行了计划口径、但存在产品层开放决策；不虚构任何「通过」。

里程碑边界（计划 Global Constraints「不做」＝需求方 2026-09-27 排除清单原文，见下节）：概要「仅同侧」视觉口径、旧主题 root 对比度清偿为**待需求方裁定项**（见「三」），本验收不代签。

## 一、需求方排除项清单（2026-09-27 原文 8 项——M6 不做，验收不据此判缺）

| # | 排除项（需求方原文语义） | M6 处置 |
| --- | --- | --- |
| 1 | 大纲模式 | 不做（计划 Spec 节声明；无对应实现与测试） |
| 2 | 添加节点三按钮（子主题/同级主题/主题前插入 工具栏三钮） | 不做——新增节点仍走 Tab/Enter 键位与右键菜单（M1 既有） |
| 3 | 关联线 | 不做 |
| 4 | 外框 | 不做 |
| 5 | 结构扩展（新布局结构） | 不做——结构仍为 脑图/组织架构图 两型（M1 既有 structure-select） |
| 6 | 提醒查阅（提醒/通知查阅强化） | 不做 |
| 7 | 节点上限显示（配额余量 UI） | 不做——既有配额拦截与脚标计数（M1b/M5 口径）维持不变 |
| 8 | 暗色模式 | 不做（T4 石墨主题为浅底灰阶节点盒，非暗色模式——任务报告裁定原文） |

## 二、前置修复 ＋ 逐任务交付表（T1~T9；实现位置与守卫测试均为当日 grep 行号）

| 任务 | 交付内容 | 实现位置（当日 grep） | 守卫测试（当日通过） | 状态 |
| --- | --- | --- | --- | --- |
| 前置（a602824） | bezier 控制点恒取 dx/2：小列距（如 H_GAP=40 <120）下旧 `max(60, dx×0.5)` 使控制点越过对端端点、曲线 x 折返成涡流交叉（用户截图实锤的连线二次修复；更早 c61df7e 先修锚点偏移＋新建节点先落位） | `packages/engine/src/layout.ts:250-252`（控制点外伸恒取 dx×0.5，x(t) 保持单调） | `layout.test.ts:370`「bezier 控制点不越过对端（连线交叉修复钉定）」（:371-372 注释固化旧缺陷机理）；金样 logic/mindmap.json 随守卫重生成（a602824 --stat 4 文件）；layout.test.ts:333「父侧边锚点沿父边向子扇出（2026-09-27 连线修复钉定）」钉 c61df7e | **通过**（当日 engine 273 单测含上述两钉定） |
| T1 工具栏图标化分组（66c2bff＋修复轮 e628832） | 单行 7 组＋6 道 1px 竖线分隔；全部图标按钮内联 SVG＋title；既有 testid 全保留；find-toggle 占位（T3 接线）；members-btn/两 select 可访问名补齐 | `apps/web/src/pages/EditorPage.tsx:1841-2131`（header.editor-toolbar，组序 返回｜标题｜撤销重做·格式刷｜结构主题｜导出｜协作视图｜全屏）；`apps/web/src/editor/icons.tsx`（15 个导出图标件，PainterIcon :156 / ActivityIcon :179 为 T7/T8 追补） | `apps/web/e2e/toolbar.e2e.spec.ts` 6 例：:52（7 组/6 分隔线）、:67（图标按钮有 svg+title）、:83（既有 testid 全保留）、:90（find-toggle 接线，T1 占位→T3 演进）、:102（members-btn/两 select 可访问名——修复轮新增）、:112（组序按 x 坐标） | **通过** |
| T2 格式面板随选中联动（785e119） | 样式区填充/文字色钮按选中节点 style 回显 aria-pressed；字号/作用域 select 回显；无选中置灰（fieldset disabled＋提示）；切节点即时刷新 | `apps/web/src/editor/RichPanel.tsx:59-60`（props.selected）、:77-79（EditorPage 每 tick 注入 getNode 快照，面板与画布同帧同源）、:119-142（styleSection 回显/置灰）、:230（文字色钮 aria-pressed） | `apps/web/e2e/format-panel.e2e.spec.ts` 2 例：:44（填充钮随选中回显 pressed、切节点清空、清空选择后置灰）、:88（文字色钮回显） | **通过** |
| T3 查找替换（c977651） | Ctrl/Cmd+F 打开；大小写不敏感全文匹配（含 root）；n/m 计数与循环定位（展开折叠祖先＋选中）；替换单条/全部替换单事务一次撤销；Esc/关闭清空 | `apps/web/src/editor/FindReplace.tsx`（:44-63 collectMatchIds 全存活可达节点遍历、:65-77 大小写不敏感替换、:91-205 组件态）；装配 `EditorPage.tsx:396-417`（mod+F preventDefault、isEditableTarget 让路）、:2109-2117（find-toggle 接线）、:2399-2405 | `apps/web/e2e/find-replace.e2e.spec.ts` 2 例：:51（Ctrl+F→计数/循环定位→替换当前→全部替换单事务撤销→Esc）、:144（查「周」6 处含 root、定位展开折叠祖先、输入框内 Ctrl+F 不劫持）；toolbar.e2e.spec.ts:90（接线断言） | **通过** |
| T4 主题扩容 3→12＋缩略图面板（a3fd179） | THEMES 12 套（经典蓝/暖橙/无障碍＋深蓝商务/森绿/樱粉/石墨/紫罗兰/琥珀/青瓷/水墨/蜜桃）；缩略图抽屉面板；select 路径并存零回归 | `packages/engine/src/themes.ts:463-464`（THEMES 12 套 Record）、:484-491（resolveThemeId）；`packages/engine/src/types.ts:105-117`（ThemeId 12 值联合）；`apps/web/src/editor/ThemePanel.tsx:18-31`（THEME_LABELS 穷尽 Record＝编译期单源）、:33（THEME_ORDER）；入口 `EditorPage.tsx:1987-1996` | `apps/web/e2e/theme-panel.e2e.spec.ts` 3 例：:42（12 缩略图＋关闭）、:60（点新主题画布变色、select 同步、Ctrl+Z 恢复）、:84（12 选项 selectOption 路径回归）；`themes.test.ts:217-220`（level1/level2 正文对比度 12 套全跑 ≥4.5）、:223-231（root/折叠徽标 9 新套 ≥4.5＋a11y 全级） | **通过**（旧蓝/暖橙 root 对比度债＝**待需求方裁定**，见「三」） |
| T5 emoji 面板（93d3f4e） | 图标体系扩展 emoji 组（组内单选、组间并存）；72 项三分类静态表（表情/手势/符号各 24）；选中渲染进 .gm-icons 组序末位；再点取消；持久化 | `packages/gmind-core/src/constants.ts:3`（ICON_GROUPS 增 'emoji'）；`packages/engine/src/render.ts:40-48`（emoji 组值本身即字形，占位映射例外）、:199-204（渲染拼接）；`apps/web/src/editor/EmojiPicker.tsx:17-44`（EMOJI_CATEGORIES 72 项/3 类，当日 node 计数核实）、:103-111（tablist 面板）；入口 `RichPanel.tsx:312` | `apps/web/e2e/emoji.e2e.spec.ts` 2 例：:39（选 😊 渲染进图标槽、刷新仍在、再点取消）、:69（emoji 与旗帜并存互不影响、Esc/外点关闭）；`packages/gmind-core/src/operations.test.ts:525`（emoji 组设置/替换/取消往返）、:538（组间并存独立） | **通过** |
| T6 概要 bracket（42aaa14） | 连续同父兄弟片段括弧归纳：`summaries` Y.Map doc 级存储；右键「添加概要」→默认标签行内编辑；删成员 repair 收敛（全缺删概要/部分收敛存活段）；撤销语义 ORIGIN_USER；bracket 下括弧＋居中 label | core `packages/gmind-core/src/summary.ts:92`（setSummary 校验先于事务）、:140（removeSummary）、:148（listSummaries）、:176/:241（planSummaryRepair/applySummaryRepair 三态：删/收敛/不动）；repair 接线 `repair.ts:226-228`/:279/:487-509；engine `layout.ts:283-323`（buildSummaries 成员盒包围盒）、`render.ts:479-497`（`<g data-summary-id>` 差分协调＋bracket path＋label）；web `EditorPage.tsx:334-352`（右键菜单二态＋行内编辑锚定）、:917-1001（选区判定/打开/提交零写入） | `apps/web/e2e/summary.e2e.spec.ts` 2 例：:51（加选连续兄弟→添加→改标签→删成员收敛→撤销概要）、:103（非法选区 toast＋右键 bracket 删除）；`summary.test.ts` 20 例（:54-131 校验拒绝零变更、:133-163 存取、:166-182 撤销、:185-290 repair 收敛含 crafted doc 兜底/远端事务）；`layout.test.ts:433-504`（bracket 几何/墓碑收敛/多概要排序） | **通过**（跨侧片段视觉＝**待需求方裁定**，见「三」） |
| T7 格式刷（b6dc53a） | 单击复制选中节点样式→点目标单事务应用并退出；双击粘滞连续应用（Esc/再点退出）；自刷零写入；无选中 toast；「格式整体复制」口径（源无的目标键/组清除） | `apps/web/src/pages/EditorPage.tsx:172-176`（PainterMode）、:292-293（state/ref 双轨）、:424-446（Esc/光标/只读降级退出）、:496-536（enterPainter/单击双击分流）、:546-581（applyPainterTo 单事务 setStyle 逐键＋setIcon 逐组）；`icons.tsx:156`（PainterIcon）；editor.css（.painter-active cursor:copy/.toolbar-btn.active） | `apps/web/e2e/format-painter.e2e.spec.ts` 5 例：:60（单击应用后自动退出）、:84（双击粘滞连续应用、Esc 退出后不再应用）、:114（无选中 toast）、:129（自刷零写入）、:157（单次应用一次 Ctrl+Z 整体回滚） | **通过**（不跨文档/不复制备注链接图片——口径登记，见「四」） |
| T8 文档动态（803d0c5＋修复轮 2f8af89） | GET `/api/files/:fileId/events` 只读端点（canAccess 口径 404 不泄露存在性、limit clamp 1..100、倒序）；编辑器动态面板（类型中文标签＋作者＋相对时间；**不渲染 payload 任意字段**） | server `apps/server/src/events/events-query.controller.ts:26/:31`（GET :fileId/events）、`events-query.service.ts:16-44`（EventsQueryModule 独立读侧破循环依赖、findAliveOr404 单点闸）；web `apps/web/src/editor/ActivityPanel.tsx:17`（TYPE_LABEL）、:105-112（条目渲染，修复轮已删 describePayload 描述行——封开放遥测通道的跨用户文案注入面）；入口 `EditorPage.tsx:2091-2096` | `apps/server/test/events.e2e-spec.ts` 3 例：:80（造事件→列表倒序＋userName 映射＋payload 还原对象）、:127（limit clamp 1..100 缺省 50 不 400）、:158（无权 404 与不存在同口径；协作者可读）；`apps/web/e2e/activity.e2e.spec.ts` :55（发评论后开面板最新条目为「评论」＋昵称、doc_create 在列、关闭收起） | **通过**（不含系统级事件、开面板拉取一次不实时订阅——登记，见「四」） |
| T9 顶栏头像栏（565e7a7＋修复轮 3faeab8） | presence 同源头像栏：在线全显、离线灰态（会话内已见缓存）、>5 折叠「+N」、点击打开成员面板并定位成员行（scrollIntoView＋2s 高亮）；移动端只读不装配 | `apps/web/src/pages/EditorPage.tsx:1375-1376`（在线判定/展示集口径）、:1434-1446（presence→会话内已见合并）、:2136-2190（avatar-bar/avatar-chip online/offline/溢出位）；`apps/web/src/editor/MemberPanel.tsx:162-176`（定位行 scrollIntoView＋member-row-located 短时高亮） | `apps/web/e2e/avatars.e2e.spec.ts` 3 例：:67（单上下文自身 1 枚在线、点击打开成员面板、移动端不装配）、:91（双上下文 B 加入→A 见 B 在线；B 关闭→转离线灰）、:145（6 人在线→≤5 枚＋「+1」溢出位、点击打开成员面板） | **通过**（离线灰为会话级缓存、刷新即清——登记，见「四」） |

## 三、待需求方裁定项（实现忠实执行了计划口径，产品决策开放——不代签）

1. **跨侧概要视觉（T6）**：mindmap 布局下片段可横跨左右两支（e2e 种子「本周计划」的 周一＋周三 即默认跨侧），bracket 按成员盒包围盒计算会横跨画布、label 落 root 下方。任务报告裁定原文：side 为布局期纯派生量、core repair 无法维护 side 不变量，同侧约束只能落 engine/web 层——属**计划层缺口非实现偏差**。若需求方裁定「仅同侧概要」，最廉价路径为 buildSummaries 按 side 分组取主侧段（任务报告方案）。当前按计划公式（w=片段宽+16）交付，e2e :51/:103 与 summary.test 20 例当日全绿。
2. **旧主题 root 对比度债（T4）**：经典蓝 root 白/#3370ff＝4.28:1、暖橙 白/#ff8800＝2.39:1（均低于 4.5:1；暖橙亦低于 3:1）。两主色为 M1b「主色钉定」用例锁死的绑定值，M1b 仅 a11y 主题承诺 AA——T4 扩容不改 M1b 钉定（零回归裁定，评审核可为计划内在冲突的正确上报）。新守卫范围：level1/level2 正文 12 套全跑 ≥4.5、root ≥4.5 仅 9 新套＋a11y（themes.test.ts:208-231 注释固化）。**清偿需另立任务重裁定 M1b 主色钉定**，M6 登记为 Follow-up debt。

## 四、诚实登记——缺口与口径台账（全部为「未实现/口径边界/环境项」，如实列出防口径漂移）

1. **格式刷口径边界（T7）**：不跨文档（模式态为编辑器页内 state）、不复制备注/链接/图片（仅 style＋icons，冻结语义）；粘滞模式「再双击重进」边缘未单独 e2e 断言；style 侧无差分（全同目标刷仍开空事务，撤销栈可能多空步）；toast 文案多一「请」字；失败路径不退单发模式（近死代码）。
2. **动态面板口径（T8）**：**不含系统级事件**（登录/配额告警等——events 表本就只收 PRD 6.4 编辑域埋点）；开面板拉取一次、不实时订阅（与 ThemePanel 同款旁路视图裁决，重开即刷新）；面板关闭态 items 不重置（视觉残留）；TYPE_LABEL「创建文档」与 brief「创建」措辞偏差已登记；软删 404 未在本 spec 直接断言（与 versions 共用 findAliveOr404 路径）。
3. **头像离线灰为会话级（T9）**：会话内已见缓存页面刷新/换文件即清，离线灰头像不跨会话持久（未引入服务端成员清单第二数据面——边界裁定）；离线幽灵占位会推高 +N 溢出计数（设计取舍可后置）；同账号多标签页 awareness 翻转有重渲染 churn。
4. **emoji VS16 testid 注意（T5）**：4 个含 VS16（U+FE0F）表项的 `emoji-item-{char}` testid 依赖字面量精确（含 FE0F 才可命中）；emoji 表无 ZWJ/肤色序列（72 项均为单码点或合法 VS16 序列）；tablist 无方向键导航；core README ICON_GROUPS 清单滞后未更新。
5. **T2 交互口径**：点空白清空选择为本任务引入的交互变化（此前 no-op；「点空白→样式区置灰」裁定的必要配套，含 >4px 位移守卫＋Shift 框选豁免）；多选（size>1）样式区置灰（样式目标单节点）；零位移程序化点击会真清选中（现有用例无耦合，措辞留档）；根节点默认选中时面板可用（保持既有能力未收窄）。
6. **T3 口径**：root 计入匹配集（查「周」6 处＝root＋5 子孙，brief「全部存活可达节点」按 xmind-export 遍历口径）；「单事务 vs 逐节点事务」在 e2e 层不可区分（UndoManager captureTimeout 500ms 合并同步连发事务）——单事务语义由实现层 withTransaction 包裹保证（undo 调试探针实测）；删末项后游标 clamp 到前项非循环；toLowerCase 长度假设（罕见 Unicode）。
7. **T1 minors**：FormatIcon/StarIcon 导出备用未挂载（RichPanel 常驻右列无 [格式] 按钮——里程碑复核裁定）；e2e helper 第 N 份拷贝（未提共享 fixtures）；1px 浅灰分隔线在截图压缩下不可辨（DOM 几何已实证）。
8. **T4 minors**：面板边框 CSS 第二副本＋硬编码 #3370ff；ThemeThumb role/aria-hidden 冗余；琥珀 root 取深琥珀 #8a4b00（6.80）保色相达标（设计口径登记）。
9. **T6 minors**：commitSummaryEdit 零写入判断比 length 非内容；engine 常量（8/12/14）手抄 web 未共享；viewport 概要豁免无单测；跨侧 label 可能贴出可视区（随裁定项 1 一并处置）；撤销删除复活节点后概要不自动重新扩段（repair 为文档状态纯函数——设计使然）。
10. **T8 修复轮登记**：describePayload 删除为方案 a（字段白名单只收窄字段名不封来源，开放遥测通道的注入面依旧）——正常流本就不可达（现有事件 payload 均不含 title/memberName），零功能损失。
11. **server e2e 首跑 1 例抖动（当日实况）**：全量首跑 `storage.e2e-spec.ts:111`（images/copy 穿越键断言 404 vs 400）1 例失败——控制器属主前置守卫（storage.controller.ts:60 canAccess）在并行负载下抢在键校验前返回 404，属测试断言对守卫顺序的敏感而非产品缺陷（`..` 拒绝在 storage.service.ts:93-95 恒在）；隔离复跑该 spec 12/12 通过、全量复跑 182/182 全绿（见「五」），未改代码，模式留档继续观察（M4/M5 台账同款 flake 纪律）。
12. **web e2e 台账口径差**：M5 验收文档分册计 editor 12 例，当日实测 editor.e2e.spec.ts 为 13 例（`git show b5759f1` 核实 M6 基线即 13，M6 期间零改动）——M5 文档分册计数笔误，不影响 M5 总数（当日实跑 99+1skip 为真）。M6 新增 9 个 spec 26 例，126＝100（既有）＋26（M6）对账吻合。
13. **截图存证口径（当日实况）**：本会话浏览器自动化 MCP 不可用（子代理环境限制），改以仓内 Playwright 工具链（chromium headless 对同款 dev 形态）按各任务 e2e 同源选择器逐能力实操取证——每步均以 DOM 等待断言（aria-pressed 回显、`[data-summary-id]`、emoji-picker、theme-item 等）证明状态到达后截图，脚本跑毕即删（M5 perf 临时工具同款口径）；工具栏截图经视觉复核确认 7 组图标化布局。截图为**辅助证据**，验收判据以当日 e2e 为准（任务说明原文口径）。

## 五、支撑输出（2026-09-28 本会话全量实测；dev 服务器 :3001/:5174 全程共用未重启）

- `pnpm lint`：exit 0，无输出。
- `pnpm typecheck`：六包（server/web/engine/gmind-core/shared/xmind-io）全部通过，exit 0。
- `pnpm test`（全仓单测）：**540 passed**，Test Files **37 passed**，exit 0——@gmind/shared 5（1 文件）、@gmind/xmind-io 22（3 文件）、@gmind/gmind-core **182**（**12** 文件，M6 新建 summary.test.ts 20 例＋operations emoji 2 例）、@gmind/server 21（5 文件）、@gmind/engine **273**（11 文件，M6 增概要布局/bezier 钉定/主题 WCAG 守卫等 61 例）、@gmind/web 37（5 文件）。较 M5（457/36）净增 83 例 1 文件，全部为 M6 任务守卫。
- `pnpm --filter @gmind/server test:e2e`：**Test Files 16 passed (16)，Tests 182 passed (182)**，exit 0——auth 8 / files 5 / db-init 2 / users-me 2 / users 14 / file-content 19 / storage 12 / collab 6 / files-views 24 / folders 13 / trash 10 / share 28 / comments 9 / notify 15 / versions 12 / **events 3（M6 新建：:80/:127/:158）**。**如实记录**：当日首跑 1 例失败（storage :111 穿越断言，见诚实登记 11）——隔离复跑该 spec 12/12、随后全量复跑 182/182 全绿，上列数字为复跑输出，未改代码。既有已知 stderr 噪音（套件收尾 `[collab] 卸载快照失败… Connection is not established`）当日同款出现，断言零失败（M4 起登记口径）。
- `WEB_PORT=5174 API_ORIGIN=http://localhost:3001 pnpm --filter @gmind/web e2e`：**126 passed, 1 skipped（24.2s）**，0 failed，exit 0（skip 为既有 PERF=1 门控 perf-editor）。M6 新增 9 spec 26 例当日全绿：toolbar 6 / format-panel 2 / find-replace 2 / theme-panel 3 / emoji 2 / summary 2 / format-painter 5 / activity 1 / avatars 3；既有 spec 零回归（workspace 14 / collab 7 / editor 13 / rich-content 8 / import-export 6 / m1-gaps 6 / m0-acceptance 3 / share 3 / comments 3 / member-invite 3 / notify 2 / versions 3 / settings 4 / help-panel 2 / guide 2 / telemetry 5 / mobile-readonly 5 / error-copy 11）。
- 浏览器实测（辅助证据）：chromium 对 dev 形态逐能力实操（登录→种子文档→九能力各一步），全部 DOM 等待断言通过，截图 10 张存 `gui-test-screenshots/m6-01~10-*.png`（工具栏/格式面板联动/查找替换/主题面板/emoji/概要/格式刷/动态/头像栏/画布终态全景）。

## 六、M6 验收结论（如实记录）

- **前置修复**（a602824 连线涡流交叉；c61df7e 锚点＋落位）有当日通过的钉定用例背书（layout.test.ts:333/:370），**通过**。
- **九任务（T1 工具栏/T2 格式面板联动/T3 查找替换/T5 emoji/T7 格式刷/T8 文档动态/T9 头像栏）当日全绿，通过**；**T4 主题扩容通过**（附旧蓝/暖橙 root 对比度债待裁定）；**T6 概要通过**（附跨侧片段视觉待裁定）。两项待裁定均为计划层/需求方域决策，非实现缺口，已单列「三」不代签。
- **排除项 8 项**按需求方 2026-09-27 原文裁定不做，本验收不据此判缺。
- 门禁面：lint/typecheck 干净；全仓单测 540、server e2e 182（首跑 1 例负载抖动，隔离＋全量复跑双绿，模式留档）、web e2e 126+1skip（0 failed）。无一虚构「通过」。
- 诚实登记 13 条（口径边界 9、minors 汇总 3、环境/流程实况 1——含当日 flake 与截图取证口径），后续排期与裁定由需求方决策。
