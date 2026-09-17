# Gmind 一期（MVP）技术设计文档

| 项目 | 内容 |
| --- | --- |
| 文档版本 | V1.0（待评审） |
| 日期 | 2026-09-18 |
| 需求来源 | 《Gmind 在线协作脑图软件 产品需求文档（PRD）》V1.1（GMIND-PRD-2026-001） |
| 覆盖范围 | PRD 第一期 MVP 全量（P0 全部 + 一期范围内 P1/P2 项），二、三期仅做数据模型预留 |
| 关联决策 | 范围/技术栈/引擎/环境/服务拓扑已于 2026-09-18 与需求方逐项确认 |

---

## 1. 背景与一期硬约束

Gmind 是浏览器端、协作为先的在线脑图工具，一期目标是跑通「编辑—协作—分享—导出」最小闭环。以下硬约束是本设计所有架构决策的直接依据（编号引自 PRD）：

1. **CRDT 实时协同**：≥50 人/文档同时编辑，端到端同步延迟 P95 <100ms（FR-COL-001、NFR-PERF-005）；同节点同文本字段按 LWW 收敛可接受，被覆盖内容靠版本历史兜底（FR-COL-003）。
2. **性能门槛**：单文档 500 节点、连续编辑帧率 ≥40fps，单人操作 P95 <0.1s，首屏 P75 <3s（NFR-PERF-001/003/004）。三期才扩展到 5000 节点 + 虚拟渲染。
3. **可靠性与安全**：编辑停顿 2s 内自动保存、最多容忍丢失最近 3s 操作（FR-EDT-033、NFR-REL-002）；3 分钟自动快照保留 90 天（FR-VER-001、NFR-REL-003）；回收站 30 天（NFR-REL-004）；传输 TLS、落盘 AES-256（由云盘/存储层承担，应用侧负责密钥管理接入位）、XSS 过滤（NFR-SEC-001/002/006）。
4. **权限一期简化、模型预留**：一期所有登录协作者默认可编辑，但数据模型与服务端校验结构按四级权限（所有者/可编辑/可评论/仅查看）预留，服务端逐请求校验身份与权限（PRD 第 2 章、NFR-SEC-003）。

## 2. 已确认的关键决策

| 决策点 | 结论 | 说明 |
| --- | --- | --- |
| 目标范围 | PRD 一期全量，六个里程碑交付（见 §9） | 每个里程碑独立验收 |
| 技术栈 | 全栈 TypeScript：React 18 + Vite / NestJS / TypeORM | CRDT 服务端生态锁定 Node.js |
| 协同库 | Yjs + y-protocols（Awareness）+ Hocuspocus（服务端网关） | |
| 数据库 | MySQL 5.6（需求方私有镜像 `repo.guanyingyun.com:1443/other/mysql5.6:1`）+ Redis | 按 5.6 能力边界设计，schema 向前兼容 8.x，见 §5.9 |
| 画布引擎 | 自研 SVG/DOM 渲染引擎（packages/engine） | 协作光标、节点评论、跟随模式要求渲染层完全掌控 |
| 服务拓扑 | 方案 A：单体双模块，REST 与 WS 同进程 | 模块边界按可拆分标准设计，未来可拆为独立部署 |
| 开发环境 | 本地 Docker Compose 全套；短信/微信/邮件走 mock | 生产凭证后续提供，只换 Provider 实现不换架构 |

## 3. 总体架构与仓库结构

### 3.1 架构总览

```
浏览器（React SPA）
  ├─ REST（HTTPS）──────→ ┌─────────────────────────┐
  ├─ WS /collab ────────→ │ NestJS 单进程            │
  └─ SSE /notify ───────→ │  ├ REST API 模块群       │──→ MySQL 5.6（业务数据 + Yjs 文档 blob + 版本快照）
                          │  ├ Hocuspocus 协同网关   │──→ Redis（会话 / presence 辅助 / 限流 / 任务锁）
                          │  └ node-cron 定时任务    │──→ MinIO（节点图片 / 附件对象）
                          └─────────────────────────┘
定时任务：回收站满 30 天清理与前 3 天提醒、邮件摘要扫描、版本快照 90 天清理
```

### 3.2 仓库结构（pnpm monorepo）

```
gmind/
├── apps/
│   ├── web/            # React 18 + Vite：/login /workspace /edit/:fileId /s/:shareToken /trash /settings
│   └── server/         # NestJS：REST API + Hocuspocus WS 网关（同进程）
├── packages/
│   ├── shared/         # 前后端共享：API 契约、枚举（权限/事件/图标组）、zod schema
│   ├── gmind-core/     # Yjs 数据模型 + 全部文档操作 API。纯 TS、无 DOM 依赖，
│   │                   #   浏览器编辑、服务端校验/复制/导入/恢复共用同一套操作语义
│   ├── engine/         # 渲染引擎：布局算法、SVG 渲染、交互手势。只依赖 gmind-core
│   └── xmind-io/       # XMind（.xmind）导入导出解析器，纯 TS，浏览器端运行
├── docker/             # docker-compose、初始化 SQL、mock 服务配置
├── docs/
└── pnpm-workspace.yaml
```

### 3.3 工程规范

- Node 20 LTS、TypeScript strict、ESLint + Prettier；单测 Vitest、E2E Playwright。
- **唯一写入口约束（全项目第一纪律）**：任何对文档的读写必须经 `gmind-core` 暴露的操作 API，禁止绕过直接操作 Y.Map。服务端导入、复制、恢复与浏览器编辑因此共享同一套结构合法性保证，并发 repair 规则也只需实现一处。

### 3.4 Docker Compose 服务清单

`mysql`（需求方私有镜像，版本 5.6）、`redis`（镜像 tag 待需求方确认，先参数化）、`minio`、`mailhog`（开发环境收邮件）、`server`、`web`（nginx 托管前端静态资源）。镜像仓库地址与 tag 全部经 `.env` 参数化。TLS 在生产由反向代理终止，开发环境 HTTP 直连（NFR-SEC-001 的 WSS/HTTPS 要求针对生产部署）。

## 4. 协同数据模型（packages/gmind-core）

### 4.1 Y.Doc 结构

```
Y.Doc
├── meta: Y.Map            // title、structureType（整体结构）、themeId —— 全部 LWW 字段
└── nodes: Y.Map<nodeId, Y.Map>        // 扁平节点表，nodeId 为 ULID
      ├── text: string                 // LWW，500 字符上限（FR-EDT-005）
      ├── parentId: string             // LWW ——「挂在谁下面」的真值
      ├── children: Y.Array<nodeId>    // ——「同级排哪个位置」的真值
      ├── note: string                 // 富文本备注，5000 字上限（FR-EDT-018）
      ├── href: string                 // 超链接（FR-EDT-019）
      ├── image: { key, w, h }         // 对象存储 key + 显示尺寸，≤200px 等比（FR-EDT-020）
      ├── icons: Y.Map<组名, 值>        // priority/progress/flag/star 四组，组内替换=覆盖（FR-EDT-021）
      ├── style: Y.Map<属性, 值>        // 填充/边框/字体/字号/字重/文字色/连线色/粗细/线型（FR-EDT-015）
      ├── collapsed: boolean           // LWW，全局同步（FR-EDT-030）
      ├── deleted: boolean             // 墓碑标记
      └── branchStructure: string      // 分支级结构混用，P2 预留字段（FR-EDT-013）
```

中心主题为固定 id `root`：不可删除、不可换父，由 gmind-core 操作层强制（FR-EDT-001）；删除中心主题降级为清空全部子节点（FR-EDT-002）。

### 4.2 冲突策略与撤销

1. **LWW 字段**：Y.Map 原生 last-write-wins（clientID + clock 定序），直接满足 PRD「同节点同文本字段最后写入生效」。
2. **树结构 repair 规则（唯一自研共识点）**：`parentId` 是父级归属的唯一真值，`children` 数组只定同级顺序。每次本地事务或远端 update 应用后执行规范化：清除 children 中与 parentId 不符的项、清除指向已删节点的项。并发换父、移动 vs 删除并发时，LWW 结果全端确定一致，各端 repair 后状态必然相同（FR-COL-003）。
3. **结构操作优先收敛**：对墓碑节点的并发编辑不外显，内容留存于版本快照，可在历史中找回（FR-COL-003 验收标准）。
4. **撤销/重做**：Yjs UndoManager，trackedOrigins 仅含本地用户 origin，栈深 100（FR-EDT-004）。折叠切换、远端应用、恢复操作使用独立 origin，不进撤销栈。
5. **折叠状态全局同步**（写入文档）：讨论场景「各端看到同一棵树」优先；FR-EDT-030 的导出自动展开只作用于导出快照，不改画布状态。

### 4.3 持久化、版本快照与恢复

- **自动保存**：服务端每文档内存 Y.Doc 为真值，编辑停顿 2s 防抖后 `encodeStateAsUpdate` 全量写 `files.doc_state`（LONGBLOB）。全量覆盖（而非增量日志）即满足 NFR-REL-002「最多丢最近 3s」，复杂度低一个量级。
- **保存状态回执**：持久化完成后经 WS 自定义消息广播 ack，客户端据以显示「已保存 HH:MM」三态（FR-EDT-034）。
- **版本快照**：每文档 3 分钟定时器，「有变更才」写 `versions` 行（快照 blob + 触发人 + 节点数），保留 90 天由定时任务清理（FR-VER-001）。
- **恢复**：计算目标快照与当前态的 diff update，以 restore origin 事务应用回在线文档——全端实时看到回滚（FR-VER-004 的恢复广播）；恢复前自动存一档「恢复前版本」，恢复本身因此可逆。
- **加载**：新连接以 `files.doc_state` 为基线 + state vector 增量补齐。
- **断网**：客户端 y-indexeddb 本地副本，重连后 CRDT 自动合并、无重复节点（FR-EDT-035、FR-COL-004 的 P0 部分；FR-COL-004 的补偿提示增强项随二期）。

### 4.4 不进 Y.Doc 的数据

- **评论、@、通知、协作动态**：MySQL 关系数据（审计、筛选、未读都在库侧）。评论存 `node_id` + 创建时节点文本快照，节点删除后评论自然呈现「原节点已删除」态（FR-CMT-002 的生命周期解耦）。实时性经同一条 WS 连接上的自定义消息广播，不开新连接。
- **光标/选区/视口/编辑中标记**：y-protocols Awareness（易失、不落库）。光标颜色从高对比度色板按 userId 哈希分配、会话内固定（FR-COL-002）；二期跟随模式（FR-COL-008）直接消费视口字段；「正在编辑/正在查看」分组由客户端按 Awareness 活动标记本地计算（FR-COL-005，无轮询）。

## 5. 服务端设计（apps/server）

### 5.1 模块划分

`auth / users / folders / files / trash / collab / comments / notify / share / invites / storage / events / jobs`（REST 全部经 PermissionService，见 §7）。

### 5.2 auth 与会话

- 登录方式三 Provider 接口：`PhoneProvider`（短信验证码）、`EmailProvider`（验证码 + 密码）、`WeChatProvider`（扫码）。开发环境 DevProvider：验证码固定值并打印日志、邮件投递 MailHog、扫码返回模拟账号；生产只换 Provider 实现。
- 首登即注册（FR-ACC-001）：创建用户 + 个人空间 + 种 3 个示例脑图（内置模板经 gmind-core 生成）。
- 会话：Redis 不透明 token，有效期 7 天 / 勾选记住我 30 天；按用户维护会话列表，超过 5 个踢除最早（FR-ACC-002）。

### 5.3 files / folders / trash

- 四视图查询（FR-FIL-001）：我的文件（当前空间可见）、与我协作（存在 collaborator 行）、星标（用户级星标，互不影响，FR-FIL-004）、最近打开（`last_opened_at` 倒序 50 条，打开文件时回写）。
- 文件夹：5 级嵌套校验、命名 1~64 字符与非法字符校验、非空删除二次确认由前端承担（FR-FIL-002）。
- 复制：读源 `doc_state` → gmind-core 重建新文档 → 新文件命名「原名-副本」，不携带评论与版本（FR-FIL-003）。移动跨空间要求 owner（一期无团队空间，判定逻辑预留）。
- 回收站：`deleted_at` 软删；jobs 每日执行满 30 天彻底删除（连带版本快照、评论、对象存储前缀）与前 3 天所有者提醒（FR-FIL-005/006/007/010）。
- 配额（FR-ACC-003）：建/导文件数 ≤100；文档节点数 ≤500——新建、导入、粘贴、WS 写入统一校验，`files.node_count` 由协同模块在文档变更时回写维护。

### 5.4 collab（Hocuspocus 协同网关）

- 挂载于同一 HTTP 服务 `/collab` 路径。`onAuthenticate`：会话有效 + PermissionService 通过；拒绝时 403 语义且不泄露文件存在性（NFR-SEC-003）。
- `onStoreDocument`/`onChange`：节点数配额校验、`node_count` 回写、2s 防抖持久化、持久化 ack 广播。
- 快照定时器与 Awareness 管理在本模块。
- WS 自定义消息通道：评论/通知/动态事件的实时广播，复用协同连接。

### 5.5 events（协作动态 + 审计两用）

同一张 `events` 表、两种保留策略：协作动态留 30 天（FR-COL-007），审计日志留 180 天（NFR-SEC-005）。成员加入/离开、权限变更、评论、分享链接创建、导出、删除统一写入；动态条目带 node_id 支持点击定位。埋点事件（§8.6）同样落此表。

### 5.6 comments / notify

- 评论：创建/回复（parent_id 楼中楼）、@解析（候选范围为当前文档协作者，FR-CMT-005）、节点角标未解决计数（一期不做 Resolve，FR-CMT-008 三期）、评论与节点双向定位（FR-CMT-002）。
- 站内通知：`notifications` 表 + SSE `/notify` 实时推送；通知类型：被 @、被回复、权限变更（一期权限不变更，预留）。
- 邮件摘要：jobs 每分钟扫描「未读 ≥15 分钟」的通知，同文档合并为单封（FR-CMT-006）；用户可按事件类型关闭邮件，站内通知不可关。

### 5.7 share / invites

- `share_links`：128bit 随机 token；创建/关闭即时失效（FR-SHR-001）；密码、有效期列二期预留（FR-SHR-003）。
- 加入流程：`/s/:token` → 未登录先登录（带跳转）→ 服务端写 collaborator 行（role=editor）→ 跳编辑器；已关闭链接显示「链接已失效」。
- 邀请：按邮箱/手机号挂起记录，注册时匹配回填自动生效（FR-SHR-004）；单次批量上限 50；站内 + 邮件双通知。

### 5.8 storage（MinIO）

- 节点图片：本地上传/截图粘贴/网络地址三来源（网络图仅存引用地址不落对象存储）；MIME + 魔数 + ≤10MB 校验；键 `/files/{fileId}/{ulid}.{ext}`（FR-EDT-020）。
- 跨文件粘贴：服务端复制对象至目标文件前缀，配额校验失败返回「目标文档存储空间不足」（FR-EDT-010）。
- 附件：上传通道与键空间预留，一期无 UI（见 §10 OPEN-T-002）。

### 5.9 MySQL 5.6 适配约束

- 无 JSON 类型（5.7+ 才有）：结构化元数据在应用层序列化后存 TEXT，schema 由代码（TypeORM 实体 + zod）保证。
- 无 ngram 分词全文索引：一期标题搜索用 `LIKE`（千级文件规模无压力，且有 2s 响应余量，FR-FIL-008）；二期内容级搜索引入独立引擎（Meilisearch 候选）。
- 显式 `utf8mb4` 建表建库（5.6 默认 utf8 存不下 emoji）；utf8mb4 索引前缀上限 767 字节，唯一/普通索引列宽按 ≤varchar(191) 规范设计。
- 不使用 CTE / 窗口函数（8.0+），查询用传统 JOIN/子查询表达。
- 以上约束均向前兼容：同一 schema 可直接运行于 MySQL 5.7/8.x，未来换镜像无需迁移。

### 5.10 导入导出的执行位置

- **导入（FR-IO-001/002）**：浏览器端 xmind-io 解析 .xmind（zip 容器；2020+ 版本 `content.json`、旧版本 `content.xml` 双路径）→ gmind-core 建文档 → 调建文件 API（服务端校验配额与节点数、20MB 上限）。降级项（样式等）汇总为「已降级处理 N 项」提示。
- **导出（FR-IO-003/004/005）**：PNG/JPG 由 engine 将场景 SVG → Canvas 本地出图（1x/2x/3x、PNG 透明底、JPG 白底）；XMind 由 xmind-io 生成 zip 下载。导出前自动展开折叠（仅导出快照）；导出节点数 >500 拒绝并提示拆分。
- 服务端不参与任何渲染，无渲染服务。

## 6. 前端渲染引擎（packages/engine）

四层结构，仅依赖 gmind-core，不感知 React（React 封装层在 apps/web）：

1. **布局层（纯函数）**：`(节点树快照, 结构类型, 样式) → 节点包围盒`。P0 三结构各一个确定性算法：思维导图（左右分布）、逻辑图（向右）、组织架构图（向下）——同输入必同输出，是协作多端渲染一致的根基（FR-EDT-011/012/017）。结构切换只换布局算法、数据层不动。鱼骨图/时间轴（P1，二期）预留算法注册接口。
2. **渲染层（SVG DOM）**：节点为 `<g>`（矩形 + 文本 + 装饰子层：备注/链接角标、图标组、图片缩略、评论计数、「+N」折叠角标）。500 节点约 2~3k SVG 元素，一期无性能压力；预留视口剔除接口供三期虚拟渲染（NFR-PERF-006）。自动布局默认开启、可在设置中关闭进自由模式（FR-EDT-017）。
3. **交互层**：选中（点击 / Cmd 加减选 / Shift+左键 或 右键框选，FR-EDT-008）、拖拽换父（悬停 300ms 高亮 + 吸附预览线，空白释放转浮动主题，后代判环禁止，FR-EDT-003）、平移与以光标为中心缩放（10%–400%，FR-EDT-027）、适应画布（FR-EDT-028）、小地图（读同一份场景包围盒，FR-EDT-029）。全部手势最终调用 gmind-core 操作 API。
4. **同步管线**：Y.Doc 事务 → 脏子树重算布局 → rAF 批量更新 SVG，保持焦点与滚动位置稳定。

实现细节决策：

- **中文输入法**：编辑态为覆盖在节点上的 HTML 输入框；composition 期间只更新本地态，`compositionend` 才提交 LWW 写入，避免拼音过程被远端覆盖或污染撤销栈。
- **剪贴板**：写入「内部结构化数据 + 外部纯文本缩进大纲」双格式；粘贴解析 Tab/多级空格缩进生成层级（FR-EDT-009/010）。
- **字体**：「内置 ≥8 款中文字体」按系统字体栈实现（PingFang SC、Microsoft YaHei、SimSun、SimHei、KaiTi 等族，缺省优雅回退），不打包字体文件（OPEN-T-003）。
- **移动端（M5）**：响应式断点下提供只读画布（平移/缩放/折叠可用）+ 评论查看与发表，隐藏全部编辑控件（PRD 6.1.2 / OPEN-T-005）。
- 一期不做：大纲视图（三期）、公式/编号（三期）、版本对比（二期）、评论汇总面板（二期）。

## 7. 权限与账号

### 7.1 数据模型（TypeORM 迁移，utf8mb4）

`users`（会话存 Redis 不建表，见 §5.2）、`folders`、`files`（`owner_user_id`、`node_count`、`last_opened_at`、`deleted_at`、`space_id` 二期预留）、`file_stars`、`file_collaborators`（role 枚举 owner/editor/commenter/viewer，一期只写 owner/editor）、`share_links`（password/expires_at 二期预留）、`invites`、`comments`（`parent_id`、`node_id`、`node_text_snapshot`、`status`）、`notifications`、`events`、`versions`。

### 7.2 PermissionService（单点判定）

所有 REST 端点、WS 连接鉴权、（二期起）逐操作校验统一走它。一期逻辑：owner → 全部能力；存在 collaborator 行 → 视同可编辑；否则拒绝且不泄露文件存在性。二期填入四级矩阵（PRD 2.2.1 对照表）零重构。前端路由守卫只是体验层，服务端权威。

### 7.3 账号流程

改绑手机/邮箱、改密码、通知偏好（按事件类型关邮件）在 /settings（FR-ACC-002）；三步新手引导（NFR-USE-001）与快捷键帮助面板（NFR-USE-002，按 P0 处理，见 OPEN-T-001）在 M5。

### 7.4 安全基线

helmet、Redis 限流（登录/验证码接口重点）、zod 全量入参校验、上传三重校验、`href` 仅放行 http/https（堵 `javascript:`）、React 转义 + 服务端长度限制（NFR-SEC-006）、`X-Frame-Options: SAMEORIGIN`（三期做嵌入时按链接放开）、越权用例（篡改文档 ID / 伪造 token）纳入集成测试。

## 8. 测试与性能验收

1. **gmind-core（覆盖率最高优先）**：全部操作单元测试；**并发混沌测试**——多客户端操作流编码为 update 交错回放，断言各端最终状态一致且符合 PRD 验收语义（同文本 LWW、移动 vs 删除并发、换父 vs 换父并发等 FR-COL-003 全场景）。与 repair 规则同是 PRD 风险清单第一项的缓解措施。
2. **engine**：布局金样测试（同输入 → 坐标快照一致）。
3. **xmind-io**：真实 .xmind 样本库回归（2020+ content.json 与旧版 content.xml 各一组）。
4. **服务端集成**（Supertest + compose 测试档）：会话五端互踢、配额、分享加入与关闭、回收站清理与提醒、邮件摘要合并、越权用例。
5. **E2E（Playwright）**：单人编辑主链路；双浏览器上下文实时协作（A 编辑、B 见光标与内容、评论双向定位）；断网场景（offline → 本地编辑 → 恢复 → 合并无重复）。
6. **性能验收（发布门槛，工具常驻）**：50 个 Yjs 机器人客户端走真实 WS 测同步延迟 P95（FR-COL-001）；500 节点脚本化连续操作采样帧率与操作响应（NFR-PERF-001/003）；首屏 Web Vitals（NFR-PERF-004）。
7. **埋点**（PRD 6.4）：doc_create / node_add / node_delete / invite_send / collab_join / comment_create / export_done / version_restore / guide_finish / perf_metric / error_occur 自 M1 起落 events 表，公共参数含脱敏 user_id、doc_id、版本、时间戳、会话 ID。

## 9. 里程碑计划

每个里程碑独立可验收，验收通过再开下一个；M1、M2 约占总量一半。

| 里程碑 | 内容 | 验收口径 |
| --- | --- | --- |
| M0 工程地基 | monorepo 脚手架、compose 全套起通、全部建表迁移、auth 三方式（DevProvider）、会话互踢、注册种 3 个示例文件 | 注册登录 → 看到示例文件 |
| M1 单机编辑内核 | gmind-core 全量操作 + 撤销栈；engine 三结构布局、富内容、图标、折叠、缩放、多选、剪贴板、3 主题；文件 CRUD + 2s 自动保存与三态指示 | PRD 第 3 章 P0 验收单机全过；500 节点 40fps 压测脚本跑通 |
| M2 实时协同 | Hocuspocus 接入、彩色光标/选区、在线成员面板、repair 规则 + 混沌测试、y-indexeddb 断网恢复 | FR-COL-001~005；50 机器人延迟 P95<100ms；混沌套件全绿 |
| M3 文件管理与分享 | 工作台四视图、五级文件夹、星标/重命名/移动/复制、回收站 + 定时清理 + 3 天提醒、标题搜索、分享链接 + 批量邀请 + 注册回填、评论/回复/角标/双向定位/@提及/通知 + 邮件摘要 | FR-FIL / FR-SHR / FR-CMT 一期项逐条过 |
| M4 导入导出与版本 | XMind 导入导出、PNG/JPG 导出（自动展开折叠/透明底/倍率）、3 分钟快照 + 90 天保留 + 版本面板（时间轴/预览/恢复）+ 恢复广播 | FR-IO 一期项、FR-VER-001/004 |
| M5 打磨与验收 | 三步新手引导、快捷键帮助面板、错误文案规范（NFR-USE-005）、埋点补全、移动端只读 + 评论、全量 NFR-P0 验收（压测/安全/断网） | PRD 6.5.1 一期验收标准 |

## 10. 开放问题清单

| 编号 | 问题 | 当前处理 | 决策时点 |
| --- | --- | --- | --- |
| OPEN-T-001 | 快捷键帮助面板优先级矛盾：NFR-USE-002 标 P0，FR-EDT-007 与二期路线图放二期 | 按一期 P0 做基础版（分组展示 + 搜索） | 需求方在本 spec 评审时确认 |
| OPEN-T-002 | 「附件」出现在一期范围表（PRD 1.4.1）但无功能需求条目 | 数据模型与上传通道预留，一期无 UI | 需求方确认 |
| OPEN-T-003 | 中文字体按系统字体栈实现（不打包字体文件）是否接受 | 已按此设计 | 需求方确认 |
| OPEN-T-004 | 生产三方凭证（短信/微信扫码/邮件 SMTP）；私有仓库 Redis 镜像 tag | 开发期 mock；镜像 tag 参数化 | M0 起环境时、上线前 |
| OPEN-T-005 | 移动端「只读 + 评论」的明细范围（PRD 6.1.2 一句话提及） | M5 按响应式只读画布 + 评论实现 | M5 启动前确认明细 |

## 11. 技术风险与缓解

| 风险 | 缓解 |
| --- | --- |
| CRDT 并发场景出现节点错位/内容异常（PRD 风险表第一项） | repair 规则集中在 gmind-core 单点实现；混沌测试与功能同写；结构合法性唯一写入口约束 |
| 50 人并发延迟超 100ms | 服务端广播合并与更新批处理预留；压测工具从 M2 起常驻，未达标优先优化链路 |
| MySQL 5.6 老版本隐性坑（字符集/索引长度） | 迁移脚本显式 utf8mb4 与列宽规范；集成测试跑真实 5.6 容器而非 H2/内存库 |
| 外部依赖（短信/微信/邮件）故障 | 开发期全 mock；生产 Provider 接口化，可多通道冗余 |

## 12. 一期范围对照备注

以下 PRD 条目为 P1/P2、按路线图列入二期/三期，一期不做但模型已预留：四级权限强制校验与逐成员调整（FR-COL-006、FR-SHR-003/005）、团队空间（FR-ACC-004~007）、关联线/概要/外框/格式刷（FR-EDT-022~024/016）、跟随模式（FR-COL-008）、协作动态流面板（FR-COL-007，事件数据一期已采集）、评论汇总面板与解决（FR-CMT-004/008）、模板库（FR-TPL）、内容级搜索（FR-FIL-009）、PDF/SVG 导出与多格式导入（FR-IO 相应项）、版本对比与手动版本（FR-VER-003/002）、AI 生成（FR-AI）、演示模式（FR-PRS）、iframe 嵌入（FR-SHR-006）、大纲双视图（FR-EDT-031/032）。
