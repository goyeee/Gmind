# M5 验收清单（PRD 6.5.1 全量 NFR-P0 ＋ M5 七任务交付 ＋ M2 准入台账 §7.5/7.6/7.7 状态回写）

核验日期：2026-09-26。对照《Gmind_在线协作脑图软件_产品需求文档.md》6.3 NFR 编号逐条列示；「结果」列为当日实测输出与本仓源码核对后如实填写（本会话逐条执行/核对——全部 e2e 用例名与行号、实现位置行号均当日 grep 源码核实，非转抄历史报告；perf 数字为当日实跑，见 docs/perf-m5.md）。

验收环境：本机 dev（NestJS tsx `PORT=3001` ＋ vite `WEB_PORT=5174`，API_ORIGIN=http://localhost:3001；跑前 `migration:run` 确认 No migrations are pending——M4 登记的迁移齐平流程项）。开发环境验证码固定 `123456`。全量回归（单测＋服务端 E2E＋浏览器 E2E）与两项 perf 复跑全程共用该 dev 服务器（进程未重启）。

结果标记约定（同 M1~M4）：**通过**＝有当日通过的自动化用例/实测数字（注明出处）；**通过＋待手动核验**＝自动化已覆盖同链路、体验/视觉/跨机/真实墙钟须人工确认；**部分达成**＝已实现子项有通过证据、明确列出未实现缺口；**环境项待部署验收**＝本地 dev 形态无法核验、如实登记留生产部署；不虚构任何「通过」。

里程碑边界（M5 计划 Global Constraints「本计划不做」，防验收口径漂移）：NFR-USE-003 全键盘操作 / NFR-USE-004 色盲友好（P2，三期）；快捷键自定义（P2）；微信扫码登录真实对接（M0 DevProvider 裁定维持）；WACD 等 AARRR 指标看板与埋点完成率考核（上线运营期交付物，非本期）；NFR-SEC-001/002 的 TLS/落盘加密实测（本地 dev 为 HTTP 明文，生产部署核验项）；NFR-PERF-004 生产构建首屏基线（本测为 dev 参考值，留部署期）；通知偏好「按事件类型关闭站内」（PRD 明示站内不可关闭）。

## 一、逐 NFR-P0 表（PRD 6.3 P0 全量 16 项 ＋ USE-005 P1 一并收口）

| 编号 | 验收项（PRD 原文语义） | 当日证据（实跑/grep 核实） | 手动核验（自动化未覆盖部分） | 结果 |
| --- | --- | --- | --- | --- |
| NFR-PERF-001 | 单文档 ≥500 节点连续编辑（增删改、拖拽、折叠、缩放）帧率 ≥40fps；画布显性展示当前节点计数 | 当日两次独立复跑（`PERF=1 perf-editor.spec.ts:135`，499+root=500 节点、30s 混合编辑 i%4 轮转）：中位 FPS **60.0 / 60.0**（阈值 40，余量 1.5×）、失败 0、存活节点 500/499——docs/perf-m5.md §二，与 M1 基线逐位吻合无回归。节点计数显性展示：`apps/web/src/pages/EditorPage.tsx:939-942`（脚标 `countAliveReachable`，与服务端配额同口径） | 发布验收须在 spec §6.1.1 基准机重跑（perf-m1/m5 口径边界） | **通过** |
| NFR-PERF-003 | 单人编辑任意操作触发→画面完成更新 P95 <0.1s | 同上两轮：操作延迟 **P95=22.2ms / 22.2ms**（P50 16.5/16.6ms，一帧内；阈值 100ms，余量 4.5×）——覆盖 op→rAF layout+renderScene 完整管线（perf-m1.md 方法节）。灰度环境埋点采样为运营期口径（PRD 验收方式后半句），登记不做 | 同上 | **通过**（本机 dev 实测；PRD「灰度采样」留运营期） |
| NFR-PERF-004 | ≤500 节点从打开链接到画布可交互首屏 P75 <3s（20Mbps） | 当日 dev 一次性测量（临时 playwright 工具，跑毕即删；方法与数字入 docs/perf-m5.md §三）：工作台 P75 **58ms**、编辑器（种子文档）P75 **73ms**、冷缓存（CDP 禁缓存）P75 60/59ms、应用自身 `perf_metric.firstInteractionMs` 10 次装载 52~74ms 交叉互恰 | **口径如实登记**：本测为 vite dev（非生产构建）＋环回无节流＋headless 无 FCP 记录——生产构建基线（Web Vitals FCP/LCP＋20Mbps 节流）留部署期验收 | **环境项待部署验收**（dev 参考值在档，不据此声明 P0 达标） |
| NFR-PERF-005 | 同文档 ≥50 人在线，任一操作端到端 P95 <100ms | 当日两次独立运行（`apps/server/tools/latency-bots.mjs`，各全新 token/文件）：**P95=6.8ms / 6.9ms**（P50 2.2/2.2ms，P99 9.0/9.3ms，MAX 23.8/33.8ms），50 bot、写失败 0、鉴权失败 0、退出码 0——docs/perf-m5.md §一；较 M2 基线 P95 2.3~3.7ms 抬至 ~7ms（M4/M5 协同路径改动后），余量仍 ≈14×，无退化性回归 | 同 PERF-001：基准机重跑；跨机轮 P95 预期由网络 RTT 主导 | **通过** |
| NFR-PERF-007 | 编辑停顿后 2s 内触发增量自动保存；失败顶栏显性提示＋本地暂存，网络恢复自动重试 | 防抖：`apps/web/src/editor/saveLoop.ts:34`（DEBOUNCE_MS=2000，重试 1s/2s/4s 退避）＋ WS 侧 onStoreDocument 防抖（collab.service）。e2e：`editor.e2e.spec.ts:53`（Tab 新建→「保存中…」→「已保存」两态断言 ：62-66）、:68/:71（刷新持久）、:132（卸载冲刷保存）、`collab.e2e.spec.ts:89`（断网编辑→离线态→恢复联网自动同步回「已保存」）；单测：`saveLoop.test.ts:179`（重试耗尽 error_occur save-fail→成功收尾 recovered:true 成对）、:153（409 终态文案）、:120（PUT 带 baseUpdatedAt）。本地暂存＝y-indexeddb（`collab.e2e.spec.ts:119` 离线刷新后从 IndexedDB 恢复） | 弱网真实体感（限速工具）可人工补测；自动化已覆盖断网编排（REST+WS 双通道确定性断开） | **通过** |
| NFR-SEC-001 | 全站强制 TLS 1.2+，HTTP→301 HTTPS，WebSocket WSS | **环境项如实登记**：本地 dev 全链路 HTTP/ws 明文（`http://localhost:5174` → `ws://…:3001/collab`），TLS 终止、301 跳转与 WSS 均为部署形态——本地无法核验，**留生产部署验收**（安全扫描＋抓包）。无代码动作可背书，不写通过 | 生产部署后抓包核验 | **环境项待部署验收** |
| NFR-SEC-002 | 文档/快照/回收站落盘 AES-256 加密，密钥 KMS 托管轮换 | **环境项如实登记**：本地 MySQL 为 dev 明文落盘（docState TEXT/LONGBLOB），无 KMS 接入——**留生产部署验收**（存储层审计＋渗透测试）。当前仅有的存储安全面：图片走 MinIO Provider、密码 bcryptjs hash（users.service.ts:97），均非本条口径 | 生产部署后存储审计 | **环境项待部署验收** |
| NFR-SEC-003 | 所有文档读写接口服务端逐请求校验身份与权限；无权限 403/404 且不泄露存在性；一期「登录即可编辑」简化 | 当日 grep 汇总既有越权面（全部当日通过，404 同口径「文件不存在」不泄露）：REST——files `files-views.e2e-spec.ts:241`（非 owner 删除 404）/:430（复制：无权与不存在一律 404）/:519（星标 carry-in 过滤）、`file-content.e2e-spec.ts:98`（非相关用户读取 404）/:239（已删文件读/写/改名/打开全 404）、folders `:265`（他人文件夹 PATCH/DELETE 404）、share `share.e2e-spec.ts:103`（非 owner 创建 404）/:238（非 owner DELETE 404）/:325（非 owner 批量邀请 404）、comments `comments.e2e-spec.ts:174`（非协作者 GET/POST/回复 与不存在同口径）、storage `storage.e2e-spec.ts:171/:180/:196`（非协作者上传/copy 404 三向）、versions `versions.e2e-spec.ts:423`（恢复：非 owner/editor 404、未登录 401、跨文件版本 404）/:462（其他文件版本 404）、trash `trash.e2e-spec.ts:113`（非拥有者还原/彻底删 404）、notify `notify.e2e-spec.ts:137`（collaborators 无权限 404）/:290（未登录 401 三端点）；SSE——`notify.e2e-spec.ts:154`（token 缺失/无效 401 JSON）；**WS 网关**——`collab.e2e-spec.ts:166`（无/伪造 token 拒）/:180（非协作者与不存在文件同口径 permission-denied）。简化口径＝PRD 原文明示「一期按登录即可编辑简化校验，四级权限逐请求校验二期启用」 | 二期四级权限模型（FR-SHR 三级权限完整态）不在一期 | **通过**（一期简化口径下，REST+SSE+WS 三通道越权面当日全绿） |
| NFR-SEC-006 | 所有用户输入（节点文本、评论、文件名）服务端统一转义与 XSS 过滤，富文本白名单渲染 | 结构性安全（当日 grep 核实）：`apps/web/src` 全量 **零** innerHTML/dangerouslySetInnerHTML 命中——节点文本经 SVG DOM API（`packages/engine/src/render.ts:258` tspan.textContent；:333 备注 `<title>` 预览），评论/列表均为 React JSX 文本节点（框架转义）；链接白名单（http/https，`javascript:` 零写入拒绝）——`rich-content.e2e.spec.ts:65`「富内容：https 链接显示角标，javascript: 提示错误且不写入」（:73 注入 `javascript:alert(1)` 断言被拒）；SQL 侧 LIKE 通配符 `%`/`_` 转义——`files-views.e2e-spec.ts:710`。**备注如实**：PRD 验收方式「XSS 注入测试集」未建专项矩阵（节点文本/评论/文件名三面无集中注入用例），现判定依据＝渲染层结构安全＋相邻用例，缺口登记见诚实登记节 | 专项注入集补建后可复核（非阻塞） | **通过（结构安全＋相邻用例）＋登记缺口（专项注入集未建）** |
| NFR-REL-002 | 编辑内容秒级自动保存；任何情况下丢失不超过最近 3s 操作 | 证据链（当日通过）：2s 防抖常量（saveLoop.ts:34）＋WS persisted ack；断网/崩溃兜底＝y-indexeddb 本地副本（`collab.e2e.spec.ts:89` 断网编辑恢复、:119 离线刷新从 IndexedDB 恢复、:166 恢复无重复）；陈旧写序守卫（准入 7.1）——`file-content.e2e-spec.ts:365`（活跃内存 doc＋旧 base PUT→409，WS 侧新编辑保留不被覆盖）/:403（base 不旧放行）＋`saveLoop.test.ts:120`（PUT body 携带 baseUpdatedAt）。**口径如实**：「≤3s 丢失窗」的灾难注入（防抖窗口内 kill -9 后重启比对）未做专项——以「防抖 2s＋本地 IndexedDB 副本先行」的语义组合钉死，真实灾难演练留手动 | 可选：防抖窗口内强杀进程重启比对（手动项 6 邻接） | **通过（e2e 语义组合）＋待手动核验（灾难注入）** |
| NFR-REL-003 | 每 3 分钟自动快照，保留 ≥90 天，可预览恢复任意快照 | `apps/server/test/versions.e2e-spec.ts`（注入时钟直调）：:139（过窗落 auto 行）、:160（无变更不落/间隔内不重复）、:175（卸载兜底）、:199（90 天清理：-91d 删/-89d 留）；列表上限 :509；预览/恢复 UI `apps/web/e2e/versions.e2e.spec.ts:50`/:117/:163（M4 验收口径延续，当日全绿） | 真实 3 分钟墙钟节奏（M4 已登记，同款挂机观察） | **通过（注入时钟）＋待手动核验（真实墙钟）** |
| NFR-REL-004 | 回收站保留 30 天可一键还原；到期前 3 天提醒所有者 | `trash.e2e-spec.ts`：:237（runCleanup +30d 满期自动清除）、:255（+27d 剩 3 天提醒一次、幂等）、:294（提醒 payload 可直接驱动还原）、:307（再删周期：还原清旧提醒后再删新窗再提醒）、:345（提醒单封，准入 7.11）；还原 UI＝通知中心死链还原（workspace/notify 域既有用例）；彻底删除二次确认 `workspace.e2e.spec.ts:134` | 邮件送达（MailHog 待环境，手动项 3） | **通过（注入时钟）**；邮件待环境 |
| NFR-REL-005 | CRDT 自动合并不丢数据；合并失败保留双方分支并提示 | `packages/gmind-core/src/chaos.test.ts`（当日通过，NFR-REL-005 注释头 :22）：:373（10 轮×3 端×2-3 随机操作、两两交换收敛三件套）、:381（同节点并发写 LWW 唯一胜者）、:403（移动 vs 级联删→墓碑且无残留引用）、:425（并发换父 LWW 定胜者）、:450（墓碑上编辑：墓碑胜出、编辑键并存）；浏览器层守卫 `collab.e2e.spec.ts:447`（双页并发结构操作收敛，准入 7.3）。**口径登记**：「合并失败保留双方分支并提示」子句——CRDT 收敛为数学性质、无「合并失败」分支，防御性子句在一期无对应实现（PRD 风险表缓解措施即本混沌套件） | — | **通过（混沌套件）**；防御性子句登记口径 |
| NFR-USE-001 | 首次进入产品 ≤3 步交互式引导（创建文档/添加节点/邀请协作），每步可跳过；完成率埋点追踪 | `apps/web/e2e/guide.e2e.spec.ts`（当日通过）：:46「新用户进入工作台出现引导，走完三步写 localStorage 并上报 guide_finish」（三步卡片+`guide-step-1|2|3`+下一步+完成态）、:74「中途跳过：立即结束并上报 skipped=true（stepsDone=当前步），刷新不再出现」。实现 `GuideOverlay.tsx:16-17`（GUIDE_DONE_KEY=gmind.guide.done）/:61（写键+埋点恰一次）。**登记**：①触发口径=localStorage 缺键（浏览器本地、跨设备不重复——PRD 未定义跨端口径，M5 裁定登记）；②「完成率 ≥60%」为真实流量运营指标，依赖埋点数据回看（WACD 边界内，上线期考核） | 引导视觉/高亮形态目视（自动化断言步骤可走可跳+埋点） | **通过**；完成率指标留运营期 |
| NFR-USE-002 | 快捷键速查面板（Ctrl+? 唤起，macOS Cmd+?），完整列出全部快捷键，可搜索 | `apps/web/e2e/help-panel.e2e.spec.ts`（当日通过）：:33「Ctrl+? 打开→三分组/Windows 键位→搜索折叠过滤→Escape 关闭」、:74「工具栏按钮开合＋macOS 平台显示 ⌘ 键位＋× 关闭」。同源守卫（`keyboardMap.test.ts`，当日通过 6 例）：:34（清单存在/id·label 唯一）、:45（节点编辑/视图/文件三分组非空）、:52（**id 集合===绑定实际处理集合**，防清单漂移）、:62（Ctrl+/ 折叠 vs Ctrl+? 帮助两形态不冲突）；清单=SHORTCUT_LIST 15 条（`keyboardMap.ts:56`，与 attachKeyboardMap 同文件同源，当日 grep 计 15 条） | 面板抽屉视觉目视 | **通过** |
| NFR-USE-005（P1 一并收口） | 所有操作失败提示＝失败原因＋可执行下一步；禁止仅「操作失败」 | `apps/web/e2e/error-copy.e2e.spec.ts` 集中走查 10 分支（当日通过 11 例）：:67①断网离线文案、:80②配额拦截（常量级）、:88③404「可能已被删除或无权限」＋返回工作台、:101④401「请重新登录」＋清 token、:115⑤分享失效页、:126⑥导入三归因、:152⑦导出过大、:163⑧a 评论 500 字、:176⑧b 图片 10MB、:192⑨邀请批量逐条原因、:206⑩改绑被占 409。**走查驱动的 401 快照竞态修复**：`api/client.ts:27-31`（请求时刻取 token 快照——并发 401 后文案分支不可达的根因修复，当日 ④ 例背书）。裁定登记：服务端 404/409 message 不动（存在性不泄露＋逐字断言面），「下一步」半句全落 web 层按状态码分流 | — | **通过（10 分支逐例断言）** |

## 二、M5 七任务交付表

| 任务 | 交付内容 | 实现位置（当日 grep 核实） | 守卫测试（当日通过） | 状态 |
| --- | --- | --- | --- | --- |
| T1 账号设置页 | FR-ACC-002 收口：改密/换绑；FR-CMT-006 偏好收口：邮件 opt-out（mention/reply/permission 三类，system 恒发、站内不可关） | `apps/server/src/users/users.controller.ts:20/:27/:34/:39`（password/rebind/notify-prefs GET·PATCH）、`users.service.ts:78-101`（改密：有密码验旧/无密码验证码，bcrypt :97）/:103-108+（换绑 zod 同登录口径）/:128/:135（prefs 落 notify_prefs JSON 列）；digest 过滤 `jobs/digest.service.ts:70/:87-90`（opt-out 行滤除且回写 emailed_at，system 豁免）；web `SettingsPage.tsx`（三区卡片、开关即 PATCH :131）、路由 `App.tsx:48`、工作台入口 `WorkspacePage.tsx:458`（settings-entry） | server `users.e2e-spec.ts` 14 例（:74 未登录 401、:82/:102 prefs round-trip 与非法成员 400、:117~:181 改密五形态、:191~:243 换绑四形态、:335/:364 digest opt-out 过滤与对照）；web `settings.e2e.spec.ts` 4 例（:26 入口+无密码验证码形态、:44 旧密码形态、:60 换绑成功 toast、:72 偏好切换刷新保持） | **通过** |
| T2 快捷键帮助面板 | NFR-USE-002（见上表行）；SHORTCUT_LIST 同源 15 条 | `apps/web/src/editor/keyboardMap.ts:41`（ShortcutItem）/:56（SHORTCUT_LIST 15 条）/:84（handledActionIds）；`HelpPanel.tsx`（抽屉+搜索+平台键位）；EditorPage 装配与 opener=mod+Shift+/（真 Ctrl+?，评审核实与既有折叠 Ctrl+/ 冲突的「修复而非回归」） | `keyboardMap.test.ts` 6 例（:34/:45/:52/:62/:77/:88）；`help-panel.e2e.spec.ts` 2 例（:33/:74） | **通过** |
| T3 三步新手引导 | NFR-USE-001（见上表行） | `apps/web/src/pages/GuideOverlay.tsx:16-17`（键+触发口径）/:26（guide_finish → track()）/:61（完成写键恰一次）；WorkspacePage 装配 | `guide.e2e.spec.ts` 2 例（:46/:74） | **通过** |
| T4 埋点补全 | PRD 6.4 十一事件全清单＋payload 10KB 上界（M4 挂账清偿）；公共参数 clientVersion/sessionId（`api/events.ts:23-36`，sessionId=sessionStorage 惰性 UUID（crypto.randomUUID）） | 见下「埋点 11 事件对照表」；上界 `apps/server/src/events/event.schema.ts:13/:20`（MAX_EVENT_PAYLOAD_CHARS=10_000，refine 序列化长度） | 各域 e2e＋web telemetry（见对照表）；payload 超限 `versions.e2e-spec.ts:600`（>10KB→400「事件数据过大」） | **通过**（export_done 无专属断言——登记） |
| T5 移动端只读+评论 | OPEN-T-005：≤768px 只读装配（画布/平移/缩放/折叠/评论保留，编辑控件不装配）；**客户端能力降级非安全边界**（服务端不拒移动端写——登记） | `apps/web/src/editor/useIsMobileViewport.ts:16`（matchMedia 监听）；`EditorPage.tsx:183`（readOnly）/:866（双击不进编辑）/:877（长按右键拦）/:1058/:1270（写键位不挂载）/:1298（画布粘贴禁）/:1389/:1585（工具栏/面板分支）/:1623（右键菜单不渲染） | `mobile-readonly.e2e.spec.ts` 5 例（:65 控件不装配+保留返回/标题/保存态、:85 写交互禁用、:104 折叠徽标可点+跨断点即时降级、:122 评论开关+发表+角标过滤、:154 桌面回归控件齐全） | **通过**（iOS 捏合/折叠入口两处如实登记，见诚实登记） |
| T6 M4 挂账清偿包 | 7 项集中清偿（终审 PARKED 面） | 逐项见下「M4 挂账清偿表」 | 逐项守卫当日通过 | **已落地**（2 项维持 PARKED：零 diff 恢复仍写 pre_restore、导入 copy 路径收紧——终审裁量维持） |
| T7 错误文案走查 | NFR-USE-005（见上表行）＋401 快照竞态修复 | `error-copy.e2e.spec.ts` 10 分支＋`api/client.ts:27-45` | 11 例当日通过 | **通过** |

### 埋点 11 事件对照表（事件 × 生产点 × 测试，全部当日 grep/实跑核实）

| 事件（PRD 6.4） | 生产点 | 测试（当日通过） |
| --- | --- | --- |
| doc_create | `files.service.ts:162`（entry=blank/import/copy/seed） | `files.e2e-spec.ts:92`（四入口区分） |
| node_add | `EditorPage.tsx:502`（右键 context）/:553（键盘）/:720（粘贴） | `telemetry.e2e.spec.ts:79`（键盘 via=keyboard+公共参数断言 :39-41）/:125（右键 via=context） |
| node_delete | `EditorPage.tsx:596`/:683（含 cut 路径） | `telemetry.e2e.spec.ts:79`/:107（Ctrl+X 同 via=keyboard）/:125 |
| invite_send | `share.service.ts:58`（channel=link）＋`invite.service.ts:101`（channel=member,count=实写行数） | `share.e2e-spec.ts:566`（link+幂等不重落）/:606（member 按批一条、全 skip 不落） |
| collab_join | `share.service.ts:125`（viaRegistration=false）＋`invite.service.ts:158`（注册回填 true） | `share.e2e-spec.ts:581`（join 幂等/owner 不落）/:623（回填逐文件一行） |
| comment_create | `comments.service.ts:184`（hasMention 按归一化 mentions） | `comments.e2e-spec.ts:368` |
| guide_finish | `GuideOverlay.tsx:26`（stepsDone/skipped/elapsedMs） | `guide.e2e.spec.ts:46`/:74 |
| export_done | `EditorPage.tsx:357`（format/scale） | **无专属自动化断言**——生产点在位（图片导出 e2e 断言下载产物但不断言埋点），如实登记（诚实登记节 1） |
| version_restore | `versions.service.ts:148`（M4 已有） | `versions.e2e-spec.ts:360`（:387 事件落表断言） |
| perf_metric | `EditorPage.tsx:1321`（firstInteractionMs，一次性闸 :216） | `telemetry.e2e.spec.ts:155`（恰一次+数值）；本日 PERF-004 测量 10 次装载交叉互恰（perf-m5.md §三） |
| error_occur | `useEditorDoc.ts:98/:111`（load-fail recovered true/false）＋`saveLoop.ts:194/:206`（save-fail 成对上报） | `telemetry.e2e.spec.ts:167`（load-fail e2e）＋`saveLoop.test.ts:153/:179`（save-fail 三发射点 vi.mock spy 直测——T4 修复轮） |

### M4 挂账清偿表（T6，7 项）

| 项 | 实现位置 | 守卫测试（当日通过） |
| --- | --- | --- |
| 快照脏标志 TOCTOU（先清脏再 await 插入，失败恢复 dirty，lastAutoAt 不回拨） | `collab.service.ts:330-360`（snapshotIfDue/snapshotIfDirty） | `collab.service.test.ts:175`（插入在途 onChange→完成后 dirty 仍 true）/:194/:204（两入口失败恢复） |
| 导入 core 组装 walk 移入 try/catch（GmindCoreError/栈溢出同归因文案） | `xmind-import.ts:81-86` | `xmind-import.test.ts:63`（core 组装失败→同文案不裸抛） |
| 导出 visited-set 环防护（防御性） | `xmind-export.ts:19-28` | `xmind-export.test.ts:11`（自引用环终止且环回边不进树）/:31（正常树回归护栏） |
| 回填通知软删文件过滤 | `invite.service.ts:174`（fileRepo.find 加 deletedAt IsNull） | `share.e2e-spec.ts:443`（软删文件回填照常、owner 零「已加入」通知） |
| 成员面板邀请计数文案（skipped 分开计数）＋textarea aria-label | `MemberPanel.tsx:63-67`/:89 | `member-invite.e2e.spec.ts:94`（混合批次分计数；M=0 旧文案；aria-label） |
| 回填 catch 日志恢复 user 上下文 | `auth.service.ts:37-39`（log-only，无测试——如实） | 无（日志行不设自动化，登记） |
| 版本面板预览遮罩层级（头部 z-1301 > mask z-1300） | `version-panel.css:20-23`（真实归宿为 version-panel.css，非 editor.css——实现裁定） | `versions.e2e.spec.ts:163`（预览打开时关闭钮指针可点） |

## 三、M2 准入台账 §7.5/7.6/7.7 状态回写（docs/m2-entry-checklist.md）

### §7.5 m1-acceptance「待手动核验」人工签注——清单原样转需求方（本验收文档不代签）

台账条目 5 要求「随验收流程执行并回写签注」。当日 grep m1-acceptance.md：「待手动核验」标记行 11 处（FR-EDT-001 行含 ①② 两条子路径）＋M1 修复轮明示补入的 FR-EDT-018 tooltip 项——按子路径计恰 13 处，与 m1 结论「共 13 处」对账吻合。下列清单**原样转呈需求方/测试执行**；每项背后的自动化同链路背书当日仍在全量回归中通过（web e2e 99+1skip），人工步骤为浏览器交互层（手感/原生 tooltip/系统剪贴板等自动化不可达面），累计约 10 分钟。**签注栏留空，M5 验收不代签。**

| # | m1 项 | 自动化同链路背书（当日通过） | 人工步骤（原样转呈） | 需求方签注 |
| --- | --- | --- | --- | --- |
| 1 | FR-EDT-001 Enter 同级 | editor.e2e.spec.ts:53（Tab 子级）、:148（Shift+Tab） | ① 选中子节点按 Enter→同级下方新节点进编辑态 | 待签 |
| 2 | FR-EDT-001 中心主题 Shift+Tab toast | Shift+Tab e2e（editor.e2e.spec.ts:148）＋toast 实现（EditorPage.tsx:575） | ② 选中中心主题按 Shift+Tab→toast「中心主题不支持添加父主题」且无变更 | 待签 |
| 3 | FR-EDT-002 Delete 键路径 | gmind-core operations/undo 单测 | 选中含 3 层子树节点按 Delete→子树消失重排；Ctrl+Z 原位恢复 | 待签 |
| 4 | FR-EDT-003 真实指针拖拽 | engine drag.test（≥300ms/后代禁/空白浮动） | 拖「周一」悬停「周五」约半秒释放→换父；拖父悬停子孙→禁止反馈；拖空白→浮动挂 root | 待签 |
| 5 | FR-EDT-005 粘贴 >500 字截断 | engine texteditor.test（截断+onTruncated） | 编辑态粘贴 600 字→截 500＋toast「节点文本长度已达上限」 | 待签 |
| 6 | FR-EDT-006 键盘导航 | engine selection.test（navigate/siblingEnd）＋keyboardMap 接线 | 打开种子文件：↓/→ 焦点移动、End 同级末、Ctrl+A 全选 | 待签 |
| 7 | FR-EDT-009 外部纯文本缩进回贴 | engine clipboard 单测＋editor.e2e.spec.ts:201（粘贴子级） | 外部编辑器 Ctrl+V→Tab 缩进大纲文本 | 待签 |
| 8 | FR-EDT-012 富内容跨结构切换 | editor.e2e.spec.ts:89（org 切换可撤销） | 切组织架构图→备注角标/图标仍在；Ctrl+Z 恢复 | 待签 |
| 9 | FR-EDT-014 主题撤销恢复 | themes.test＋editor.e2e.spec.ts:120 | 切「无障碍」→全画布 500ms 内换色；Ctrl+Z 恢复上一主题 | 待签 |
| 10 | FR-EDT-017 多行重排 | layout.test 不变量 | 输入 3 行文本（Shift+Enter）→同级自动下移不重叠 | 待签 |
| 11 | FR-EDT-018 tooltip 悬停预览 | rich-content.e2e.spec.ts:45＋render.test（`<title>` 200 字） | 悬停「N」角标→前 200 字原生 tooltip（修复轮补入项） | 待签 |
| 12 | FR-EDT-030 点击折叠徽标 | editor.e2e.spec.ts:103（Ctrl+/ + 徽标）＋layout/render 单测 | 折叠「周一」→「+N」隐藏子树；点徽标→展开 | 待签 |
| 13 | FR-EDT-033 保存失败重试路径 | saveLoop.test.ts:179（重试耗尽+恢复） | DevTools Block `doc-state`→「保存失败，正在重试」；解除→自动回「已保存」 | 待签 |

（m1-acceptance.md 另有目视复核建议项——FR-EDT-008 框选手感/010 跨文件目视/015 面板手感/019 点击角标/027 缩放/028 真机 Esc——其背后 e2e 均当日通过，属 30 秒级顺手目视，随上表一并执行即可，不另立签注行。）

### §7.6 配额拦截残留窗口——记录性维持口径确认（无代码动作）

当日复核：行为维持 M1b 终审裁定口径不变——拦截解除以「用户删除 / persisted ack 复查 ≤ 上限」为准（`saveLoop.test.ts:52`「删除节点→解除拦截（用户唯一主动解除通道）」、:61「拦截中 saved 且 ≤ 上限→解除」、:66「仍超限→保持」、:70「序贯收敛」五例当日在位通过）；服务端 `collab.service.ts:264-273` 边缘触发广播（越线一次、回落限内重武装）实现未动。删除后仍超限的窗口内新增不受客户端拦截、仅服务端 advisory——M3~M5 均未收紧，维持「属增强非缺陷」裁定，继续留档（服务端 ≤500 硬闸仍在 PUT/建档/导入路径兜底）。

### §7.7 配额闸撤销绕过——记录性维持口径确认（无代码动作）

当日复核：M2 修复波复审登记的撤销复活窗口仍在——「删除解锁闸→Ctrl+Z 复活超限子树」场景中，客户端解除不校验计数（§7.6 同一通道）、服务端边缘触发器在计数回落限内前不重播，闸无法立即重新闭合；计数回落限内后再次越线可再拦截（`saveLoop.test.ts:70` 尾段「再 quota（回落限内后可再拦截）」当日通过）。M2 裁定「增强非缺陷」口径维持，M5 无代码动作，留档待后续产品裁定是否改水平触发/撤销本地复查。

## 四、诚实登记——缺口与延期项台账（全部为「未实现/待环境/待手动」，如实列出防口径漂移）

1. **export_done 埋点无专属自动化断言**：生产点在位（EditorPage.tsx:357），图片导出 e2e 断言下载产物但不断言埋点上报。
2. **NFR-SEC-006 专项 XSS 注入测试集未建**：判定依据为渲染层结构安全（textContent/React 转义，零 innerHTML）＋相邻用例（javascript: 拒绝/LIKE 转义）；PRD 字面「注入测试集」矩阵未建，建议后续补。
3. **NFR-SEC-001/002（TLS/落盘加密）本地无法核验**：环境项留生产部署验收（安全扫描/抓包/存储审计），本档不写通过。
4. **NFR-PERF-004 生产构建基线留部署期**：本日仅 dev 参考值（无节流/无 FCP），不据此声明达标。
5. **T5 移动端两处如实登记**：①iOS Safari 无捏合缩放——引擎缩放仅 wheel 事件路径，触摸捏合手势未接入，底栏缩放钮为兜底（真机体验见手动清单 1）；②移动端无自主折叠入口——折叠动作经桌面键位/右键（移动端不装配），保留的是已折叠徽标的点击展开通道（口径不对称的忠实执行，非实现偏离）。
6. **T5 客户端降级非安全边界**：服务端不区分移动端写请求（一期无四级权限模型），登记差异。
7. **USE-001 完成率 ≥60%**：真实流量运营指标（依赖 guide_finish 数据回看），上线期考核；触发口径为浏览器本地 localStorage（跨设备不重复引导）。
8. **REL-005「合并失败保留双方分支并提示」**：CRDT 收敛无失败分支，防御性子句无对应实现，口径登记。
9. **T1 minors（评审 deferred）**：rebind 先查后存的 TOCTOU（并发无 ER_DUP_ENTRY→409 映射）；顺序耦合测试依赖共享 token；emailOptOut 对重复成员不去重。
10. **T2 minors**：handledActionIds 为常量再导出非结构派生（类型链闭合）；无 Shift 的 mod+'?' 微缝；搜索「仅剩」断言偏弱；keyboardMap.test.ts 为新建非追加（已披露）。
11. **T3 minors**：步骤 2/3 目标选择器有效性未 e2e 锁住（失配退化顶部卡片仍过）；卡片翻上方硬编码 160px。
12. **T4 minors**：离线段成功后孤儿 recovered:true（分析噪音）；viaRegistration 读作「登录回填漏斗」语义宽松（已注释）；clientVersion===package.json version 未测；10KB=10,000 chars 读法（任一读法护住 TEXT 列）；cut 空 ids 早退跳过 afterUserWrite（防御路径无实义）。
13. **T6 minors**：版本面板头部 z-1301 在窄视口盖预览对话框右上角（可接受取舍）；snapshotIfDirty 在途并发例缺对称覆盖（snapshotIfDue 侧已有）。
14. **T7 minors**：⑧b 图片文案双字面量无共享常量；QUOTA_ADD_BLOCKED 缺 500 数值复用；404 归因仅覆盖装载路径；在飞请求携旧 token 的 401 会清新 token（预存在行为，未回退）。
15. **M4 维持 PARKED 不清**（终审裁量）：零 diff 恢复仍写 pre_restore 行；导入 copy 路径 >MAX 收紧（无实际影响）。
16. **web e2e 偶发抖动**：本日全量首跑 collab「断网编辑…恢复联网后自动同步」1 例失败（save-status 短暂呈 409 陈旧文案后未及收敛）——历史已知 flake（M4 台账「本日未复现」项的再现）；隔离复跑该 spec 7/7 通过、全量复跑 99 passed+1 skipped 全绿，未改代码。模式留档，继续观察。
17. **M4 诚实登记延续未清项**：导入图片不入库（口径）、摘要/邀请/提醒邮件待 MailHog、JPG/PNG 像素视觉待手动、真实 .xmind 待人工导入、恢复×评论新 ULID 裁定、permission 通用标签、dev 迁移齐平流程项——见 m4-acceptance.md 诚实登记节，本日无变化。

## 五、支撑输出（2026-09-26 本会话全量实测；dev 服务器 :3001/:5174 全程共用未重启）

- `pnpm lint`：exit 0，无输出。
- `pnpm typecheck`：server / web / engine / gmind-core / shared / xmind-io 六包全部 Done，exit 0。
- `pnpm test`（全仓单测）：**457 passed**，Test Files 36 passed，exit 0——@gmind/shared 5（1 文件）、@gmind/xmind-io 22（3 文件）、@gmind/gmind-core 160（11 文件，含 chaos 套件）、@gmind/server 21（5 文件，含 collab.service.test 9 例：TOCTOU/配额/持久化）、@gmind/engine 212（11 文件）、@gmind/web 37（5 文件：keyboardMap 6＋xmind-export 2＋xmind-import 9＋saveLoop 16＋collab 4）。
- `pnpm --filter @gmind/server test:e2e`：Test Files **15 passed (15)**，Tests **179 passed (179)**，15.69s，exit 0——auth 8 / files 5（含 doc_create :92）/ db-init 2 / users-me 2 / **users 14**（M5 新建：设置页三端点）/ file-content 19 / storage 12 / collab 6 / files-views 24 / folders 13 / trash 10 / share 28 / comments 9 / notify 15 / versions 12（含 payload 上界 :600）。首跑全绿。已知 stderr 噪音（不判失败，M4 同款登记）：套件收尾一条 `[collab] 卸载快照失败… Connection is not established`——测试 app 关闭与卸载兜底拆链竞态，断言零失败。
- `WEB_PORT=5174 API_ORIGIN=http://localhost:3001 pnpm --filter @gmind/web e2e`：**99 passed, 1 skipped（23.0s）**，0 failed，exit 0——workspace 14 / collab 7 / editor 12 / rich-content 8 / import-export 6 / m1-gaps 6 / m0-acceptance 3 / share 3 / comments 3 / member-invite 3 / notify 2 / versions 3 / **settings 4**（M5 新建）/ **help-panel 2**（M5 新建）/ **guide 2**（M5 新建）/ **telemetry 5**（M5 新建）/ **mobile-readonly 5**（M5 新建）/ **error-copy 11**（M5 新建）/ perf-editor 1 skipped（须 PERF=1）。**如实记录**：当日首跑 98 passed＋1 failed（collab 断网用例，见诚实登记 16）——隔离复跑该 spec 7/7、随后全量复跑 99+1skip 全绿；上列数字为复跑输出，无第三次重跑。
- perf 复跑两项（详见 docs/perf-m5.md）：50 机器人两轮 P95 6.8/6.9ms PASS；500 节点两轮中位 FPS 60.0/60.0、操作 P95 22.2/22.2ms。

## 六、M5 验收结论与待手动核验清单（如实记录）

- **逐项结论**：NFR-P0 16 项中——**PERF-001/003/005/007、SEC-003、REL-003/004/005、USE-001/002 通过**（PERF-003 附灰度采样留运营期、REL-003 附真实墙钟、REL-005 附防御子句口径、USE-001 附完成率指标留运营期——均为登记非缺口）；**PERF-007、REL-002 通过**（REL-002 附灾难注入待手动）；**SEC-006 通过（结构安全＋相邻用例）＋登记专项注入集缺口**；**SEC-001/002、PERF-004 为环境项待部署验收**（本地形态无法核验，如实登记不写通过）；USE-005（P1）一并收口通过。M5 七任务（设置页/快捷键面板/新手引导/埋点 11 事件/移动端只读/M4 清偿 7 项/文案走查＋401 修复）**全部落地且当日有自动化背书**（export_done 埋点与 auth 日志行两处无断言，如实登记）。准入台账 §7.5 清单原样转需求方（不代签），§7.6/7.7 记录性维持口径确认回写。无一虚构「通过」。
- **待手动核验清单（真实操作，累计 ≈20 分钟；M4 未执行项一并延续）**：
  1. **移动端真机 Safari 体验**（iPhone 实机）：打开文档→画布渲染/平移/双击不进编辑；底栏「+/−」缩放钮替代捏合（iOS Safari 捏合不触发缩放——引擎 wheel-only，登记项 5 的真机核对）；评论面板开关＋发表＋角标过滤；已折叠节点徽标点击展开。
  2. **双机体验**（两台设备/跨网络）：新手引导首进出现与跳过；A/B 同开文档互见光标；A 恢复历史版本→B 端画布不刷新实时回滚（M4 手动项 2 延续）。
  3. **邮件送达（MailHog 待环境）三封**：邀请邮件（注册链接）、15 分钟未读摘要（含条目深链＋「打开 Gmind」行）、回收站到期提醒（单封）；设置页 opt-out mention 后摘要不再含 mention 条目（T1 口径的送达面）。
  4. **真实 .xmind 文件导入**（XMind 8 与 2020+ 各一份，含样式/图片/备注）：双路径解析、降级 toast 弹出、层级完整（M4 手动项 5 延续）。
  5. **导出图片视觉**：透明底 PNG（棋盘格）、白底 JPG、1x/2x/3x 清晰度递增、文件名（M4 手动项 1 延续）。
  6. **真实墙钟节奏**：连续编辑 ≥10 分钟→版本面板 ≥3 条 auto 快照、间隔 ≈3 分钟；可选：防抖窗口内强杀进程重启比对（REL-002 灾难注入）；dev 库长驻验收前 `migration:run` 齐平（M4 流程项）。
  7. **上线运营期**：埋点 guide_finish 完成率 ≥60% 回看、WACD/AARRR 看板、灰度 PERF-003 采样。
  8. **生产部署核验**：TLS/301/WSS 抓包（SEC-001）、落盘加密与 KMS 审计（SEC-002）、生产构建首屏 Web Vitals＋20Mbps 节流（PERF-004）、基准机 perf 三项重跑（spec §6.1.1）。
- 口径边界（同 M1~M4 纪律）：以上自动化断言均为本机 dev 实测；「待手动核验」各项背后均有当日通过的自动化覆盖同链路，人工步骤为跨机网络/视觉/体感/环境/真机/真实文件补充；环境项（SEC-001/002、PERF-004 生产基线）不因「结构上可达」而代签，留部署期验收。已登记缺口（诚实登记节 17 条）均为「未实现/待环境/待手动、如实列出」，后续排期由需求方裁定。
