/** 单文档活跃节点数上限（spec §7.2 / FR-ACC-003）：server 配额拒绝（403，可达活跃口径）、
 *  协同 onChange 越线告警与 web 保存状态文案共用同一数值，禁止各自硬编码。 */
export const MAX_DOC_NODES = 500;

/** 文件夹最大嵌套层级（FR-FIL-002）：根为 1 级，最深 5 级；创建与移动同一上限。 */
export const MAX_FOLDER_DEPTH = 5;
