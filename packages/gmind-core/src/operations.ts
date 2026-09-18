import * as Y from 'yjs';
import { ulid } from 'ulid';
import { MAX_TEXT_LENGTH } from './constants';
import { GmindCoreError } from './errors';
import { requireAliveNode } from './read';
import { normalizeTree } from './repair';

/** 写操作来源：'user'（可撤销）/ 'system'（内部/修复，不进撤销栈）。 */
export type WriteOrigin = string;
export const ORIGIN_USER: WriteOrigin = 'user';
export const ORIGIN_SYSTEM: WriteOrigin = 'system';

export interface AddChildOptions {
  /** 插入位置；缺省追加末尾，越界（负数或超过长度）clamp 到末尾。 */
  index?: number;
  /** 新节点文本；缺省 `''`（spec §4.1 默认值）。 */
  text?: string;
}

export interface WithTransactionOptions {
  /** 事务后是否执行 normalizeTree（默认 true；normalize 以 system origin 执行）。 */
  normalize?: boolean;
}

/** 统一写入口：doc.transact(fn, origin) + 事务后 normalizeTree（默认开启）。 */
export function withTransaction<T>(
  doc: Y.Doc,
  origin: WriteOrigin,
  fn: () => T,
  opts: WithTransactionOptions = {},
): T {
  const result = doc.transact(fn, origin);
  if (opts.normalize !== false) normalizeTree(doc, ORIGIN_SYSTEM);
  return result;
}

/**
 * 在 parent 下新增子节点，返回新 ULID。
 * 校验（先于 transact，拒绝即零变更）：parent 存在且存活（root 合法）。
 */
export function addChild(
  doc: Y.Doc,
  parentId: string,
  opts: AddChildOptions = {},
  origin: WriteOrigin = ORIGIN_USER,
): string {
  const parent = requireAliveNode(doc, parentId);
  const id = ulid();
  withTransaction(doc, origin, () => {
    const node = new Y.Map<unknown>();
    node.set('text', opts.text ?? '');
    node.set('parentId', parentId);
    node.set('children', new Y.Array<string>());
    doc.getMap('nodes').set(id, node);

    let parentChildren = parent.get('children') as Y.Array<string> | undefined;
    if (!parentChildren) {
      parentChildren = new Y.Array<string>();
      parent.set('children', parentChildren);
    }
    const len = parentChildren.length;
    const idx =
      opts.index !== undefined && opts.index >= 0 && opts.index <= len ? opts.index : len;
    parentChildren.insert(idx, [id]);
  });
  return id;
}

/**
 * 修改节点文本。
 * 校验（先于 transact，拒绝即零变更）：存活；长度 ≤ MAX_TEXT_LENGTH，否则 TEXT_TOO_LONG。
 */
export function setText(
  doc: Y.Doc,
  id: string,
  text: string,
  origin: WriteOrigin = ORIGIN_USER,
): void {
  if (text.length > MAX_TEXT_LENGTH) {
    throw new GmindCoreError('TEXT_TOO_LONG', '节点文本长度已达上限');
  }
  const node = requireAliveNode(doc, id);
  withTransaction(doc, origin, () => {
    node.set('text', text);
  });
}
