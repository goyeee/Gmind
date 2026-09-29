import { describe, expect, it } from 'vitest';
import type * as Y from 'yjs';
import { addChild, childrenIds, createTemplateDoc, ROOT_NODE_ID, setDescription } from '@gmind/core';
import { docToXmindTree } from './xmind-export';

/** docToXmindTree 环防护（M4 挂账清偿）：walk 的 visited 集合——childIds 环
 *  （core 写路径不可达，防御 crafted doc_state / 直接 Y 变更）时干净跳过回边，
 *  保证任意形状下终止（模式同 core subtreeIds 的环防御注释）。 */

describe('docToXmindTree（环防护，防御性）', () => {
  it('childIds 自引用环（直接 Y 变更制造）→ 终止且环回边不进树', () => {
    const doc = createTemplateDoc({ title: '环', children: [{ text: 'a' }] });
    const childId = childrenIds(doc, ROOT_NODE_ID)[0] as string;
    // 直接 Y 变更（刻意绕开 core 写入口）把 root 塞进 a 的 children：root→a→root。
    // core 的换父/删除操作同步维护父 children，正常路径造不出环——此夹具模拟的
    // 是 crafted doc_state / 外部裸写的防御场景。不触发 normalize（transact 直调），
    // 环保持原样进入读路径。
    doc.transact(() => {
      const node = doc.getMap('nodes').get(childId) as Y.Map<unknown>;
      (node.get('children') as Y.Array<string>).push([ROOT_NODE_ID]);
    });

    const tree = docToXmindTree(doc); // 无 visited 防护时 root→a→root 无限递归 → RangeError

    expect(tree.title).toBe('环');
    expect(tree.children).toHaveLength(1);
    expect(tree.children[0]?.title).toBe('a');
    expect(tree.children[0]?.children).toHaveLength(0); // 指回 root 的环回边被跳过
  });

  it('正常树不受影响：先序层级完整映射（回归护栏）', () => {
    const doc = createTemplateDoc({ title: '根', children: [] });
    const a = addChild(doc, ROOT_NODE_ID, { text: 'a' });
    addChild(doc, a, { text: 'a1' });

    const tree = docToXmindTree(doc);
    expect(tree.title).toBe('根');
    expect(tree.children.map((c) => c.title)).toEqual(['a']);
    expect(tree.children[0]?.children.map((c) => c.title)).toEqual(['a1']);
  });

  it('描述映射（M7c-C1）：非空随节点携带，空/缺失不产出键', () => {
    const doc = createTemplateDoc({ title: '根', children: [] });
    const a = addChild(doc, ROOT_NODE_ID, { text: 'a' });
    addChild(doc, a, { text: 'a1' });
    setDescription(doc, a, '子任务一句话描述');

    const tree = docToXmindTree(doc);
    expect(tree.description).toBeUndefined(); // root 无描述：不产出键
    expect(tree.children[0]?.description).toBe('子任务一句话描述');
    expect(tree.children[0]?.children[0]?.description).toBeUndefined();
  });
});
