/**
 * @gmind/core 公共导出面（M1a 收敛，M1b 契约基准）。
 *
 * 导出顺序：constants/errors → read → operations → repair → undo → restore → clipboard → doc/templates。
 *
 * 已知良性运行时环（M1b 再评估是否重构，见 T9 裁决）：doc → repair（docFromState 调
 * normalizeTree）与 repair → doc（ROOT_NODE_ID 常量）互引；双方仅在函数调用期取值，
 * 不在模块求值期解引用，ESM 语义下无 TDZ 风险。undo/constants/errors 为叶子，
 * templates → doc 为纯类型导入。
 *
 * SEED_TEMPLATES / ORIGIN_* 经 doc.ts、operations.ts 转出与直接从本模块导出指向同一
 * 绑定，star-export 不构成冲突。
 */

// constants / errors（叶子模块，无本地依赖）
export * from './constants';
export * from './errors';

// read（只读快照与存活查询）
export * from './read';

// operations（写操作与事务）
export * from './operations';

// summary（概要：同父连续兄弟片段归纳，M6 Task 6 企微对标）
export * from './summary';

// repair（自愈/规范化）
export * from './repair';

// undo（撤销/重做）
export * from './undo';

// restore（快照恢复：结构 op-diff 单事务，ORIGIN_RESTORE 不进撤销栈）
export * from './restore';

// clipboard（子树 ⇄ 缩进大纲剪贴板数据层）
export * from './clipboard';

// export（导出辅助：展开克隆，M4 Task 9）
export * from './export';

// doc / templates（文档构建与序列化；SEED_TEMPLATES 数据本体在 templates.ts）
export * from './doc';
export * from './templates';
