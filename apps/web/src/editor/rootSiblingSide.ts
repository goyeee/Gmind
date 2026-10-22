/**
 * root 级分支主题同侧落位规则（顺时针落位修正，需求方 2026-10-09 二次裁定）。
 *
 * 背景：e6d325f 的「顺时针落位」上线后，在右列满 3 的右列分支上敲 Enter，新节点被
 * addChild 的计数配额无条件强制去左列（旧文档无持久 side 时尤甚——forceSide 缺省
 * 不覆写，新节点落左下角）。需求方裁定（四问确认）：
 * - 右满 3 + 左列空 + **最后一个分支**（文档序末位 = 顺时针视觉末位）上 Enter →
 *   新分支去左列（开启左列，顺时针延续；与中心 Tab 同向）。
 * - 其余情况（含右满 3 时在非末位右分支上 Enter）→ 紧挨所按分支下方、同侧保持
 *   ——不再被计数配额强制换侧。
 * - 中心 Tab/Enter 的降级路径不变（addChild 计数定侧承接顺时针）。
 *
 * 单源口径：有效侧 = 持久 side ?? 文档序索引兜底（index<3 右、≥3 左），与 engine
 * assignMindmapSides / core countRightSideRootChildren / countRightSideRootChildren
 * 的兜底同式，配额常量 3 同值（引擎不依赖 web，改动需同步）。旧文档经 docFromState
 * 回填后持久侧恒在，兜底仅防御未同步副本的瞬态。
 * 多画布（计划三 Task 4 评审修复）：root 锚点 = rootIdOf(doc, canvasId)——异根
 * 画布上 Enter 定侧按**当前画布**子级计数，不再误用第一画布；canvasId 缺省走
 * core 缺省解析（meta.activeCanvasId 回退第一画布）。
 */
import { getMeta, getNode, rootIdOf } from '@gmind/core';
import type { NodeSide } from '@gmind/core';
import type * as Y from 'yjs';

/** 右侧常驻配额（与 engine/core 同值，改动需三处同步——见模块头注）。 */
const ROOT_SIDE_RIGHT_QUOTA = 3;

/**
 * root 直接子级的有效侧数组（文档序）：持久 side ?? 索引兜底。
 * 供 handleEnter 的中心逆时针镜像与 root 级同侧落位共用（单一公式）。
 */
export function rootKidEffectiveSides(doc: Y.Doc, canvasId?: string): NodeSide[] {
  const rootId = rootIdOf(doc, canvasId);
  const kids = getNode(doc, rootId, canvasId)?.childIds ?? [];
  return kids.map((cid, i) => {
    const s = getNode(doc, cid, canvasId)?.side;
    return s === 'left' || s === 'right' ? s : i < ROOT_SIDE_RIGHT_QUOTA ? 'right' : 'left';
  });
}

/**
 * root 级分支主题上新建同级的 forceSide（mindmap 专属；其余结构/层级返回 undefined
 * ——不干预，由 addChild 自动定侧/不写侧）：
 * - 顺时针触发：Enter（非 reverse）+ 左列空 + 右列满 3 + 所按为文档序末位分支
 *   → 'left'（需求方 2026-10-09：开启左列，顺时针延续）。
 * - 否则 → 所按分支的有效侧（同侧保持；旧文档经持久侧兜底不再被计数强制换侧）。
 */
export function rootSiblingForceSide(
  doc: Y.Doc,
  currentId: string,
  reverse: boolean,
  canvasId?: string,
): NodeSide | undefined {
  const snap = getNode(doc, currentId, canvasId);
  if (!snap || snap.deleted) return undefined;
  const rootId = rootIdOf(doc, canvasId);
  if (snap.parentId !== rootId) return undefined;
  if (getMeta(doc, canvasId).structureType !== 'mindmap') return undefined;
  const kids = getNode(doc, rootId, canvasId)?.childIds ?? [];
  const currentIdx = kids.indexOf(currentId);
  if (currentIdx === -1) return undefined;
  const sides = rootKidEffectiveSides(doc, canvasId);
  const leftCount = sides.filter((s) => s === 'left').length;
  // 触发条件：左空（此时右列 = 全部分支，sides.length ≥ 3 即右满）+ 末位 + Enter。
  // Shift+Enter（reverse，前插语义）不触发——逆时针镜像另有中心主题路径。
  if (!reverse && leftCount === 0 && sides.length >= ROOT_SIDE_RIGHT_QUOTA && currentIdx === sides.length - 1) {
    return 'left';
  }
  return sides[currentIdx] ?? 'right';
}
