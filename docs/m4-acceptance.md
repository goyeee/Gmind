# M4 验收清单（PRD 导入导出与版本 FR-IO-001/002/003/004(XMind)/005、FR-VER-001/004 ＋ M2 准入台账 §7.10/7.11 ＋ M3b 缺口清偿小包）

核验日期：2026-09-26。对照《Gmind_在线协作脑图软件_产品需求文档.md》第 4 章需求编号逐条列示；「结果」列为当日实测输出与本仓源码核对后如实填写（本会话逐条执行/核对——全部 e2e 用例名与行号、实现位置行号均当日 grep 源码核实，非转抄历史报告）。

验收环境：本机 dev（NestJS tsx `PORT=3001` ＋ vite `WEB_PORT=5174`，API_ORIGIN=http://localhost:3001）。开发环境验证码固定 `123456`。全量回归（单测＋服务端 E2E＋浏览器 E2E）全程共用该 dev 服务器（进程未重启）。

结果标记约定（同 M1/M2/M3a/M3b）：**通过**＝有当日通过的自动化用例（E2E/单测，注明出处）；**通过（单测/e2e）＋待手动核验**＝自动化已覆盖同链路、体验/视觉/跨机网络层/真实墙钟须人工确认；**部分达成**＝已实现子项有通过用例、明确列出未实现缺口；不虚构任何「通过」。

里程碑边界（M4 计划 Global Constraints「本计划不做」，防验收口径漂移）：PDF/SVG 导出（二期）、FreeMind/Markdown/OPML/TXT 导入（二期）、FR-VER-002 手动版本（三期）、FR-VER-003 版本对比（二期）、导入图片对象提取（.xmind 内嵌图按降级计数，FR-IO-002 口径）。FR-IO-004 的 Markdown/FreeMind 导出（三期）、Word 导出 FR-IO-006（三期）同样不在 M4 范围。

## 一、M2 准入台账 §7.10/7.11 收口证明（docs/m2-entry-checklist.md 条目 10/11，M4 前置必须）

| 项 | 台账要求（原文语义） | 实现位置 | 守卫测试（当日通过） | 状态 |
| --- | --- | --- | --- | --- |
| 7.10 已注册用户被邀请是死路 | 回填仅在新用户创建路径触发（`if (!user)` 门控）→ 对已注册邮箱/手机号邀请永久悬挂。裁定＝扩展现有回填：已移出 `if (!user)` 门控，新旧用户每次登录尽力触发（幂等＝pending 过滤 + uk_invite，失败隔离同邮件旁路）。验收＝已注册受邀者完成授权的 e2e | `apps/server/src/auth/auth.service.ts:31-37`（裁定注释 :31-32；:35 `await this.invites.acceptPendingForNewUser(user)` 位于 :23 `if (!user)` 门控**之外**、每次登录执行；:36-37 catch 隔离不炸登录）；`apps/server/src/share/invite.service.ts:104` acceptPendingForNewUser（:111 事务原子；:127 isDuplicateKeyError 并发败者幂等 no-op） | `apps/server/test/share.e2e-spec.ts:512`「准入 7.10：已注册用户被邀请，登录后自动获得授权（不再永久悬挂）」——对已注册邮箱发邀请 → 首次登录仍 pending → 二次登录（:498 注释「回填对已注册用户同样生效，每次登录尽力触发」）→ accepted ＋ collaborator 行；配套 ：457「回填中途失败与登录隔离：登录仍 200、事务回滚（行保持 pending、无协作者行）；**二次登录按 7.10 天然重试成功**」（故障注入 pinning） | **已收口**（台账条目 10 已由 M4 T1 回写「已收口（M4 T1，commit d187f39）」注记，本日复核原文与实现一致） |
| 7.11 回收站提醒双重邮件 | cleanup remind() 即时发邮件且所写通知行不带 emailed_at → 15 分钟后 DigestService 再发一封（MailHog 接通后每次提醒=两封）。裁定＝remind() 落行即置 emailed_at（DigestService 扫描跳过本行；不取「digest 跳过 type='system'」——不排除将来 system 行入摘要）。验收＝即时邮件不触发 15 分钟摘要重发的 e2e | `apps/server/src/jobs/cleanup.service.ts:110-112`（注释「准入 7.11：即时邮件已发（或无邮箱天然不可达），行级 emailed_at 置位使 DigestService 扫描跳过本行」＋ :112 `notification.emailedAt = new Date()`，早于 :113 save） | `apps/server/test/trash.e2e-spec.ts:344`「准入 7.11：回收站提醒的即时邮件不触发 15 分钟摘要重发（emailed_at 落行）」——runCleanup(+27d) 触发提醒后，该通知行 emailed_at 非 NULL；再跑 runDigest 不产生第二封摘要邮件 | **已收口**（台账条目 11 已由 M4 T1 回写注记，本日复核原文与实现一致） |

## 二、FR-IO-001 文件导入（XMind，P0）

| 编号 | 验收项（PRD 原文） | E2E 用例 / 自动化验证 | 手动核验步骤（自动化未覆盖部分） | 结果 |
| --- | --- | --- | --- | --- |
| FR-IO-001 | 「用户可以在文件列表页或编辑器内通过"导入"入口上传格式文件，一期支持 XMind（.xmind）格式；……单文件大小上限 20MB。导入成功后新建脑图文件；解析失败时系统应提示具体原因（格式不受支持/文件损坏/超出大小上限）」。验收：「当用户上传 25MB 的 .xmind 文件时，系统应拒绝并提示大小超限；上传合法 .xmind 后应生成层级结构一致的脑图」 | 浏览器（`apps/web/e2e/import-export.e2e.spec.ts`）：:43「工作台导入 .xmind：新文件出现且层级/备注正确渲染」（程序化 zip 夹具 buildXmind 构造：root＋两级子树＋分支A备注 → 列表新行 → 编辑器 root/分支A/孙1 渲染 ＋ gm-note-badge 恰 1）；:63「导入 25MB 超限：提示大小上限；损坏文件：提示已损坏」（21MB buffer → toast「文件大小超过 20MB 上限」；1KB 乱字节 → 「文件已损坏，无法解析」且列表仍 3 行）。web 单测（`apps/web/src/editor/xmind-import.test.ts`）：:16「正常导入：先序组装 doc（层级/备注），title=根主题，state 可回读，degraded 透传」；:45「超 20MB：拒绝且不解析」；:51「合法 zip 但无 content.*：UNSUPPORTED_FORMAT 归因『无法识别的文件格式（仅支持 .xmind）』」；:58「乱字节：归因『文件已损坏』」；:40「根主题缺标题：title 回落文件名去 .xmind 后缀」。服务端（`apps/server/test/file-content.e2e-spec.ts` POST /api/files 携带 docState 组，:466 起）：:501「导入：携带 docState 建文件——nodeCount 服务端重算、层级/备注落库」（夹带 nodeCount=999 被无视、docFromState 回读层级/备注一致）；:540「导入：损坏 docState → 400『文件已损坏』」。实现：`apps/web/src/editor/xmind-import.ts:51`（MAX_IMPORT_BYTES=20MB :14，解析前预检 :51，错误归因 :53-60）；`apps/web/src/pages/WorkspacePage.tsx:435`（import-button）/ :443（import-input）/ :251-258（importXmindFile → 新行回刷＋失败/降级 toast）；`apps/server/src/files/files.service.ts:111-119`（docFromState 抛错 → 400「文件已损坏」:113；nodeCount 一律 countAliveReachable 重算 :119，不信任客户端） | 「提示具体原因」的三类文案中「格式不受支持」仅单测覆盖（:51），浏览器 e2e 只造了大小超限与损坏两类——如有需要可用手造伪 zip 补一次目视。**PRD「25MB」字面用 21MB buffer 等价**：上限 20MB（>20MB 即拒绝域），21MB 与 25MB 同处拒绝域、走同一 `file.size > MAX_IMPORT_BYTES` 分支，字面 25MB 专属值未单独造件——等价边界如实注明 | **通过（web e2e 2 例 ：43/:63 ＋ web 单测 5 例 ＋ server e2e 2 例 ：501/:540）**。备注如实：①PRD「文件列表页**或**编辑器内」——一期为工作台（文件列表页）单入口，编辑器内无导入入口（「或」字面由单入口满足，双入口属后续增强，口径登记非隐藏项）；②e2e 夹具为程序化 zip（buildXmind 产物），**真实 XMind 客户端导出的 .xmind 文件导入属人工项**（见手动清单 5） |

## 三、FR-IO-002 导入降级与提示（P1）

| 编号 | 验收项（PRD 原文） | E2E 用例 / 自动化验证 | 手动核验步骤（自动化未覆盖部分） | 结果 |
| --- | --- | --- | --- | --- |
| FR-IO-002 | 「当源文件包含 Gmind 不支持的元素（如特定主题样式、附件类型）时，系统应按对照表规则降级处理，导入完成后以通知形式告知降级项数量与类型」。验收：「当导入含自定义样式的 XMind 文件后，系统应弹出『已降级处理 2 项样式』类提示，且节点文本与层级完整」 | 解析层计数（`packages/xmind-io/src/parse.test.ts` 18 例中降级专项 7 例）：:60「降级计数：markers/labels/realHTML 备注/漂浮主题」；:89「降级计数：图片/附件/备注内图片 → media，概要/额外 sheet → structure」；:121「style 属性与 sheet theme 计入 style 降级」；:176/:189/:206（XMind 8 xml 路径：detached/markers·labels·图片·概要/额外 sheet 对应计数）；:148「rootTopic 无 title……无 markers 等则零降级」。文案构造（`apps/web/src/editor/xmind-import.test.ts`）：:65「全 kind：已降级处理 N 项（样式 x/媒体 y/结构 z）」；:75「部分 kind：零计数 kind 不出现在括号内，前缀保持『已降级处理 N 项』」；:85「空降级：仅前缀」。toast 接线：`apps/web/src/pages/WorkspacePage.tsx:258`（`degraded.length > 0 → showToast(degradedSummary(degraded))`）；`apps/web/src/editor/xmind-import.ts:25` degradedSummary | **降级 toast 的浏览器层端到端呈现无自动化用例**（import-export.e2e 夹具为纯净树 degraded=[]，:134 断言空数组）——计数（parse.test）与文案（degradedSummary 单测）均当日通过、接线代码在位，但「含降级项的文件导入 → toast 弹出」的组装链路与视觉待人工：可用含 markers/图片的 .xmind 导入目视（可与手动清单 5 真实文件项合并执行） | **通过（单测：解析计数 7 例 ＋ 文案 3 例）＋待手动核验（toast 组装与视觉）**。备注如实：①「节点文本与层级完整」由 FR-IO-001 的 ：43/:501 层级断言覆盖；②T3 deferred 登记：**detached（漂浮）子树整体丢弃，其内部样式/媒体不计数**（降级计数以「存留树上的降级」为口径，代码注释声明）；③导入图片不入库——.xmind 内嵌图按 media 降级计数，不提取入库（FR-IO-002 口径，计划 Global Constraints 明确） |

## 四、FR-IO-003 图片导出（P0）

| 编号 | 验收项（PRD 原文） | E2E 用例 / 自动化验证 | 手动核验步骤（自动化未覆盖部分） | 结果 |
| --- | --- | --- | --- | --- |
| FR-IO-003 | 「用户可以导出 PNG/JPG，可选 1x/2x/3x 分辨率，PNG 支持透明背景开关。导出范围默认为全部节点，系统应自动展开当前折叠的节点后再渲染导出」。验收：「当脑图存在折叠节点时，导出的 PNG 应包含全部子节点；选择 3x 与透明背景时，输出图片应为透明底且分辨率符合 3 倍渲染」 | 浏览器（`apps/web/e2e/import-export.e2e.spec.ts`）：:159「导出 PNG 3x：下载产物 IHDR 尺寸可被 3 整除；无折叠不弹确认」（下载名『本周计划.png』；PNG 魔数＋IHDR 宽高 %3==0——3x 输出=1x 布局三倍的直接证据；**export-transparent 默认勾选断言** :167；无折叠 dialogCount=0）；:185「折叠提示：检测到 1 处折叠 → 确认后导出（画布折叠态不变）」（Ctrl+/ 折叠 → confirm 文案含「1 处折叠」→ 导出 → 徽标仍在/孙节点仍隐藏——**折叠场景导出产物含全部子节点**由 cloneExpanded 快照克隆保证）。引擎单测（`packages/engine/src/export.test.ts`）：:34「exportSceneSvg：序列化含根文本、xmlns、正尺寸；不污染既有场景容器」；:53「org 结构与未知 themeId 兜底同样可序列化」。实现：`packages/engine/src/export.ts:41` exportSceneSvg（detached 容器离屏渲染＋XMLSerializer 序列化＋viewBox 平移取整）；`apps/web/src/editor/image-export.ts:35` exportImage（:45 cloneExpanded 折叠在克隆上展开、画布不动；:51-53 JPG 恒白底/PNG 透明开关；:55-57 toBlob mime png/jpeg）；`apps/web/src/pages/EditorPage.tsx:343` runImageExport（:346-347 countCollapsedWithChildren>0 → confirm「检测到 N 处折叠，将自动展开后导出」）；导出菜单 ：1373 export-menu，:1398 export-transparent（勾选框），:1406~:1422 PNG/JPG×1x/2x/3x 六项（runImageExport 接线 :1409/:1419） | **JPG 导出零自动化用例**（mime、下载成功、白底均无 e2e/单测——e2e 种子无图节点，inlineImages/rasterize/JPG 白底链路无自动化覆盖，T9 deferred 如实登记）；透明底像素级（背景 alpha=0）与白底目视、1x/2x/3x 倍率清晰度目视见手动清单 1 | **部分达成**：PNG 主链路（3x 分辨率断言、折叠提示与全子节点导出、透明开关存在与默认态、文件名）全通过（web e2e 2 例＋engine 单测 2 例）；**JPG 仅有实现与 UI 项、无自动化**（菜单项 export-jpg-1x~3x 在位，行为同函数 exportImage format='jpg' 分支）——JPG 白底/透明底视觉、倍率清晰度全部待手动。备注如实：①T9 裁定——透明勾选静态常显标「透明背景（PNG）」＋JPG 项标「白底」（菜单无预选态，「仅 PNG 显示」不可字面实现，行为等价 opaque=format==='jpg'\|\|!transparent）；②画布像素区域无上限（3x 极端长宽比受 Safari canvas 限制，计划内已知限制） |

## 五、FR-IO-004 文档与数据格式导出（XMind 一期，P0）

| 编号 | 验收项（PRD 原文） | E2E 用例 / 自动化验证 | 手动核验步骤（自动化未覆盖部分） | 结果 |
| --- | --- | --- | --- | --- |
| FR-IO-004（XMind 部分） | 「XMind 导出一期支持；PDF/SVG 导出二期支持；Markdown/FreeMind 导出三期支持。层级类导出（Markdown/mm/xmind）同样先自动展开折叠节点」。验收：「当导出含折叠节点的脑图为 XMind 时，导出内容应包含全部子节点且层级完整」 | 浏览器（`apps/web/e2e/import-export.e2e.spec.ts`）：:115「导出 XMind 并往返导入：层级/文本/备注一致」（export-menu → export-xmind 下载 → 下载名『本周计划.xmind』:124 → **parseXmind 直接解析下载产物**断言 root/周一/周三/周五层级与周一备注『评审要点』/子树『周会对齐』/degraded=[] :129-134 → 产物回灌工作台导入 → 新文件出现且渲染一致 :139-152——导出↔导入双向闭环）。包单测（`packages/xmind-io`）：roundtrip.test.ts:9「多级/备注/空子级/无备注节点深度相等」/ :24「构建产物可被 unzipSync 读回 content.json」；build.test.ts:8/:33（zip 结构与无冗余字段）。实现：`apps/web/src/editor/xmind-export.ts:37` exportXmind（:14-36 docToXmindTree 先序遍历 childIds 存活树，墓碑/悬空不入树）；`packages/xmind-io/src/build.ts:6` buildXmind（2020+ content.json zip）；`apps/web/src/pages/EditorPage.tsx:1379` export-xmind 菜单项（onClick 内 try/catch 失败 toast） | 折叠节点的 XMind 导出**无独立 e2e 步骤**（:115 用例未先折叠）——「自动展开折叠」为数据层天然满足：折叠仅视图态标记，childIds 存活可达树不含折叠概念（`apps/web/src/editor/xmind-export.ts:4-5` 注释原文：「折叠只是视图态（collapsed 标记不影响数据层子树完整性）——FR-IO-004 的『层级类导出先自动展开折叠』在本架构下自动满足，无需展开步骤，导出恒为完整层级」）；同一原理在图片导出路径有自动化钉住（:185 cloneExpanded）。如需双重保险可手动折叠后导出 XMind 解包目视 | **通过（web e2e 往返 1 例 ＋ xmind-io 单测 4 例）**。备注如实：①「自动展开折叠」非显式实现步骤而是数据层天然性质，无 XMind 侧折叠导出的专属自动化断言——注释引用如上，登记为口径说明；②PDF/SVG（二期）、Markdown/FreeMind（三期）按里程碑边界不做，菜单无死按钮 |

## 六、FR-IO-005 导出文件命名与限制（P1）

| 编号 | 验收项（PRD 原文） | E2E 用例 / 自动化验证 | 手动核验步骤（自动化未覆盖部分） | 结果 |
| --- | --- | --- | --- | --- |
| FR-IO-005 | 「导出文件名默认为『脑图文件名.扩展名』；单次导出的节点数上限为 500（与一期统一节点上限一致），超出时提示『文件过大，请拆分后导出』」。验收：「当脑图含 501 个节点发起 PNG 导出时，系统应拒绝并给出拆分提示」 | 文件名：`apps/web/e2e/import-export.e2e.spec.ts` :124（`本周计划.xmind`）/ :173（`本周计划.png`）/ :201（折叠场景 `本周计划.png`）——文件名=编辑器标题（getMeta(doc).title 同源）＋扩展名，XMind/PNG 双格式断言。>500 防御：`apps/web/src/editor/image-export.ts:43-46`（`countAliveReachable(doc) > MAX_DOC_NODES → throw new Error('文件过大，请拆分后导出')`，注释「FR-IO-005 防御：服务端配额与协同 WS 双闸已保证 ≤500，此处为最后一道客户端闸门」）；文案由 EditorPage showToast 呈现。导入侧同限有 e2e：`apps/server/test/file-content.e2e-spec.ts:526`「导入：可达活跃节点 501（+root）→ 400，文案含『节点数』」 | 导出侧 501 拒绝分支**无独立自动化用例**（见备注）——如需目视可用 dev-only 手段造超限文档后点 PNG 导出看 toast | **通过（文件名 e2e 3 例 ＋ 导入侧 501 e2e 1 例）**；导出侧 >500 拒绝为**防御分支，无独立 e2e——如实注明**：一期配额闸（创建/导入/saveDocState/countAliveReachable 重算多处）保证常态文档 ≤500，该分支仅在配额被绕过（手工 doc-state/未来新入口）时触发，属计划明示的防御性闸门而非常态路径 |

## 七、FR-VER-001 自动历史快照（P0）

| 编号 | 验收项（PRD 原文） | E2E 用例 / 自动化验证 | 手动核验步骤（自动化未覆盖部分） | 结果 |
| --- | --- | --- | --- | --- |
| FR-VER-001 | 「系统应在文件内容发生变更后每 3 分钟自动生成一个历史快照；若 3 分钟内无变更则不生成。快照保留最近 90 天，版本时间轴展示快照时间与触发编辑的用户」。验收：「当连续编辑 10 分钟后打开版本面板，应至少存在 3 个自动快照且时间间隔约为 3 分钟；无变更时段不产生新快照」 | 服务端（`apps/server/test/versions.e2e-spec.ts`，注入时钟直调 public 快照入口）：:139「快照：编辑落库后过 3 分钟窗口落 auto 版本行（注入时钟直调）」（落库≠快照：窗口内 0 行；`snapshotIfDue(+4min)` → auto 行 1 条，nodeCount=可达活跃口径、createdBy=编辑人、restoredFrom=null、state 非空）；:160「快照：无变更不落行；间隔内不重复落」（dirty=false 时钟 +10min 不落；+2min 间隔门拦截——「无变更时段不产生新快照」与「约 3 分钟间隔」的直接证据）；:175「快照：卸载时脏文档落行（snapshotIfDirty）」（最后连接断开 → beforeUnloadDocument 落行恰 1 条；卸载后两入口均不再落——无泄漏无重复）；:199「清理：90 天前版本行删除、保留期内保留」（-91d 删/-89d 留，runCleanup 返回 versionsPurged=1）。实现：`apps/server/src/collab/collab.service.ts:68`（SNAPSHOT_INTERVAL_MS=3×60×1000）/ :72（snapMeta per-doc lastAutoAt+dirty）/ :264（编辑置脏）/ :284-313（storeDocument 落库后 snapshotIfDue）/ :89-95（beforeUnloadDocument → snapshotIfDirty 卸载兜底）/ :330 snapshotIfDue（:333 脏∧过窗双门）；`apps/server/src/jobs/cleanup.service.ts:16`（VERSION_RETENTION_DAYS=90）/ :68-73（90 天硬删）。时间轴展示（时间＋触发编辑用户）由 web e2e `apps/web/e2e/versions.e2e.spec.ts:70`（「自动」徽标）与 VersionPanel.tsx:278-288（时间/徽标/createdByName/节点数）覆盖 | 「连续编辑 10 分钟 ≥3 快照」的**真实 3 分钟墙钟节奏以注入时钟等价验证**（真实时长待手动）：e2e 不等待真实 3 分钟，而是直调 `snapshotIfDue(fileId, now+Δ)` 验证「脏∧过窗才落、窗口内不落、无变更不落」的门控语义——节奏正确性由语义组合保证，真实墙钟下的节奏体感（编辑 10 分钟 → 面板 ≥3 条且间隔 ≈3 分钟）见手动清单 6 补一条挂机观察 | **通过（注入时钟 e2e 4 例 ：139/:160/:175/:199）＋待手动核验（真实墙钟节奏）**。备注如实：①T6 deferred 登记——脏标志 TOCTOU：快照 await 期间到达的编辑其 dirty 在完成时被清（粒度损失非数据损失，该编辑并入下一窗口）；②T6 裁定——快照写失败在 storeDocument/beforeUnloadDocument 内吞错仅 log（v4 对 store 抛错整链重放、unload 抛错弃卸载滞留内存，吞错范围仅限快照、persist 失败仍上抛） |

## 八、FR-VER-004 一键恢复（P0）

| 编号 | 验收项（PRD 原文） | E2E 用例 / 自动化验证 | 手动核验步骤（自动化未覆盖部分） | 结果 |
| --- | --- | --- | --- | --- |
| FR-VER-004 | 「文件所有者与编辑者可以将文件恢复至任一历史版本。恢复不覆盖当前内容，而是将当前状态自动保存为一个新版本后再回滚，保证恢复操作本身可撤销」。验收：「当用户恢复至 2 小时前的版本后，画布内容应与该版本一致，且版本时间轴顶部新增一条『恢复自某版本』的记录」 | 服务端（`apps/server/test/versions.e2e-spec.ts` 恢复组，:234 起）：:360「恢复：live 文档——REST 恢复后 WS 在线端收到回滚内容（恢复广播）」（恢复 200 返回 preRestoreVersionId → 在线端 doc 轮询回滚至『早期文本』；**pre_restore 行先于恢复落行**：type='pre_restore'、restoredFrom=来源版本 id、createdBy=恢复人、state=恢复前『漂移文本』；files.docState 随防抖落库为恢复后内容；version_restore 事件落 events 表）；:395「恢复：无人在线——走落库路径，GET docState 与快照一致」（**快照中被删节点以新 ULID 重建，故按文本而非旧 id 断言**）；:423「恢复权限：非 owner/editor 404；未登录 401；版本 id 属其他文件 404」（editor 可恢复、viewer/路人 404 不泄露、跨文件版本 404）；:462「列表/取态：canAccess 可读，含 createdByName」；:509「dev 快照路由（Task 8）：live 脏文档 POST 即落 auto 行」（NODE_ENV!=='production' 才生效）；:538「events 端点：POST /api/events 登录 204 且落库；未登录 401」。浏览器（`apps/web/e2e/versions.e2e.spec.ts:50`「版本面板：时间轴/只读预览/一键恢复」）：改周一→计划B → dev 快照 v1 → 改计划C → v2 → 面板两条时间轴（「自动」徽标）→ 只读预览第二条（本周计划＋计划B 在、计划C 不在）→ 恢复（confirm 文案含『当前内容将自动存档为「恢复前版本」』＋条目同款时间）→ toast「已恢复」→ **画布经 y-sync 恢复广播回滚（计划B 回归、计划C 消失、页面不 reload**——`__gmindNoReload` 存活断言）→ 列表刷新顶部出现「恢复前存档」条目。实现：`packages/gmind-core/src/restore.ts:67` restoreFromSnapshot（:22 ORIGIN_RESTORE；:134 withTransaction 单事务；:149 缺失节点 addChild 新 ULID 重建）；`apps/server/src/versions/versions.service.ts:92` restore（:104 先写 pre_restore 再恢复；:107/:127 withLiveDocument live 广播/离线落库双路径；:141 version_restore 埋点尽力而为）；versions.controller.ts:20/:25/:34/:52（REST 层级隶属文件资源）；`apps/server/src/database/migrations/20260926000000-versions-restored-from.ts:12`（restored_from char(26) NULL）；VersionPanel.tsx:234 restore / :256 面板 / :281-283 **restoredFrom 非空时徽标 title=「恢复自某版本」**（PRD 字面文案由 title 属性承载） | 「恢复至 2 小时前」的字面时长未造件（快照即时造数，恢复语义与时长无关）；**双机恢复广播体验**（A 恢复、B 在第二台设备实时看到画布回滚）待人工——web e2e :50 已在单机覆盖 y-sync 广播回滚链路，跨机网络层见手动清单 2 | **通过（server 6 例 ：360~:538 ＋ web 1 例）＋待手动核验（双机广播体验）**。备注如实：①PRD「时间轴顶部新增一条『恢复自某版本』的记录」以 **pre_restore 类型条目（徽标「恢复前存档」＋title「恢复自某版本」＋restored_from 溯源列）** 承载——语义等价（恢复前内容自动存档、恢复可撤销），徽标字面为「恢复前存档」，口径登记非隐藏项；②T7 裁定——恢复双跑幂等=内容恒收敛非 id 稳定（被删节点以新 ULID 重建）；③**恢复×评论产品裁定登记**：恢复重建的节点为新 ULID、不回链旧评论——旧节点上的评论线程按 M3b 既有语义呈「原节点已删除」并保留全文（CommentPanel nodeDeleted 徽标），恢复不复活评论锚点，产品已知晓该行为；④T7 deferred——events payload 无尺寸上界（TEXT 64KB 界限内可 500，建议几 KB cap）；零 diff 恢复仍写 pre_restore 行（计划字面时序） |

## 九、M3b 缺口清偿小包四项落地证明（f084707）

| 项 | 要求 | 实现位置 | 守卫测试（当日通过） | 状态 |
| --- | --- | --- | --- | --- |
| 摘要邮件含跳转链接 | FR-CMT-006 验收「应收到一封含跳转链接的邮件」——M3b 登记正文仅条目列表无链接 | `apps/server/src/jobs/digest.service.ts:90`（条目行附 `${WEB_ORIGIN}/edit/:fileId` 深链）/ :101（正文尾部统一「打开 Gmind」入口行）；`apps/server/src/config/env.ts:26` WEB_ORIGIN 缺省跟随本机 web dev 端口 | `notify.e2e-spec.ts:435`「清偿：摘要邮件条目含跳转链接与『打开 Gmind』行」——body 断言 `- [提及] 阿乙：这条要能点回文档 — http://localhost:5174/edit/{fileId}` ＋ `打开 Gmind：http://localhost:5174` | **已落地**（真实送达仍待 MailHog 环境，同 M3b 口径） |
| 加入通知（join/回填 → owner） | FR-CMT-006「权限变更」事件通知——M3b 登记无通知生产者 | `apps/server/src/share/invite.service.ts:145` notifyOwnersJoined（真实新增协作者行才通知——重复 join/并发败者不重发，T10 裁定收敛为单条件） | `notify.e2e-spec.ts:296`「清偿：join 后 owner 收 permission 通知（SSE + unread）」——路人凭 token join → owner SSE 实时推送＋unread +1；`share.e2e-spec.ts:419`「M4 清偿：邀请回填成功 → owner 收 permission 通知（payload.memberName/action=joined）」 | **已落地**（web 下拉 permission 类型显示通用「通知」标签——TYPE_LABELS 未专用化，T10 裁定范围内合规，登记见诚实登记节） |
| 通知深链 ?node= | 通知点击跳文档后无法定位到被提及/被回复的节点 | `apps/web/src/pages/WorkspacePage.tsx:143/:158`（通知 payload 携带 nodeId → `/edit/:fileId?node=:nodeId`）；`apps/web/src/pages/EditorPage.tsx:1300`（装载完成后读 ?node=<ulid>，有效则 locateNode 定位——同评论面板「选中＋展开折叠祖先」口径） | `apps/web/e2e/notify.e2e.spec.ts:110`「M4 清偿：通知点击深链 ?node= → 装载后定位对应节点并清参」（定位选中生效、URL 参数清除） | **已落地**（deferred：深链 e2e 硬依赖种子文案） |
| isDuplicateKeyError 收敛 | M3b 各域各自手写 duplicate-key 判定，口径漂移风险 | `apps/server/src/utils/duplicate-key.ts:6` isDuplicateKeyError（统一 ER_DUP_ENTRY/errno 1062 判定）；三消费方：`files.service.ts:561`（star 竞态）/ `invite.service.ts:127`（回填并发败者）/ `share.service.ts:107`（join 并发败者） | 既有守卫不回归（当日全量绿）：`files-views.e2e-spec.ts` star 竞态用例、`share.e2e-spec.ts` join/回填幂等用例、准入 7.10 故障注入 :457——三路径并发败者 no-op 语义不变 | **已落地** |

## 诚实登记——缺口与延期项台账（全部为「未实现/待环境/待手动」，如实列出防口径漂移）

以下各条来自 M4 各任务评审台账（progress.md）与上文逐 FR 表，汇总于此便于终审复核：

1. **导入图片不入库**：.xmind 内嵌图按 media 降级计数、不提取入库（FR-IO-002 口径，计划 Global Constraints 明确「导入图片对象提取」不做）。
2. **摘要邮件待 MailHog 环境核验**：摘要跳转链接（:435）为 MailService 层断言，端到端送达接通 MailHog 后人工核验（M3b 既有口径延续）。
3. **FR-IO-003 JPG 白底/透明底视觉、倍率清晰度待手动**：JPG 导出零自动化用例（mime/成功/白底均无 e2e 或单测，T9 deferred「inlineImages/rasterize/JPG 白底无自动化覆盖」如实保留）。
4. **FR-VER-001 真实 3 分钟墙钟节奏以注入时钟等价验证**（真实时长待手动）：见第七节手动核验步骤。
5. **恢复×评论「原节点已删除」产品裁定**：恢复重建节点为新 ULID、不回链旧评论，旧节点评论按 M3b nodeDeleted 语义保留全文（产品知晓，见第八节备注③）。
6. **web 通知下拉 permission 类型显示通用「通知」标签**：TYPE_LABELS 服务端未动、未专用化（T10 裁定：范围内合规，登记差异）。
7. **e2e 偶发抖动（历史台账，本日未复现）**：T4 期间 server files-views 2/14、share 域 >50 用例偶发 404、web collab 离线用例各偶发一次——6 次插桩全量未复现，另行排查；**本日全量首跑全绿无重跑**。
8. **dev DB 长驻＋手动迁移漂移模式**：T8 实测发生一次（dev 库缺 T6 restored_from 迁移致 web e2e 失败），已 `migration:run` 修复；该模式会重演——dev 长驻环境跑验收前先 `pnpm --filter @gmind/server migration:run` 确认齐平（已列入手动清单 6）。
9. **events payload 无尺寸上界**（T7 deferred）：TEXT 64KB 界限内可 500，建议几 KB cap（非阻塞）。
10. 其余 minors 延期项随任务台账留档（T1 trash spec 清理假设/回填 catch 丢上下文；T3 detached 子树降级不计数；T4 walk 在 try/catch 外；T6 脏标志 TOCTOU；T8 面板关闭预览未清/恢复成功＋刷新失败误报 toast；T9 画布像素无上限/checkbox 语义；T10 回填通知未滤软删文件等）——均非验收项阻塞，终审裁量。

## 支撑输出（2026-09-26 本会话全量实测；dev 服务器 :3001/:5174 全程共用未重启）

- `pnpm lint`：exit 0，无输出。
- `pnpm typecheck`：server / web / engine / gmind-core / shared / **xmind-io** 六包全部 Done，exit 0。
- `pnpm test`（全仓单测）：**444 passed**，Test Files 34 passed，exit 0——@gmind/shared 5（1 文件）、@gmind/xmind-io **22**（3 文件：parse 18＋build 2＋roundtrip 2）、@gmind/gmind-core 160（11 文件）、@gmind/server 18（5 文件）、@gmind/engine **212**（11 文件，含 export.test 2 例 :34/:53）、@gmind/web 27（3 文件，含 **xmind-import 8 例** :16~:85）。
- `pnpm --filter @gmind/server test:e2e`：Test Files **14 passed (14)**，Tests **156 passed (156)**，15.88s，exit 0——auth 8 / files 4 / db-init 2 / users-me 2 / **file-content 19**（含 XMind 导入 3 例 :501/:526/:540）/ storage 12 / collab 6 / files-views 24 / folders 13 / **trash 10**（含准入 7.11 守卫 :344）/ **share 23**（含准入 7.10 守卫 :512＋清偿 ：419/:457）/ comments 8 / **notify 15**（含清偿 ：296/:435）/ **versions 10**（快照 4＋恢复权限列表 dev 路由 events 6）。首跑全绿。**终审修复轮后为 157/157**（versions 增列表上限用例，连续 4 次全绿，见终审修复轮节）。观察到的 stderr 噪音（不判失败）：套件收尾阶段一条 `[collab] 卸载快照失败（…）Connection is not established`——测试 app 关闭与 beforeUnloadDocument 卸载兜底的拆链竞态，属用例收尾时序噪音，断言零失败。
- `WEB_PORT=5174 API_ORIGIN=http://localhost:3001 pnpm --filter @gmind/web e2e`：**66 passed, 1 skipped (21.5s)**，0 failed，exit 0——workspace 14 / collab 7（含准入 7.3 接线守卫）/ editor 12 / rich-content 8 / **import-export 5**（导入 2＋往返 1＋PNG 2，:43/:63/:115/:159/:185）/ m1-gaps 6 / m0-acceptance 3 / share 3 / comments 3 / **member-invite 2**（:46/:64）/ **notify 2**（:53＋清偿深链 ：110）/ **versions 1**（:50）/ perf-editor 1 skipped（须 PERF=1，同 M1~M3b 口径）。首跑全绿。**终审修复轮后为 68 passed, 1 skipped**（import-export 6 增 JPG 冒烟、versions 2 增面板重开预览回归，见终审修复轮节）。

## 终审修复轮（2026-09-26，全分支终审 With fixes → 单修复波 → 复审全 ADDRESSED）

- 全分支终审（base 266f6d0..56d5ff7，13 commits）：**0 Critical / 2 Important**，判定 With fixes——①versions 列表逐行拉取 LONGBLOB state 且无分页（生产唯一实际痛点）；②版本面板关闭后预览态残留（重开空白预览对话框）。跨任务接缝（快照×恢复脏标志、导入配额咽喉点、降级计数贯通、dev 路由生产泄漏、导出菜单行为）逐项核查通过。
- 修复波（1244ef6，单提交）：①list() 只取元数据列 + take(200) 上限（PRD 口径「最近 90 天」，分页/加载更多随 M5 面板打磨做产品裁定；单版本取态端点不变；e2e 201 行断言恰取最新 200 且响应无 state 键）；②面板 open→false 重置预览态（销毁 previewDoc，docstring 改为如实描述；e2e 开预览→关面板→重开→再预览断言内容渲染）；③JPG 导出冒烟 e2e（FF D8 FF 魔数＋尺寸＋.jpg 文件名）。修复后 server e2e 157/157 连续 4 次全绿、web e2e 68 passed/1 skipped。
- 范围化复审：三项发现 **全部 ADDRESSED**，修复 diff 无新破损。挂账至 M5（复审产出）：预览遮罩（z-1300）盖住面板关闭钮——预览开着时指针无法关面板（交互是否调整留产品决策）；versions take(200) 无加载更多（超限历史仅可按 id 取态）；e2e 套件在机器高负载下有整体超时敏感（一次 17 例超时、时长 14s→494s 摆动，隔离环境项）。
- 终审裁量其余 7 项缓期 minor 为 PARKED（快照脏标志 TOCTOU、events payload 上界、零 diff 恢复仍写 pre_restore、导入 copy 路径收紧、导出树无环防护、回填通知软删过滤、邀请计数含 skipped 等），随 M5 触及对应文件时顺带清偿。

## M4 验收结论与手动核验清单（如实记录）

- 逐项结论：**FR-IO-001、FR-IO-004、FR-IO-005 三项通过**（FR-IO-001 带 25MB→21MB 等价边界与单入口口径注明；FR-IO-004 的折叠展开为数据层天然满足＋注释引用；FR-IO-005 导出侧为防御分支无独立 e2e——均如实注明）；**FR-IO-002 通过（单测）＋待手动核验**（降级 toast 组装与视觉）；**FR-VER-001 通过＋待手动核验**（真实墙钟节奏）；**FR-VER-004 通过＋待手动核验**（双机广播体验）；**FR-IO-003 部分达成**（PNG 主链路自动化全过；JPG 冒烟自动化已随终审修复轮补齐——魔数/尺寸/文件名，像素视觉仍待手动）。准入台账 **§7.10/7.11 全部已收口**（台账注记本日复核一致）；M3b 缺口清偿小包**四项全部落地**。FR-VER-002（三期）/FR-VER-003（二期）/PDF·SVG·FreeMind·Markdown·OPML·TXT 格式（二期/三期）/导入图片提取按里程碑边界明确不做。无一虚构「通过」，全部缺口逐条登记（见诚实登记节）。
- 全量回归当日真实执行（数字见上节）：lint/typecheck exit 0、单测 444 passed、server e2e 156/156（修复轮后 157/157）、web e2e 66 passed ＋ 1 skipped（修复轮后 68＋1），0 failed——**五个门禁全部首次连跑全绿，无重跑挑数**。
- **待手动核验清单（真实操作，累计 ≈15 分钟）**：
  1. **导出图片视觉**：编辑器导出菜单分别导出透明底 PNG（勾选默认开）、白底 JPG、1x/2x/3x 各一份——目视透明底棋盘格背景、JPG 白底、倍率清晰度递增；文件名 `<标题>.png/jpg`。web e2e（import-export.e2e.spec.ts:159/:185）已覆盖 PNG 尺寸/折叠链路，像素视觉与 JPG 全量待人工。
  2. **双机恢复广播体验**（两台设备/跨网络）：A、B 同开一文档 → B 观察画布 → A 打开版本面板对历史条目点恢复 → B 端画布**不刷新**实时回滚至快照内容；A 端面板顶部出现「恢复前存档」。web e2e（versions.e2e.spec.ts:50）已在单机覆盖同链路（y-sync 广播＋无 reload 断言），跨机网络层待人工。
  3. **版本面板预览视觉**：时间轴徽标（自动/恢复前存档）、只读预览画布渲染、恢复 confirm 文案目视。
  4. **邮件送达（MailHog 待环境）**：接通后核验三封——邀请邮件（含注册链接）、15 分钟未读摘要（**含条目深链与「打开 Gmind」行**，M4 清偿后口径）、回收站到期提醒（**单封**，7.11 已去重）。
  5. **真实 .xmind 文件导入**：用 XMind 客户端（**XMind 8 与 2020+ 各导一份**）导出含样式/图片/备注的真实文件，经工作台导入——验证双路径解析、降级 toast 弹出（可与 FR-IO-002 手动项合并）、节点文本层级完整。e2e 夹具为程序化 zip，真实文件兼容性属人工项。
  6. **dev 环境迁移齐平（流程项）**：dev 库长驻环境验收前 `pnpm --filter @gmind/server migration:run` 确认 restored_from 迁移已应用（T8 曾实测漂移一次，模式会重演）。
- 口径边界（同 M1~M3b 纪律）：以上自动化断言均为本机 dev 实测（单次全量连跑全绿，无重跑挑数）；「待手动核验」各项背后均有当日通过的自动化覆盖同链路（JPG 像素视觉除外——冒烟自动化在位，视觉待手动，已按「部分达成」如实分级），人工步骤为跨机网络/视觉/体感/环境/真实文件补充。已登记缺口（FR-IO-002 toast 组装、FR-IO-003 JPG 视觉、导入图片不入库、permission 通用标签、恢复×评论新 ULID 裁定等）均为「未实现/待环境/待手动、如实列出」，后续排期由需求方裁定。
