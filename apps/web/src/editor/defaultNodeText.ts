import type * as Y from 'yjs';
import { ROOT_NODE_ID, getNode } from '@gmind/core';

/**
 * 新增节点默认命名（需求方 2026-10-09 裁定，替代旧默认「新主题」）：
 * - root 下新增 → 「分支主题 N」；任意非根父级下新增（含第三级及更深）→ 「子主题 N」
 *   （中心节点文本 = 「中心主题」，由服务端装载通道 createTemplateDoc 的 rootText 落）。
 * - 序号 N = 同级**存活**兄弟中匹配 `^分支主题 (\d+)` / `^子主题 (\d+)` 前缀的最大序号 + 1，
 *   无匹配从 1 起。前缀匹配：用户改名成「分支主题 2：登录」仍占用 2 号，避免重号。
 * - 删除跳号不重排：删中间号后剩余节点保持原名；墓碑兄弟不计数，故删掉末号后新增会
 *   复用该号（max+1 语义的自然结果）；各父级的子主题序号彼此独立。
 * - 纯读函数（唯一写入口纪律不涉及）：序号计算必须在 withTransaction 之外完成（校验
 *   先于事务纪律），事务内只执行已验证的写。
 */
const BRANCH_PREFIX = '分支主题';
const SUB_PREFIX = '子主题';
const BRANCH_INDEX_RE = /^分支主题 (\d+)/;
const SUB_INDEX_RE = /^子主题 (\d+)/;

/** 计算 parentId 下新增子节点的默认文本（画布 openNewNodeEditor 与表格 addChildTo 共用）。 */
export function nextChildText(doc: Y.Doc, parentId: string): string {
  const isRootChild = parentId === ROOT_NODE_ID;
  const pattern = isRootChild ? BRANCH_INDEX_RE : SUB_INDEX_RE;
  let max = 0;
  for (const id of getNode(doc, parentId)?.childIds ?? []) {
    const snap = getNode(doc, id);
    if (!snap || snap.deleted) continue; // 墓碑不计数（防御：父不存在时 childIds 为空 → 从 1 起）
    const matched = pattern.exec(snap.text);
    if (matched) max = Math.max(max, Number.parseInt(matched[1]!, 10));
  }
  return `${isRootChild ? BRANCH_PREFIX : SUB_PREFIX} ${max + 1}`;
}
