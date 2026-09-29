// build.test.ts：buildXmind 产物结构——可被 unzipSync 读回，content.json 形状正确。
import { describe, expect, it } from 'vitest';
import { unzipSync } from 'fflate';
import { buildXmind } from './index';
import type { XmindNode } from './index';

describe('buildXmind', () => {
  it('生成 zip：含 content.json 与 metadata.json，content.json 可解析且形状正确', () => {
    const tree: XmindNode = {
      title: '中心',
      note: '根备注',
      children: [{ title: 'A', children: [{ title: 'A1', children: [] }] }],
    };
    const bytes = buildXmind(tree);
    const files = unzipSync(bytes);
    expect(Object.keys(files).sort()).toEqual(['content.json', 'metadata.json']);
    const sheets = JSON.parse(new TextDecoder().decode(files['content.json']));
    expect(sheets).toHaveLength(1);
    expect(sheets[0].class).toBe('sheet');
    expect(sheets[0].rootTopic).toEqual({
      class: 'topic',
      title: '中心',
      notes: { plain: { content: '根备注' } },
      children: {
        attached: [
          { class: 'topic', title: 'A', children: { attached: [{ class: 'topic', title: 'A1' }] } },
        ],
      },
    });
    expect(JSON.parse(new TextDecoder().decode(files['metadata.json']))).toEqual({ creator: 'Gmind' });
  });

  it('无备注/无子级时不产生冗余字段', () => {
    const bytes = buildXmind({ title: '单点', children: [] });
    const files = unzipSync(bytes);
    const sheets = JSON.parse(new TextDecoder().decode(files['content.json']));
    expect(sheets[0].rootTopic).toEqual({ class: 'topic', title: '单点' });
  });

  it('M7b-W1 标记导出各数组逐枚（有原生 marker-id 对应者）：priority-N / flag-red / star-red；其余不导出', () => {
    const tree: XmindNode = {
      title: '根',
      children: [
        {
          title: 'A',
          icons: { priority: ['p4'], flag: ['flag'] },
          children: [
            { title: 'A1', icons: { priority: ['urgent'] }, children: [] }, // urgent→1（最高档）
          ],
        },
        { title: 'B', icons: { other: ['important'] }, children: [] },
        { title: 'C', icons: { other: ['done'], emoji: ['😄'] }, children: [] }, // 无原生对应：不导出
      ],
    };
    const files = unzipSync(buildXmind(tree));
    const sheets = JSON.parse(new TextDecoder().decode(files['content.json']));
    const rootTopic = sheets[0].rootTopic;
    expect(rootTopic.markers).toBeUndefined(); // 根无标记不产 markers 键
    const a = rootTopic.children.attached[0];
    expect(a.markers).toEqual([{ markerId: 'priority-5' }, { markerId: 'flag-red' }]);
    expect(a.children.attached[0].markers).toEqual([{ markerId: 'priority-1' }]); // urgent→1
    expect(rootTopic.children.attached[1].markers).toEqual([{ markerId: 'star-red' }]);
    expect(rootTopic.children.attached[2].markers).toBeUndefined(); // done/emoji 无对应，不导出
  });
});
