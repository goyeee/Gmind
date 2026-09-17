import { describe, expect, it } from 'vitest';
import * as Y from 'yjs';
import { ROOT_NODE_ID, countNodes, createTemplateDoc, docFromState, docToState, SEED_TEMPLATES } from './doc';

describe('createTemplateDoc', () => {
  it('生成 root + 嵌套子树，meta 完整', () => {
    const doc = createTemplateDoc({
      title: 'T',
      structure: 'mindmap',
      children: [{ text: 'A', children: [{ text: 'A1' }] }, { text: 'B' }],
    });
    const nodes = doc.getMap<Y.Map<unknown>>('nodes');
    expect(nodes.size).toBe(4); // root + A + A1 + B
    const root = nodes.get(ROOT_NODE_ID) as Y.Map<unknown>;
    expect(root.get('parentId')).toBe('');
    expect((root.get('children') as Y.Array<string>).length).toBe(2);
    const a = [...nodes.values()].find((n) => n.get('text') === 'A')!;
    expect(a.get('parentId')).toBe(ROOT_NODE_ID);
    expect(doc.getMap('meta').get('title')).toBe('T');
    expect(doc.getMap('meta').get('structureType')).toBe('mindmap');
  });

  it('二进制状态可无损往返', () => {
    const doc = createTemplateDoc({ title: 'R', children: [{ text: 'X' }] });
    const restored = docFromState(docToState(doc));
    expect(countNodes(restored)).toBe(2);
    expect(restored.getMap('meta').get('title')).toBe('R');
    const root = restored.getMap('nodes').get(ROOT_NODE_ID) as Y.Map<unknown>;
    expect(((root.get('children') as Y.Array<string>).get(0))).toBeTruthy();
  });

  it('SEED_TEMPLATES 为 3 个且每个 ≥3 节点', () => {
    expect(SEED_TEMPLATES.length).toBe(3);
    for (const tpl of SEED_TEMPLATES) {
      expect(countNodes(createTemplateDoc(tpl))).toBeGreaterThanOrEqual(3);
    }
  });
});
