# 多画布（一文件多张脑图）验收文档

> 日期：2026-10-22 ｜ 计划一~四全量交付 ｜ 分支 multi-canvas 已合并 main，计划二~四在 main 直接实现
> 标记约定同 M1~M6：**通过**＝有当日通过的自动化用例背书（注明出处文件:行号）；登记＝如实列出未覆盖面。
> 行号为 2026-10-22 当日 grep 实测；后续代码移动以测试名为准。

## 一、需求方裁定逐条验收

| 裁定 | 结论 | 自动化背书（文件:行） |
| --- | --- | --- |
| 1. 配额按画布（每张 ≤500） | 通过 | core read.test.ts:629 `countAliveReachable(doc, canvasId) 自各自画布 root 起算`、:635 `countAliveReachableAll`；server file-content.e2e-spec.ts:180 `PUT 配额按画布：active 画布 10 节点+画布 2 藏 600 节点 → 403 两段式文案`（计划一终审 Important-4 漏洞关闭）、:191 `双画布各 ≤500 → 200 且 nodeCount=全文档合计` |
| 2. 撤销不跨画布 | 通过 | core undo.test.ts:263 `createUndoManager(doc, canvasId) 按画布子图 scope`（c1 栈不触 c2）；web useActiveCanvas.test.ts:197 `UndoManager 按画布切换`（切画布换栈） |
| 3. 缩略图取第一画布 | 通过 | web thumbnail（canvas-scope.e2e.spec.ts 套件，真实缩略图断言恒首画布内容）＋ thumbnail 单测（活动画布在画布 2 也不出画布 2 内容） |
| 4. 远端光标跨画布隐藏 | 通过 | web collab.e2e.spec.ts:360 `裁定4 光标跨画布隐藏：B 在画布 2 选中，A 画布 1 不出现 B 光标（A 切来即现）`——负向+正向对照+切回加固闭环三段钉死 |
| 5. 结构/主题画布级 | 通过 | core read.test.ts（getMeta/setDocMeta 画布级读写分层）；web canvas-scope.e2e.spec.ts（结构/主题切换写当前画布） |
| 6. 概要不随版本恢复 | 通过 | core restore.test.ts:382 `restoreFromSnapshot 画布化（Task 6）`——配对画布概要 diff 不进恢复范围；restore.test.ts（整画布重建分支概要随快照复活，2026-10-22 控制器裁定，**与裁定 6 字面的张力已向需求方明示**） |
| 7. 移动端只读页签 | 通过 | web mobile-readonly.e2e.spec.ts:160 `移动端：画布页签可见可切换（裁定 7），＋/重命名/删除/排序不装配`（降级瞬态断言含） |
| 8. XMind 全出多 Sheet / 图片出当前画布 | 通过 | xmind-io parse.test.ts:155 `多画布（裁定 8）：全部 sheet 逐个产出`、:191 `附加 sheet 缺 rootTopic → 计降级跳过`、:295 `xml 多画布`；web xmind-import.test.ts:42 `多 Sheet .xmind 导入 → 每张 Sheet 一张画布`；import-export.e2e.spec.ts:147-149（导出 Sheet 标题=画布名）＋ PNG/JPG 出当前画布（canvas-scope e2e 文件名断言 `本周计划-画布B.png`） |

## 二、分计划交付真值

### 计划一 core 数据模型层（分支 multi-canvas，已合并）
- 装载迁移（旧文档确定性深拷贝进 canvas-1）：doc.test.ts:124 `docFromState 装载迁移（legacy 状态 → 多画布）`（含双副本字节级确定性断言）
- 读/写层画布化（兼容签名）：read.test.ts:590 `多画布读路径（Task 3）：canvasId 签名扫荡`；operations（同域）
- repair 多画布化＋规则⑨⑩：repair.test.ts:1034 `多画布收敛（规则⑨画布根重建/⑩画布序收敛含去重保首个）`
- 混沌跨画布维度：chaos.test.ts:479 `混沌：跨画布并发写（双副本收敛一致）`
- 画布管理 op：canvas-ops.test.ts（addCanvas/renameCanvas/deleteCanvas 最后一张拦截/reorder 钳制/undo 隔离 :241）
- 三处直读顶层 nodes 最小修复：server comments `allAliveNodeIds`（collab e2e 回归绿）、web collab.ts IDB 守卫、web TaskTable observeDeep

### 计划二 engine 参数化
- rootId：engine layout.test.ts:950 `rootId 参数化：异根文档从指定根布局（缺省 'root' 金样不变）`；selection.test.ts:204（navigate 空焦点回退）；exportSceneSvg 透传
- idPrefix：render.test.ts:94 `idPrefix 场景前缀：defs clipPath 与头 image 引用同步前缀`＋:108 缺省兼容；cursors 从 scene 派生（同测试域）
- 视口存取：viewport.test.ts:247 `Viewport getState/restore 状态存取公开 API`（快照拷贝/往返/clamp 边界）
- **金样零 diff**：`git diff a1b903a..234a027 -- packages/engine/src/goldens` 为空（VCS 级证据，终审独立复核）

### 计划三 web UI（main，e54a83d..f522673 后续）
- 状态中枢/切换编排：useActiveCanvas.test.ts（12 用例：编排顺序/幂等/视口存档/UM 隔离/删除回退）
- 页签条：canvas-tabs.e2e.spec.ts（新建→+1 且自动切换/重命名持久化/删除回退/末张拦截两段式）
- 移动端：mobile-readonly.e2e.spec.ts:160（裁定 7）
- 12 项口径接线：canvas-scope.e2e.spec.ts（新建/计数/全选/导出范围/文件名）＋单测 13 例（双画布异根 doc）
- 评论跨画布定位：comments.e2e.spec.ts:224 `评论跨画布定位：画布 2 有评论线程 → 切换回画布 1 并选中节点`

### 计划四 xmind-io 多 Sheet（main，c98c8c7/c95b914）
- 解析：parse.test.ts:155/191（JSON 多 Sheet+缺根降级）、:295（XML 多画布+sheet 级 title 提取）
- 构建/往返：build.test.ts（多 Sheet 产物）、roundtrip.test.ts（`parsed.sheets[0].root` 深度相等）
- 导入胶水：xmind-import.test.ts:42（3 Sheet → 3 画布：首 Sheet 进首画布 root 恒 'root'、画布名=Sheet 名、附加画布根文本=Sheet 根标题）
- 导出胶水：import-export.e2e.spec.ts:147-149（导出→parseXmind 回读，Sheet 标题=画布名）

## 三、门禁基线（2026-10-22 计划四收口时实测）

- lint exit 0；typecheck 全 6 包绿
- 单测：engine 428、web 144、server 32、shared 41、xmind-io 27、core 374/375（唯一红=bench 1 万次混合操作阈值超时，机器负载敏感，干净 main 基线同款复现——存量登记）
- server e2e 199/199（含配额按画布 2 新例）
- web e2e 185 passed + 3 failed（workspace file-card 族 71/98/120——双网格 strict-mode 存量，main 栈同档复现，非本轨引入）+ 5 skipped

## 四、诚实登记（缺口与挂账）

1. **独立终审缺口**：计划三 T6（server 配额）实现与评审、计划三全分支终审、计划四全量实现与自验均在子代理周配额耗尽期间由主会话执行（需求方知情并指令）——独立评审待配额恢复补一轮（建议范围：计划三 T4-T6 diff＋计划四全量）。
2. workspace e2e 3 红存量（file-card 双网格 strict-mode，main 同档）——非本轨引入，维持既有挂账。
3. 埋点 node_add/delete 的 nodeCount 已统一画布级，但未加 canvasId 维度（数据口径断点=多画布上线点）。
4. versions.service.ts 恢复路径/快照的 nodeCount 仍 active 画布单口径（单画布无差异；多画布展示口径可能与合计不一致）——挂账计划四后裁定。
5. core bench 阈值负载敏感——长期改进建议（warmup/相对阈值）。
6. 其余 deferred minor 见 .superpowers 台账（workspace 前的各计划 progress.md；gitignore 不入库，本文档为真值沉淀）。
