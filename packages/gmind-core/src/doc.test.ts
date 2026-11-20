import { describe, expect, it } from 'vitest';
import * as Y from 'yjs';
import {
  LEGACY_OWNER_COLUMN_ID,
  ROOT_NODE_ID,
  countNodes,
  createTemplateDoc,
  docFromState,
  docToState,
  isLegacyTaskModelState,
  migrateLegacyToCanvases,
  migrateTaskModel,
  SEED_TEMPLATES,
} from './doc';
import { LEGACY_CANVAS_ID, canvasNodesMap, canvasSummariesMap, listCanvases } from './canvas';
import { addCanvas } from './canvas-ops';
import { getMeta } from './read';
import { getNode } from './read';
import { GmindCoreError } from './errors';
import { ORIGIN_SYSTEM } from './undo';

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
    // custom 列 schema（装载即收敛会把 schema 外 custom 键当孤儿清除——夹具带上
    // 'flag' 列定义，钉的是迁移深拷贝保真而非收敛豁免）。
    meta.set('customColumns', [{ id: 'flag', name: '旗标', type: 'text' }]);
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
        // 组键用目录内合法组（emoji，值本身即字形不走目录）：装载即收敛（normalize）
        // 会清除目录外旧组键——本用例钉的是深拷贝保真，不是收敛豁免。
        const icons = new Y.Map<unknown>();
        const groupIcons = new Y.Array<string>();
        groupIcons.push(['⭐', '🔥']);
        icons.set('emoji', groupIcons);
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
    expect((icons.get('emoji') as Y.Array<string>).toArray()).toEqual(['⭐', '🔥']);
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
    expect((legacyIcons.get('emoji') as Y.Array<string>).toArray()).toEqual(['⭐', '🔥']);
  });

  it('迁移确定性：两副本（同 clientID）装载同一旧文档产出字节级一致状态', () => {
    // docFromState 内部自建 Y.Doc（clientID 随机），字节级比较需固定 clientID 手工
    // 复刻装载步骤（applyUpdate + migrate；本用例不跑 normalize/side 回填——
    // 装载通道的收敛在 docFromState 内、确定性由「状态纯函数」保证，迁移本身亦确定性）。
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

// ══ 任务模型迁移（Task 2，2026-11-20 画布多人任务裁定）：spec
// docs/superpowers/specs/2026-11-20-canvas-task-model-design.md §五。旧任务模型
// （task.owners 多人共享 progress / 人员列旧形状）→ 单 ownerId + 独立总进度 +
// 逐人子进度；装载通道 docFromState 内 migrateLegacyToCanvases 之后、normalize
// 之前执行。 ══

/** 按文本定位节点 id（createTemplateDoc 的节点 id 是 ulid，夹具固定文本便于断言）。 */
function nodeIdByText(doc: Y.Doc, text: string, canvasId?: string): string {
  const nodes = canvasNodesMap(doc, canvasId);
  for (const [id, node] of nodes.entries()) {
    if (node instanceof Y.Map && node.get('text') === text) return id;
  }
  throw new Error('夹具节点未找到: ' + text);
}

/** 装载通道直写例外（docFromState 同口径）：给节点写旧任务模型 task/custom。
 *  nodeId 可传文本（'A'）或真实 id（'root'）。 */
function writeLegacyTask(
  doc: Y.Doc,
  nodeId: string,
  task: Record<string, unknown> | null,
  custom?: Record<string, unknown>,
  canvasId?: string,
): void {
  const id = nodeId === 'root' || /^[A-Z0-9]{26}$/.test(nodeId) ? nodeId : nodeIdByText(doc, nodeId, canvasId);
  const node = canvasNodesMap(doc, canvasId).get(id) as Y.Map<unknown>;
  doc.transact(() => {
    if (task !== null) {
      const t = new Y.Map<unknown>();
      for (const [k, v] of Object.entries(task)) t.set(k, v);
      node.set('task', t);
    }
    if (custom !== undefined) {
      const c = new Y.Map<unknown>();
      for (const [k, v] of Object.entries(custom)) c.set(k, v);
      node.set('custom', c);
    }
  }, ORIGIN_SYSTEM);
}

function setCustomColumns(doc: Y.Doc, cols: Array<{ id: string; name: string; type: string; weighted?: boolean }>): void {
  doc.transact(() => {
    doc.getMap('meta').set('customColumns', cols);
  }, ORIGIN_SYSTEM);
}

describe('migrateTaskModel（旧任务模型 → 单负责人/独立总进度/逐人子进度）', () => {
  it('旧单负责人：owners 第一项转 ownerId，ownerProgress 取旧原始 progress，总进度不变，不建列', () => {
    const doc = createTemplateDoc({ title: 'T', children: [{ text: 'A' }] });
    writeLegacyTask(doc, 'A', { status: 'doing', progress: 40, owners: ['u1'] });
    migrateTaskModel(doc);
    const task = getNode(doc, nodeIdByText(doc, 'A'))!.task;
    expect(task.ownerId).toBe('u1');
    expect(task.ownerProgress).toBe(40);
    expect(task.progress).toBe(40);
    expect(task.status).toBe('doing');
    // 存储侧 owners 键已删（幂等判定 + 读侧不再回退旧负责人）
    const taskMap = canvasNodesMap(doc).get(nodeIdByText(doc, 'A')) as Y.Map<unknown>;
    expect(((taskMap.get('task') as Y.Map<unknown>).has('owners'))).toBe(false);
    expect(getMeta(doc).customColumns).toHaveLength(0); // 单负责人不建「原负责人」列
  });

  it('旧多负责人：第一人留任总负责人，其余进确定 ID「原负责人」列（每人子进度=旧共享进度）', () => {
    const doc = createTemplateDoc({ title: 'T', children: [{ text: 'A' }] });
    writeLegacyTask(doc, 'A', { status: 'doing', progress: 50, owners: ['u1', 'u2', 'u3'] });
    migrateTaskModel(doc);
    const task = getNode(doc, nodeIdByText(doc, 'A'))!.task;
    expect(task.ownerId).toBe('u1');
    expect(task.ownerProgress).toBe(50); // 总负责人子进度=旧原始 progress
    expect(task.progress).toBe(50); // 旧显示值（无人员列 → 旧有效进度=progress）
    const custom = getNode(doc, nodeIdByText(doc, 'A'))!.custom ?? {};
    expect(custom[LEGACY_OWNER_COLUMN_ID]).toEqual({ u2: { progress: 50 }, u3: { progress: 50 } });
    const cols = getMeta(doc).customColumns;
    expect(cols).toHaveLength(1);
    expect(cols[0]).toMatchObject({ id: LEGACY_OWNER_COLUMN_ID, name: '原负责人', type: 'assignee' });
  });

  it('多负责人+人员列：新总进度=迁移前旧有效进度（owners 1 项权重 1 + 各列条目 weight 缺省 1 加权平均）', () => {
    const doc = createTemplateDoc({ title: 'T', children: [{ text: 'A' }] });
    setCustomColumns(doc, [{ id: 'col-a', name: '执行人', type: 'assignee', weighted: true }]);
    writeLegacyTask(
      doc,
      'A',
      { status: 'doing', progress: 50, owners: ['u1', 'u2'] },
      { 'col-a': { a1: { progress: 30, weight: 2 }, a2: { progress: 80 } } },
    );
    migrateTaskModel(doc);
    const task = getNode(doc, nodeIdByText(doc, 'A'))!.task;
    expect(task.ownerId).toBe('u1');
    expect(task.ownerProgress).toBe(50);
    // 旧有效进度 = round((50×1 + 30×2 + 80×1) / (1+2+1)) = round(190/4) = 48
    expect(task.progress).toBe(48);
    // 既有人员列条目保持原值，不并入「原负责人」列
    expect(getNode(doc, nodeIdByText(doc, 'A'))!.custom!['col-a']).toEqual({ a1: { progress: 30, weight: 2 }, a2: { progress: 80 } });
    expect(getNode(doc, nodeIdByText(doc, 'A'))!.custom![LEGACY_OWNER_COLUMN_ID]).toEqual({ u2: { progress: 50 } });
  });

  it('人员列旧 number 简形归一为逐人嵌套；无 owners 但有人员列 → 新总进度=旧有效进度（人员加权）', () => {
    const doc = createTemplateDoc({ title: 'T', children: [{ text: 'A' }] });
    setCustomColumns(doc, [{ id: 'col-a', name: '执行人', type: 'assignee' }]);
    writeLegacyTask(doc, 'A', { status: 'doing', progress: 20, owners: [] }, { 'col-a': { a1: 60 } });
    migrateTaskModel(doc);
    expect(getNode(doc, nodeIdByText(doc, 'A'))!.custom!['col-a']).toEqual({ a1: { progress: 60 } });
    expect(getNode(doc, nodeIdByText(doc, 'A'))!.task.ownerId).toBeNull(); // 空 owners：无总负责人
    expect(getNode(doc, nodeIdByText(doc, 'A'))!.task.ownerProgress).toBeNull();
    expect(getNode(doc, nodeIdByText(doc, 'A'))!.task.progress).toBe(60); // 旧显示值 = 人员加权（60×1/1）
  });

  it('旧节点从未写 owners 键、只有人员列：仍保留旧显示总进度', () => {
    const doc = createTemplateDoc({ title: 'T', children: [{ text: 'A' }] });
    setCustomColumns(doc, [{ id: 'col-a', name: '执行人', type: 'assignee' }]);
    writeLegacyTask(doc, 'A', { status: 'doing', progress: 20 }, { 'col-a': { a1: 60 } });
    migrateTaskModel(doc);
    expect(getNode(doc, nodeIdByText(doc, 'A'))!.task.progress).toBe(60);
    expect(getNode(doc, nodeIdByText(doc, 'A'))!.task.ownerId).toBeNull();
  });

  it('旧节点从未写 owners 键且 done 异常：保留完成事实并拉满总进度', () => {
    const doc = createTemplateDoc({ title: 'T', children: [{ text: 'A' }] });
    setCustomColumns(doc, [{ id: 'col-a', name: '执行人', type: 'assignee' }]);
    writeLegacyTask(doc, 'A', { status: 'done', progress: 30 }, { 'col-a': { a1: 30 } });
    migrateTaskModel(doc);
    expect(getNode(doc, nodeIdByText(doc, 'A'))!.task).toMatchObject({ status: 'done', progress: 100 });
  });

  it('旧人员列关闭自定义比重：遗留 weight 不参与迁移前显示值', () => {
    const doc = createTemplateDoc({ title: 'T', children: [{ text: 'A' }] });
    setCustomColumns(doc, [{ id: 'col-a', name: '执行人', type: 'assignee', weighted: false }]);
    writeLegacyTask(doc, 'A', { status: 'doing', progress: 50, owners: ['u1'] }, { 'col-a': { a1: { progress: 100, weight: 3 } } });
    migrateTaskModel(doc);
    expect(getNode(doc, nodeIdByText(doc, 'A'))!.task.progress).toBe(75);
  });

  it('迁移后总进度 100 时状态统一为 done，避免编辑器与待办索引相反', () => {
    const doc = createTemplateDoc({ title: 'T', children: [{ text: 'A' }, { text: 'B' }] });
    writeLegacyTask(doc, 'A', { status: 'blocked', progress: 100, owners: ['u1'] });
    setCustomColumns(doc, [{ id: 'col-a', name: '执行人', type: 'assignee' }]);
    writeLegacyTask(doc, 'B', { status: 'doing', progress: 0, owners: [] }, { 'col-a': { a1: 100 } });
    migrateTaskModel(doc);
    expect(getNode(doc, nodeIdByText(doc, 'A'))!.task).toMatchObject({ status: 'done', progress: 100 });
    expect(getNode(doc, nodeIdByText(doc, 'B'))!.task).toMatchObject({ status: 'done', progress: 100 });
  });

  it('旧单画布顶层 nodes 探针：含 owners 即识别为待迁移并保留升级前版本机会', () => {
    const legacy = createLegacyDoc();
    const legacyNode = legacy.getMap<Y.Map<unknown>>('nodes').get('child-1')!;
    const task = legacyNode.get('task');
    expect(task).toBeInstanceOf(Y.Map);
    legacy.transact(() => (task as Y.Map<unknown>).set('owners', ['u1', 'u2']));
    expect(isLegacyTaskModelState(docToState(legacy))).toBe(true);
  });

  it('旧 done 异常保留完成事实：总进度/负责人子进度拉满 100，完成日期原值保留（缺失不伪造）', () => {
    const doc = createTemplateDoc({ title: 'T', children: [{ text: 'A' }, { text: 'B' }] });
    writeLegacyTask(doc, 'A', { status: 'done', progress: 30, owners: ['u1', 'u2'], doneDate: '2026-01-02' });
    writeLegacyTask(doc, 'B', { status: 'done', progress: 0, owners: ['u1'] });
    migrateTaskModel(doc);
    expect(getNode(doc, nodeIdByText(doc, 'A'))!.task).toMatchObject({ status: 'done', progress: 100, ownerProgress: 100, doneDate: '2026-01-02' });
    expect(getNode(doc, nodeIdByText(doc, 'B'))!.task).toMatchObject({ status: 'done', progress: 100, ownerProgress: 100 });
    expect(getNode(doc, nodeIdByText(doc, 'B'))!.task.doneDate).toBeNull(); // 不伪造历史完成日期
    // done 的其余负责人同样进列（子进度=完成事实 100）
    expect(getNode(doc, nodeIdByText(doc, 'A'))!.custom![LEGACY_OWNER_COLUMN_ID]).toEqual({ u2: { progress: 100 } });
  });

  it('多画布全量迁移：「原负责人」列 doc 级只建一次', () => {
    const doc = createTemplateDoc({ title: 'T', children: [{ text: 'A' }] });
    const c1 = listCanvases(doc)[0]!.id;
    const c2 = addCanvas(doc, { name: '画布 2' });
    writeLegacyTask(doc, 'A', { status: 'doing', progress: 40, owners: ['u1', 'u2'] }, undefined, c1);
    writeLegacyTask(doc, '中心主题', { status: 'doing', progress: 10, owners: ['u9', 'u8'] }, undefined, c2);
    migrateTaskModel(doc);
    expect(getNode(doc, nodeIdByText(doc, 'A', c1), c1)!.task.ownerId).toBe('u1');
    const c2RootId = nodeIdByText(doc, '中心主题', c2);
    expect(getNode(doc, c2RootId, c2)!.task.ownerId).toBe('u9');
    expect(getNode(doc, c2RootId, c2)!.custom![LEGACY_OWNER_COLUMN_ID]).toEqual({ u8: { progress: 10 } });
    expect(getMeta(doc).customColumns).toHaveLength(1); // 两画布共用一列 schema
  });

  it('幂等：重复迁移零新增写入，重装载收敛后字节稳定', () => {
    const doc = createTemplateDoc({ title: 'T', children: [{ text: 'A' }] });
    writeLegacyTask(doc, 'A', { status: 'doing', progress: 50, owners: ['u1', 'u2'] });
    migrateTaskModel(doc);
    const once = docToState(doc);
    migrateTaskModel(doc); // 判定不命中（owners 键已删、人员列已归一）→ 零写
    expect(docToState(doc)).toEqual(once);
    const again = docFromState(once);
    // docFromState 的 normalize 会对夹具**直写未收敛**的状态补建进度徽章（repair
    // 合法收敛，与迁移无关）——迁移幂等断言看两处：重复迁移字节零变（上行）+
    // 重装载产物再装载字节零变（收敛后稳定），迁移语义字段（ownerId/列条目）恒正确。
    const stable = docFromState(docToState(again));
    expect(docToState(stable)).toEqual(docToState(again));
    expect(getNode(again, nodeIdByText(again, 'A'))!.task.ownerId).toBe('u1');
    expect(getNode(again, nodeIdByText(again, 'A'))!.custom![LEGACY_OWNER_COLUMN_ID]).toEqual({ u2: { progress: 50 } });
  });

  it('列上限异常：schema 已满时无法建「原负责人」列 → 抛错且原文档零变更', () => {
    const doc = createTemplateDoc({ title: 'T', children: [{ text: 'A' }] });
    setCustomColumns(
      doc,
      Array.from({ length: 20 }, (_, i) => ({ id: `col-${i}`, name: `列${i}`, type: 'text' as const })),
    );
    writeLegacyTask(doc, 'A', { status: 'doing', progress: 50, owners: ['u1', 'u2'] });
    const before = docToState(doc);
    expect(() => migrateTaskModel(doc)).toThrow(GmindCoreError);
    expect(docToState(doc)).toEqual(before); // 校验先于事务：抛错即零变更、人员不丢
  });

  it('迁移预留列 ID 被文本列占用：中止且原文档零变更，不把负责人写进文本列', () => {
    const doc = createTemplateDoc({ title: 'T', children: [{ text: 'A' }] });
    setCustomColumns(doc, [{ id: LEGACY_OWNER_COLUMN_ID, name: '已有文本列', type: 'text' }]);
    writeLegacyTask(doc, 'A', { status: 'doing', progress: 50, owners: ['u1', 'u2'] });
    const before = docToState(doc);
    expect(() => migrateTaskModel(doc)).toThrow(/迁移列标识/);
    expect(docToState(doc)).toEqual(before);
  });

  it('新模型文档零迁移：已含 ownerId/无 owners 键 → 直接返回（docToState 不变）', () => {
    const doc = createTemplateDoc({ title: 'T', children: [{ text: 'A' }] });
    writeLegacyTask(doc, 'A', { status: 'doing', progress: 40, ownerId: 'u1' });
    const before = docToState(doc);
    migrateTaskModel(doc);
    expect(docToState(doc)).toEqual(before);
  });

  it('crafted status 迁移按 progress 派生：存储与读侧显示一致（评审发现修复）', () => {
    const doc = createTemplateDoc({ title: 'T', children: [{ text: 'A' }] });
    writeLegacyTask(doc, 'A', { status: 'crafted-状态', progress: 50, owners: [] });
    migrateTaskModel(doc);
    expect(getNode(doc, nodeIdByText(doc, 'A'))!.task).toMatchObject({ status: 'doing', progress: 50 });
    doc.destroy();
  });

  it('docFromState 全管线：旧任务模型随装载自动迁移（多画布迁移之后、normalize 之前）', () => {
    const doc = createTemplateDoc({ title: 'T', children: [{ text: 'A' }] });
    writeLegacyTask(doc, 'A', { status: 'doing', progress: 50, owners: ['u1', 'u2', 'u3'] });
    const loaded = docFromState(docToState(doc));
    const task = getNode(loaded, nodeIdByText(loaded, 'A'))!.task;
    expect(task.ownerId).toBe('u1');
    expect(task.ownerProgress).toBe(50);
    expect(task.progress).toBe(50);
    expect(getNode(loaded, nodeIdByText(loaded, 'A'))!.custom![LEGACY_OWNER_COLUMN_ID]).toEqual({ u2: { progress: 50 }, u3: { progress: 50 } });
  });
});
