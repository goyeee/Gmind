# M2 实施准入清单（M1b 终审产出，2026-09-22）

> M2（实时协同）计划编写时必须逐项落实以下内容。来源：M1b 全分支终审 + 各任务审查台账。

## 1. 协同与配额（终审 Critical 项的延伸）

- **配额口径**：保存路径已改为 `countAliveReachable`（可达活跃节点，normalize 后）；M2 须补齐客户端粘贴/插入前预检、`createForUser` 同口径（当前仍 countNodes，±1 语义差）、`QUOTA_STATUS` 文案与 `MAX_DOC_NODES` 常量统一、协同 WS 路径（Hocuspocus onChange）的配额校验——协同会放大墓碑累积，当前口径不改会在协同下持续误报。
- **远端更新收敛**：`normalizeTree` 目前只在 `docFromState`（导入）与本地写事务触发；M2 远端 applyUpdate 路径必须以 `deriveNormalizeDirty`（已就绪，repair.ts 头部有准入注释）接入同一收敛，并配套 §8.1 并发混沌套件（移动 vs 删除、并发换父、墓碑编辑）——PRD 风险表第一项的缓解措施，必须与 Hocuspocus 集成同写。
- **UndoManager 多端语义**：已按 USER origin 隔离（远端应用不进本地撤销栈）——M2 加断言测试钉死。

## 2. Hocuspocus 网关（替代 saveLoop PUT 为主通道）

- `onAuthenticate` 走 PermissionService 单点（404 不泄露语义与 REST 一致）。
- `onStoreDocument` 持久化 + 2s 防抖 + 持久化 ack 广播（FR-EDT-034 已保存态的数据源）；PUT 保留为降级通道。
- `node_count` 回写所有权从 FilesService 移交协同模块（口径见 §1）。
- Awareness 光标/选区/跟随：以 engine 增量扩展实现（遵守「只增不改」），顺带注入 image base URL（render.ts 现硬编码 `/api/images/`）。

## 3. 离线（承接 M1 重基线项）

- y-indexeddb 本地副本 + 重连合并（FR-EDT-035）+ FR-EDT-034 第三态「离线编辑中」——M1 验收文档已把这两条 P0 子句标注为随 M2 交付（需求方重基线项，见 m1-acceptance.md）。
- 吸收 M1 遗留：在途 PUT 期间编辑+立即卸载的丢失窗、冲刷失败静默（被离线方案整体取代）。

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
