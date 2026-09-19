# @gmind/engine

Gmind 布局/测量/渲染引擎：纯函数式布局计算与节点盒测量，无 DOM、不直接依赖 yjs。

## 绑定裁决（约束整个 engine 包）

engine 不 import yjs，也不 import core 的 `NodeSnapshot`/`DocMeta` 类型（防 yjs 类型渗漏）；
布局/渲染 API 一律接收本包定义的 `DocReader` 接口（`getMeta/getNode/childrenIds`）与
结构化本地类型（`DocMetaLike`/`NodeSnapshotLike`，为 core 快照的结构子集）——
由 apps/web 用一个适配函数把 `@gmind/core` 的读 API 桥接成 `DocReader`。
