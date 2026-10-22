# 多画布 · 计划四：xmind-io 多 Sheet 互导 + 验收文档 实施计划

> 执行方式说明：子代理周配额耗尽（kimi-for-coding 与 k3 双模型），经需求方指令「你来终审…开始计划四」，本计划由主会话亲自实现与自验；独立终审在配额恢复后补（登记偏差）。

**Goal:** XMind 导入不再拍平（多 Sheet → 多画布，裁定 8）；导出全画布多 Sheet（裁定 8）；多画布整体验收文档。

**Architecture:** xmind-io 解析产物从 `{root, degraded}` 升级为 `{sheets: XmindSheet[], degraded}`（XmindSheet={title, root}）；buildXmind 收 sheets 数组；web 导入胶水首 Sheet 进首画布、其余 Sheet 逐个 addCanvas；导出胶水 listCanvases 逐画布出 Sheet。

**Tech Stack:** 现有栈。**Spec:** 裁定 8（`2026-10-21-multi-canvas-ruling.md` §一.8）。

## Tasks（主会话顺序执行，每步验证）

### Task 1: xmind-io 多 Sheet 化
- types.ts 加 `XmindSheet`；parse-json/parse-xml 改产 sheets（首 Sheet 缺根仍 EMPTY；附加 Sheet 缺根计 structure 降级；Sheet title 缺省 ''）；index.ts parseXmind 签名升级；build.ts buildXmind(sheets)
- 测试：parse.test/build.test/roundtrip.test 既有用例改 sheets 形态 + 新增多 Sheet 用例（2020+ JSON 与 XMind 8 XML 双格式：2 Sheet 导入解析出 2 sheets、无根附加 Sheet 计降级、build→parse 往返）

### Task 2: web 导入/导出胶水
- xmind-import.ts：首 Sheet 进首画布（root 文本缺省回落文件名），其余 Sheet 逐个 addCanvas（name=Sheet title ||「画布 N」）+ 走树；超限/损坏文案不变
- xmind-export.ts：新增 docToXmindSheets(doc)（listCanvases 逐画布 docToXmindTree，title=画布名）；exportXmind 改出全画布（裁定 8 落地，替换计划三中间态）
- 测试：web 单测（若有）+ e2e import-export：多 Sheet .xmind（buildXmind 现造 fixture）导入 → 2 页签且内容正确；导出 → xmind-io parseXmind 回读 2 Sheet 往返

### Task 3: 验收文档 + 收口
- `docs/multi-canvas-acceptance.md`：计划一~四逐项验收真值（真实测试名+行号，当日 grep）
- 门禁五件套全绿；project-status.md 多画布行追加「计划四 ✅＋整体验收文档」；§三待排期 bullet 更新
- Commit + push（需求方已指令推送）
