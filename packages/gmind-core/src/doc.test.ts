import { describe, expect, it } from 'vitest';
import * as Y from 'yjs';
import { ROOT_NODE_ID, countNodes, createTemplateDoc, docFromState, docToState, migrateLegacyToCanvases, SEED_TEMPLATES } from './doc';
import { LEGACY_CANVAS_ID, canvasNodesMap, canvasSummariesMap, listCanvases } from './canvas';

describe('createTemplateDoc', () => {
  it('生成 root + 嵌套子树，meta 完整', () => {
    const doc = createTemplateDoc({
      title: 'T',
      structure: 'mindmap',
      children: [{ text: 'A', children: [{ text: 'A1' }] }, { text: 'B' }],
    });
    const nodes = canvasNodesMap(doc);
    expect(nodes.size).toBe(4); // root + A + A1 + B
    const root = nodes.get(ROOT_NODE_ID) as Y.Map<unknown>;
    expect(root.get('parentId')).toBe('');
    expect((root.get('children') as Y.Array<string>).length).toBe(2);
    const a = [...nodes.values()].find((n) => n.get('text') === 'A')!;
    expect(a.get('parentId')).toBe(ROOT_NODE_ID);
    expect(doc.getMap('meta').get('title')).toBe('T');
    expect(doc.getMap('meta').get('structureType')).toBe('mindmap');
  });

  it('rootText 覆盖 root 文本而 meta.title 保持（中心主题裁定 2026-10-09：仅新建空白文档传）', () => {
    const doc = createTemplateDoc({ title: '未命名脑图', children: [], rootText: '中心主题' });
    const root = canvasNodesMap(doc).get(ROOT_NODE_ID) as Y.Map<unknown>;
    expect(root.get('text')).toBe('中心主题');
    expect(doc.getMap('meta').get('title')).toBe('未命名脑图');
  });

  it('rootText 缺省回退 title（既有调用方行为不变）', () => {
    const doc = createTemplateDoc({ title: 'T', children: [{ text: 'X' }] });
    const root = canvasNodesMap(doc).get(ROOT_NODE_ID) as Y.Map<unknown>;
    expect(root.get('text')).toBe('T');
  });

  it('二进制状态可无损往返', () => {
    const doc = createTemplateDoc({ title: 'R', children: [{ text: 'X' }] });
    const restored = docFromState(docToState(doc));
    expect(countNodes(restored)).toBe(2);
    expect(restored.getMap('meta').get('title')).toBe('R');
    const root = canvasNodesMap(restored).get(ROOT_NODE_ID) as Y.Map<unknown>;
    expect(((root.get('children') as Y.Array<string>).get(0))).toBeTruthy();
  });

  it('SEED_TEMPLATES 为 3 个且每个 ≥3 节点', () => {
    expect(SEED_TEMPLATES.length).toBe(3);
    for (const tpl of SEED_TEMPLATES) {
      expect(countNodes(createTemplateDoc(tpl))).toBeGreaterThanOrEqual(3);
    }
  });

  it('产出新形状：单画布（rootId=root、name=画布 1）承载 nodes/summaries，meta.activeCanvasId 指向它', () => {
    const doc = createTemplateDoc({ title: 'T', structure: 'logic', theme: 'dark', children: [{ text: 'X' }] });
    const canvases = listCanvases(doc);
    expect(canvases).toHaveLength(1);
    expect(canvases[0]).toMatchObject({ rootId: ROOT_NODE_ID, name: '画布 1', structureType: 'logic', themeId: 'dark' });
    expect(doc.getMap('meta').get('activeCanvasId')).toBe(canvases[0]!.id);
    expect(canvasSummariesMap(doc).size).toBe(0);
    expect(doc.getMap('nodes').size).toBe(0); // 顶层旧根类型不再写
  });
});

/** 手工搭建旧形状文档（顶层 nodes/summaries 根类型；固定 id 便于确定性断言）。 */
function createLegacyDoc(): Y.Doc {
  const doc = new Y.Doc();
  doc.transact(() => {
    const meta = doc.getMap('meta');
    meta.set('title', '旧文档');
    meta.set('structureType', 'logic');
    meta.set('themeId', 'dark');
    const nodes = doc.getMap<Y.Map<unknown>>('nodes');
    const root = new Y.Map<unknown>();
    root.set('text', '旧根');
    root.set('parentId', '');
    const rootChildren = new Y.Array<string>();
    root.set('children', rootChildren);
    nodes.set(ROOT_NODE_ID, root);
    for (const [id, text] of [['child-1', '子主题'], ['child-2', '子主题2']] as const) {
      const child = new Y.Map<unknown>();
      child.set('text', text);
      child.set('parentId', ROOT_NODE_ID);
      child.set('children', new Y.Array<string>());
      if (id === 'child-1') {
        // 嵌套 Y 类型字段（icons: Map<组, Array<string>>；task/custom: Map；数组内嵌 Y.Map）
        const icons = new Y.Map<unknown>();
        const groupIcons = new Y.Array<string>();
        groupIcons.push(['⭐', '🔥']);
        icons.set('组一', groupIcons);
        child.set('icons', icons);
        const task = new Y.Map<unknown>();
        task.set('status', 'done');
        task.set('assignee', '张三');
        child.set('task', task);
        const custom = new Y.Map<unknown>();
        custom.set('flag', 'red');
        child.set('custom', custom);
        const attachments = new Y.Array<unknown>();
        const link = new Y.Map<unknown>();
        link.set('type', 'link');
        link.set('url', 'https://example.com');
        attachments.push([link]);
        child.set('attachments', attachments);
      }
      nodes.set(id, child);
    }
    rootChildren.push(['child-1', 'child-2']);
    const summaries = doc.getMap<Y.Map<unknown>>('summaries');
    const summary = new Y.Map<unknown>();
    summary.set('label', '概要一');
    const summaryNodeIds = new Y.Array<string>();
    summaryNodeIds.push(['child-1', 'child-2']);
    summary.set('nodeIds', summaryNodeIds);
    summaries.set('sum-1', summary);
  });
  return doc;
}

describe('docFromState 装载迁移（旧形状 → 多画布）', () => {
  it('旧形状文档装载迁移：nodes/summaries/structure/theme 深拷贝进 canvas-1，旧根类型清空', () => {
    const legacy = createLegacyDoc();
    const a = docFromState(docToState(legacy));
    const canvases = listCanvases(a);
    expect(canvases).toHaveLength(1);
    expect(canvases[0]).toMatchObject({
      id: LEGACY_CANVAS_ID,
      name: '画布 1',
      rootId: ROOT_NODE_ID,
      structureType: 'logic',
      themeId: 'dark',
    });
    const nodes = canvasNodesMap(a);
    expect(nodes.size).toBe(3); // root + 2 子
    expect((nodes.get('child-1') as Y.Map<unknown>).get('text')).toBe('子主题');
    const root = nodes.get(ROOT_NODE_ID) as Y.Map<unknown>;
    expect((root.get('children') as Y.Array<string>).toArray()).toEqual(['child-1', 'child-2']);
    const summaries = canvasSummariesMap(a);
    expect(summaries.size).toBe(1);
    expect((summaries.get('sum-1') as Y.Map<unknown>).get('label')).toBe('概要一');
    expect(a.getMap('nodes').size).toBe(0); // 旧根类型已清空
    expect(a.getMap('summaries').size).toBe(0);
    expect(a.getMap('meta').get('activeCanvasId')).toBe(LEGACY_CANVAS_ID);
  });

  it('迁移深拷贝嵌套 Y 类型：icons/task/custom/数组内 Y.Map 内容完整可读，且旧文档不被掏空', () => {
    const legacy = createLegacyDoc();
    const a = docFromState(docToState(legacy));
    const child = canvasNodesMap(a).get('child-1') as Y.Map<unknown>;
    const icons = child.get('icons') as Y.Map<unknown>;
    expect((icons.get('组一') as Y.Array<string>).toArray()).toEqual(['⭐', '🔥']);
    const task = child.get('task') as Y.Map<unknown>;
    expect(task.get('status')).toBe('done');
    expect(task.get('assignee')).toBe('张三');
    const custom = child.get('custom') as Y.Map<unknown>;
    expect(custom.get('flag')).toBe('red');
    const attachments = child.get('attachments') as Y.Array<unknown>;
    expect((attachments.get(0) as Y.Map<unknown>).get('url')).toBe('https://example.com');
    // 深拷贝而非引用搬运：源文档自身嵌套内容不被掏空（旧壳删键后 GC 会回收被透传的类型）
    const legacyChild = legacy.getMap('nodes').get('child-1') as Y.Map<unknown>;
    const legacyIcons = legacyChild.get('icons') as Y.Map<unknown>;
    expect((legacyIcons.get('组一') as Y.Array<string>).toArray()).toEqual(['⭐', '🔥']);
  });

  it('迁移确定性：两副本（同 clientID）装载同一旧文档产出字节级一致状态', () => {
    // docFromState 内部自建 Y.Doc（clientID 随机），字节级比较需固定 clientID 手工
    // 复刻装载步骤（docFromState 其余步骤对新形状均为零写入：normalize 守卫返回 0、
    // side 回填读空顶层 nodes 为空计划）。
    const legacy = createLegacyDoc();
    const state = docToState(legacy);
    const loadReplica = (clientID: number): Y.Doc => {
      const doc = new Y.Doc();
      doc.clientID = clientID;
      Y.applyUpdate(doc, state);
      migrateLegacyToCanvases(doc);
      return doc;
    };
    // 用大固定值而非小整数（42）：随机 clientID 理论可撞上小整数，固定值远离常见
    // 取值区间，避免与随机分配/其他夹具偶然同号导致字节级比较假阳性。
    const a = loadReplica(4000000000);
    const b = loadReplica(4000000000);
    expect(Y.encodeStateAsUpdate(a)).toEqual(Y.encodeStateAsUpdate(b));
    expect(listCanvases(a)).toHaveLength(1);
    expect(canvasNodesMap(a).size).toBe(3);
  });

  it('迁移幂等：新形状文档再进 docFromState 不产生第二画布', () => {
    const doc = createTemplateDoc({ title: 'T', children: [{ text: 'A' }] });
    const once = docFromState(docToState(doc));
    const twice = docFromState(docToState(once));
    expect(listCanvases(twice)).toHaveLength(1);
    expect(countNodes(twice)).toBe(2);
  });
});
