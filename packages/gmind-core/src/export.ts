/**
 * 导出辅助（M4 Task 9，FR-IO-003）：图片导出链路的文档级纯函数。
 *
 * 落位裁决：doc.ts 承载文档构建/序列化原语（docToState/docFromState），read.ts 承载
 * 只读查询——本模块承载「导出专用」的文档级派生（展开克隆），与 web 侧导出胶水
 * （apps/web/src/editor/image-export.ts）分层：core 出快照，web 出像素。
 */
import * as Y from 'yjs';
import { docFromState, docToState } from './doc';
import { rootIdOf } from './canvas';
import { getNode, subtreeIds } from './read';
import { setCollapsed } from './operations';
import { ORIGIN_SYSTEM } from './undo';

/**
 * 展开克隆（仅导出快照不改画布）：docToState → docFromState 往返克隆出新 Y.Doc，
 * 再对克隆内自 root 可达的存活节点一律 setCollapsed(false, ORIGIN_SYSTEM)。
 *
 * 绑定裁决（M4 Task 9）：折叠是视图态（spec §4.2 第 5 条，不进撤销栈），数据层子树
 * 完整——导出恒为完整层级，无需在数据层展开；克隆保证导出绝不触碰画布原 doc
 * （原 doc 的 collapsed 标记逐字节不变），唯一写入口约束不破坏（写仍走 core ops，
 * 只是写在克隆上）。
 *
 * 多画布（Task 4）：canvasId 给定时遍历范围/根解析/展开写全部限定该画布子图
 * （其余画布的折叠态在克隆中保留）；缺省=解析画布（第一画布兼容口径）。
 */
export function cloneExpanded(doc: Y.Doc, canvasId?: string): Y.Doc {
  const clone = docFromState(docToState(doc));
  const rootId = rootIdOf(clone, canvasId); // 根按画布解析（克隆已随 state 带画布结构）
  for (const id of subtreeIds(clone, rootId, canvasId)) {
    if (getNode(clone, id, canvasId)?.collapsed) {
      setCollapsed(clone, id, false, ORIGIN_SYSTEM, canvasId);
    }
  }
  return clone;
}
