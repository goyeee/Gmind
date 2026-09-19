# @gmind/engine

Gmind 布局/测量/渲染引擎：纯函数式布局计算与节点盒测量，无 DOM、不直接依赖 yjs。

## 绑定裁决（约束整个 engine 包）

engine 不 import yjs，也不 import core 的 `NodeSnapshot`/`DocMeta` 类型（防 yjs 类型渗漏）；
布局/渲染 API 一律接收本包定义的 `DocReader` 接口（`getMeta/getNode/childrenIds`）与
结构化本地类型（`DocMetaLike`/`NodeSnapshotLike`，为 core 快照的结构子集）——
由 apps/web 用一个适配函数把 `@gmind/core` 的读 API 桥接成 `DocReader`。

## 主题系统（M1b Task 5，FR-EDT-014）

`THEMES` 恰三套预置（`ThemeId` 键域）：

| ThemeId | 定位 | 主色 |
| --- | --- | --- |
| `gmind-blue` | 默认经典蓝 | `#3370ff` |
| `gmind-warm` | 暖橙 | `#ff8800` 系 |
| `gmind-accessible` | WCAG AA 正文对比度 ≥4.5:1；色盲友好（蓝/橙双色系，避开红绿对比） | `#1a5fb4` 蓝 + `#e66100` 橙 |

- `ThemeTokens` 为渲染 + 布局完整 token 集（布局度量、root/level1/level2+ 分级
  fill/border/textColor/fontSize/fontWeight/fontFamily、edge、canvasBackground、
  nodeBorderRadius/Width、collapseBadge），所有键必须有值，渲染器逐个消费。
- `resolveThemeId(id)`：meta `themeId` 历史默认值 `'gmind-light'`（M0 迁移不改库）
  解析时视作 `'gmind-blue'` 别名；其余未知值一律兜底 `'gmind-blue'`。
- `resolveNodeStyle(theme, depth, nodeStyle)`：depth 0=root / 1=level1 / ≥2=level2
  级联取主题默认，再按节点 `nodeStyle` 的 fill/border/color/fontSize/fontFamily
  逐 key 覆盖；fontSize 经 `Number()` 归一，非法（NaN/空串/非正数）回退主题值；
  颜色合法性不在此校验，由渲染层回退主题值。
- `contrastRatio(hex1, hex2)`：WCAG 对比度纯函数，供测试与未来校验复用。
- `ThemeTokens` 遵守只增不改纪律：后续版本只能追加键，不得改名/改义。
