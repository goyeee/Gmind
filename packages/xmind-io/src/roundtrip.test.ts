// roundtrip.test.ts：buildXmind → parseXmind 往返保真（层级/备注/空子级/标记），产物可被 unzipSync 读回。
// 默认 node 环境：验证 content.json 主路径不依赖 DOM。
import { describe, expect, it } from 'vitest';
import { unzipSync } from 'fflate';
import { buildXmind, parseXmind } from './index';
import type { XmindNode } from './index';

describe('buildXmind → parseXmind 往返', () => {
  it('多级/备注/空子级/无备注节点深度相等', () => {
    const tree: XmindNode = {
      title: '根',
      note: '根备注',
      children: [
        { title: 'A', note: 'A 的备注', children: [{ title: 'A1', children: [] }] },
        { title: 'B', children: [] },
        { title: '', children: [] },
      ],
    };
    const parsed = parseXmind(buildXmind(tree));
    expect(parsed.root).toEqual(tree);
    expect(parsed.degraded).toEqual([]);
  });

  it('M7b-W1 标记往返：priority/flag/other(important) 经 marker-id 往返保真；无对应组单向丢失', () => {
    const tree: XmindNode = {
      title: '根',
      children: [
        { title: 'A', icons: { priority: ['p2'] }, children: [] },
        { title: 'B', icons: { flag: ['flag'] }, children: [] },
        { title: 'C', icons: { priority: ['low'], other: ['important'] }, children: [] },
      ],
    };
    const parsed = parseXmind(buildXmind(tree));
    expect(parsed.root.children[0].icons).toEqual({ priority: ['p2'] });
    expect(parsed.root.children[1].icons).toEqual({ flag: ['flag'] });
    expect(parsed.root.children[2].icons).toEqual({ priority: ['low'], other: ['important'] });
    expect(parsed.degraded).toEqual([]); // 导出的 marker 均有对应，零降级
  });

  it('构建产物可被 unzipSync 读回 content.json', () => {
    const bytes = buildXmind({ title: '根', children: [{ title: 'A', children: [] }] });
    const files = unzipSync(bytes);
    const content = new TextDecoder().decode(files['content.json']);
    const sheets = JSON.parse(content) as unknown[];
    expect(sheets).toHaveLength(1);
    expect(sheets[0]).toMatchObject({ class: 'sheet', rootTopic: { title: '根' } });
  });
});

