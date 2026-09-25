# M2 实施准入清单（M1b 终审产出，2026-09-22）

> M2（实时协同）计划编写时必须逐项落实以下内容。来源：M1b 全分支终审 + 各任务审查台账。
> **M2 终审修复轮注记（2026-09-22）**：§1 配额各项已收口——createForUser 改
> countAliveReachable 口径；WS 路径配额从 advisory 升级为客户端强制
> （quota-exceeded 广播 → 客户端新增拦截标志 + toast，`nextQuotaBlock` 事件机单测钉死；
> 终审前该路径仅改状态文字、被 persisted ack 覆盖，属 Global Constraint 违规，本轮修复）。
> 未尽事项全部转入 §7 M3 准入台账，防静默丢失（M2 教训）。

## 1. 协同与配额（终审 Critical 项的延伸）

- **配额口径**：保存路径已改为 `countAliveReachable`（可达活跃节点，normalize 后）；~~M2 须补齐~~（已收口）客户端粘贴/插入前预检（M2 终审修复轮以「quota 拦截标志 + 新增入口闸」实现）、`createForUser` 同口径（终审修复轮改 countAliveReachable）、`QUOTA_STATUS` 文案与 `MAX_DOC_NODES` 常量统一（saveLoop.ts 单源）、协同 WS 路径（Hocuspocus onChange）的配额校验（T1 广播 + 终审修复轮客户端强制）。
- **远端更新收敛**：`normalizeTree` 目前只在 `docFromState`（导入）与本地写事务触发；M2 远端 applyUpdate 路径必须以 `deriveNormalizeDirty`（已就绪，repair.ts 头部有准入注释）接入同一收敛，并配套 §8.1 并发混沌套件（移动 vs 删除、并发换父、墓碑编辑）——PRD 风险表第一项的缓解措施，必须与 Hocuspocus 集成同写。
- **UndoManager 多端语义**：已按 USER origin 隔离（远端应用不进本地撤销栈）——M2 加断言测试钉死。

## 2. Hocuspocus 网关（替代 saveLoop PUT 为主通道）

- `onAuthenticate` 走 PermissionService 单点（404 不泄露语义与 REST 一致）。
- `onStoreDocument` 持久化 + 2s 防抖 + 持久化 ack 广播（FR-EDT-034 已保存态的数据源）；PUT 保留为降级通道。
- `node_count` 回写所有权从 FilesService 移交协同模块（口径见 §1）。
- Awareness 光标/选区/跟随：以 engine 增量扩展实现（遵守「只增不改」），顺带注入 image base URL（render.ts 现硬编码 `/api/images/`）。

## 3. 离线（承接 M1 重基线项）

- y-indexeddb 本地副本 + 重连合并（FR-EDT-035）+ FR-EDT-034 第三态「离线编辑中」——M1 验收文档已把这两条 P0 子句标注为随 M2 交付（需求方重基线项，见 m1-acceptance.md）。
- ~~吸收 M1 遗留：在途 PUT 期间编辑+立即卸载的丢失窗、冲刷失败静默（被离线方案整体取代）。~~
  **更正（M2 终审修复轮）**：「整体取代」说法不成立——y-indexeddb 只解决了本端刷新/断网
  丢失窗；PUT 作为 WS 断开时的降级通道仍在，**局部断网下的跨客户端覆盖窗**（A 走 PUT 全量
  docState 兜底与 B 的 WS 增量并发时，A 的陈旧全量可能覆盖 B 的新写入）并未消除，
  **M3 必须交付 PUT/WS 陈旧写序守卫**（见 §7.1），不得再次以「被离线方案取代」为由顺延。

## 4. 存储与安全

- 上传/copy 端点补属主校验（当前仅登录即可写任意 fileId 命名空间）；copy 纳入配额。
- MinIO Provider 换实现（接口与 copy 已就绪）；`storage.multer.filter` 的全局 PayloadTooLarge 改写范围收窄（现会改写 2MB JSON 超限的报错文案）。
- 「备注富文本」（FR-EDT-018 P0 要求富文本工具，M1 按计划界定为纯文本 textarea）——**需需求方确认重基线**，M2 或三期落地。
- 「FR-EDT-017 自由拖拽模式」同为重基线候选（实现成本高，需产品确认排期）。

## 5. 测试债（M2 计划原样带入，防静默丢失）

- 验收文档 13 项「待手动核验」步骤（docs/m1-acceptance.md）逐项人工执行并签注。
- engine/core 剪贴板镜像 parity 测试；链接/图片/图标刷新持久化 e2e；T8 navigate 真金样集成测试；框选用例 getAttribute 竞态改 poll。
- 遗留 minor 全量清单见 git 历史的 SDD 台账（各里程碑 progress.md 已按流程清理，结论沉淀于各任务提交信息与本文件）。

## 6. 已知语义决定（M2 不要「顺手改掉」）

- 拖拽 <300ms 松手 = 浮动到 root（裁决语义；若改 cancel 需产品确认）。
- 粘贴目标 = 选中节点的子级（FR-EDT-009 原文，M1 末按 PRD 修正）。
- 折叠状态全局同步；普通滚轮平移不 preventDefault；空格在非输入焦点时进入编辑态。

## 7. M3 准入台账（M2 终审修复轮转入，逐项带验收语义，防静默丢失——M2 教训）

> 来源：M2 终审（2026-09-22）明确顺延的事项。M3 计划编写时逐项落实，不得再次无声顺延。

1. **PUT/WS 陈旧写序守卫**（§3 更正项）：PUT 降级通道与 WS 持久化的并发覆盖窗——
   PUT 全量 docState 落库前须校验服务端版本/updated_at 新鲜度（或等价的写序判定），
   陈旧全量拒绝落库。验收：A（PUT 兜底）与 B（WS）并发编辑的自动化用例证明 B 的写
   不被 A 的陈旧快照覆盖。
2. **存储属主校验**（§4，安全优先）：上传/copy 端点当前仅登录即可写任意 fileId 命名
   空间——M3 第一优先级补属主/协作者校验（与 files 域 assertCanRead 同口径），
   copy 纳入配额。验收：非协作者上传/copy 他人 key → 403/404 的 e2e。
3. **远端收敛的 web e2e 守卫**：normalize 接线（attachRemoteNormalization）已有
   core 级单测，但缺浏览器层守卫——M3 补「双页并发结构操作 → 刷新后结构完整」的
   web e2e，防止接线在重构中被静默拆除。
4. **剪贴板 parity 测试**：engine/core 剪贴板镜像一致性（M1b 起挂账至今）。
5. **m1-acceptance 13 项「待手动核验」人工签注**：随 M3 验收流程执行并回写签注。
6. **配额拦截的残留窗口（如实记录，非阻塞）**
7. **配额闸的撤销绕过（M2 终审复审发现，M2 修复波复审登记）**：删除解锁配额闸后
   Ctrl+Z 可复活超限子树——ack 复查仅在拦截标志置位时运行，复活后标志已清、服务端
   边缘触发器也不会重播，闸无法重新闭合。M3 增强：撤销后的 ack 复查改为无条件（或
   撤销事务触发本地可达数复查）。
8. **【M3b 必须】复制图片对象迁移或 deletePrefix 引用防护**（M3a 终审 Important #1，
   计划裁定盲区）：copyForUser 不迁移对象（副本图片 key 仍指 files/{源fileId}/）×
   purgeFile 无条件 deletePrefix——复制含图文件 → 删原件 → 30 天自动清理 → 幸存副本
   图片全部 404（跨用户变体：owner purge 原件 → 协作者副本丢图）。修复方向：复制时
   逐 key 走 StorageService.copyImage 迁移（基础设施现成）或 deletePrefix 前存活引用
   扫描。验收：复制含图文件 → 删原件 → runCleanup(+30d) → 副本图片仍 200 的 e2e。
9. **【M3b 必须】提醒去重加入 deletedAt 分量 + 还原时清除旧提醒**（M3a 终审 Important
   #2）：hasReminded 仅锚 (owner, fileId)——提醒 → 还原 → 再删 → 第二个 27 天不再
   提醒，条目 30 天静默彻底删，违反 FR-FIL-010 再删周期语义。修复：去重 marker 加
   deletedAt（和/或还原时清除该 fileId 既有提醒行）；通知中心（M3b 交付物）消费
   payload 契约 {fileId,title,deletedAt,action:'restore'} 的死链还原需 404 兜底 UI。
   验收：提醒 → 还原 → 再删 → runCleanup(+27d) 产生第二条提醒的 e2e。
：quota 拦截解除以「用户删除 / persisted
   ack 复查 ≤ 上限」为准（M1b 终审裁定口径）；删除后仍超限时服务端边缘触发器在回落
   限内前不会重复广播，该窗口内新增不受客户端拦截、仅服务端 advisory——M3 若收紧
   须改服务端为水平触发或客户端本地复查，属增强非缺陷。
