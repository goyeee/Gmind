import { afterEach, describe, expect, it, vi } from 'vitest';
import type * as Y from 'yjs';
import {
  addCanvas,
  addChild,
  canvasNodesMap,
  childrenIds,
  createTemplateDoc,
  listCanvases,
  ORIGIN_USER,
  ROOT_NODE_ID,
  rootIdOf,
  setActiveCanvas,
  setDescription,
  setHref,
  setIcon,
  setImage,
  setNodeSide,
  setStyle,
} from '@gmind/core';
import { buildXmind, parseXmind, unzipEntries, type XmindNode } from '@gmind/xmind-io';
import { buildXmindBytes, docToXmindSheets, docToXmindTree } from './xmind-export';

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
      // 多画布读取路径（刻意裸写夹具同口径）：单画布下与旧顶层 nodes 等价
      const node = canvasNodesMap(doc).get(childId) as Y.Map<unknown>;
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

describe('docToXmindTree（当前画布口径，Task 4 item 12 中间态）', () => {
  it('canvasId 给定：只出该画布子树（单 Sheet 中间态；画布 1 同文节点不越画布）', () => {
    const doc = createTemplateDoc({ title: '本周计划', children: [{ text: '甲' }] });
    const c1 = listCanvases(doc)[0]!.id;
    const c2 = addCanvas(doc, { name: '画布 2' });
    setActiveCanvas(doc, c1);
    addChild(doc, rootIdOf(doc, c2), { text: '乙' }, ORIGIN_USER, c2);

    const tree2 = docToXmindTree(doc, c2);
    expect(tree2.title).toBe('中心主题'); // 画布 2 新建 root 文本
    expect(tree2.children.map((c) => c.title)).toEqual(['乙']);

    const tree1 = docToXmindTree(doc, c1);
    expect(tree1.title).toBe('本周计划');
    expect(tree1.children.map((c) => c.title)).toEqual(['甲']);
    doc.destroy();
  });

  it('缺省 canvasId = core 缺省解析（meta.activeCanvasId 回退链，现状回归护栏）', () => {
    const doc = createTemplateDoc({ title: '本周计划', children: [{ text: '甲' }] });
    expect(docToXmindTree(doc).title).toBe('本周计划');
    doc.destroy();
  });
});

describe('docToXmindTree（导出对称 v2：href/style，2026-11-14 spec §六）', () => {
  it('setHref 写入的 http(s) 链接随节点携带；未写链接的节点不产键', () => {
    const doc = createTemplateDoc({ title: '根', children: [] });
    const a = addChild(doc, ROOT_NODE_ID, { text: 'a' });
    setHref(doc, a, 'https://example.com/page');

    const tree = docToXmindTree(doc);
    expect('href' in tree).toBe(false); // root 未写链接：不产 href 键
    expect(tree.children[0]?.href).toBe('https://example.com/page');
    doc.destroy();
  });

  it('非 http(s) href（crafted 裸写，setHref 会拒）不产键——与导入口径对称', () => {
    const doc = createTemplateDoc({ title: '根', children: [] });
    const a = addChild(doc, ROOT_NODE_ID, { text: 'a' });
    // 直接 Y 变更（刻意绕开 core 写入口）：setHref 只收 http/https，非 http(s) 值
    // 只能来自 crafted doc_state / 外部裸写——导出与导入解析同口径不携带（计超链接降级）。
    doc.transact(() => {
      const node = canvasNodesMap(doc).get(a) as Y.Map<unknown>;
      node.set('href', 'xapp:attachment/1');
    });

    const child = docToXmindTree(doc).children[0] as XmindNode;
    expect('href' in child).toBe(false);
    doc.destroy();
  });

  it('style 四键非空才产、值透传字符串：fontSize 数值 patch 落字符串形态；空串/表外键不携带', () => {
    const doc = createTemplateDoc({ title: '根', children: [] });
    const a = addChild(doc, ROOT_NODE_ID, { text: 'a' });
    setStyle(doc, a, { fill: '#FFEEEE', color: '#1F1F1F', fontSize: 16 });

    const child = docToXmindTree(doc).children[0] as XmindNode;
    // border 未写过：不产键；fontSize 数值 16 → 快照字符串 '16'（writeStylePatch 归一），
    // px 形状（'16px'）与非法过滤在 build 层 stylePropertiesOf，树层只透传。
    expect(child.style).toEqual({ fill: '#FFEEEE', color: '#1F1F1F', fontSize: '16' });

    // 空串（清除语义存值）与表外键（fontFamily——引擎不支持节点级覆盖，spec 裁定不映射）不携带
    setStyle(doc, a, { border: '', fontFamily: 'Georgia' });
    const after = docToXmindTree(doc).children[0] as XmindNode;
    expect(after.style).toEqual({ fill: '#FFEEEE', color: '#1F1F1F', fontSize: '16' });
    doc.destroy();
  });

  it('icons 全组透传：emoji/number 组树层不过滤（过滤职责在 build 层 iconsToMarkerIds）', () => {
    const doc = createTemplateDoc({ title: '根', children: [] });
    const a = addChild(doc, ROOT_NODE_ID, { text: 'a' });
    setIcon(doc, a, 'priority', 'p1');
    setIcon(doc, a, 'number', '1');
    setIcon(doc, a, 'emoji', '😀');

    const child = docToXmindTree(doc).children[0] as XmindNode;
    // emoji/number 无 XMind 原生 marker-id（v2 登记不写回），但不导出的过滤在
    // iconsToMarkerIds——树层全组原样携带，不做预滤。
    expect(child.icons).toEqual({ priority: ['p1'], number: ['1'], emoji: ['😀'] });
    doc.destroy();
  });
});

describe('docToXmindSheets 生产链结构串（2026-11-15 终审 Important#1）', () => {
  it('logic 结构画布经生产链导出 → parseXmind 还原 structureType；缺省画布为 mindmap', () => {
    // 生产链 = docToXmindSheets + buildXmind（exportXmind 的同一载荷，仅不走浏览器下载）。
    // 首画布建为 logic 结构（createTemplateDoc structure 落画布 structureType），
    // 第二画布走 addCanvas 缺省结构——覆盖 getMeta 缺省 'mindmap' 口径。
    const doc = createTemplateDoc({ title: '逻辑画布', structure: 'logic', children: [{ text: '甲' }] });
    addCanvas(doc, { name: '画布 2' });

    const parsed = parseXmind(buildXmind(docToXmindSheets(doc)));

    // structureType 经根 structureClass 三值映射写回再还原（roundtrip 同款口径）；
    // 生产链漏传时首画布还原为 undefined（XMind 落默认布局）——本断言钉住恒携带。
    expect(parsed.sheets.map((s) => s.structureType)).toEqual(['logic', 'mindmap']);
    doc.destroy();
  });
});

// ---------------------------------------------------------------------------
// docToXmindSheets 分侧写回 rightCount（2026-11-15 分侧忠实还原 Task 3＋Task 4 折算修正）：
// mindmap 画布 rightCount=「引擎渲染的右侧根分支数」——core countRightSideRootChildren
// 单源（持久 side 计数＋无 side 根子级按文档序 index 0-2 折算右＋墓碑防御，与 engine
// layout.ts `persistedSide ?? (i<3?'right':'left')` 精确同口径）→ sheet.rightCount，
// build 层落根扩展 right-number（右支计数；XMind 按「前 N 支居右」解读：前缀布局逐支一致、
// 非前缀首开按计数重排一次，见 xmind-export.ts 头注边界）；非 mindmap 画布不产键。Task 4
// 修正前只数持久 side，模板/混合文档的导出计数与画布渲染脱节、往返有损（T3 评审裁定：正确性修正非产品偏好）。
// ---------------------------------------------------------------------------

describe('docToXmindSheets 分侧写回 rightCount（2026-11-15 Task 3）', () => {
  it('持久侧别已知：rightCount=side 为 right 的根分支数（非「前 3 右」配额硬编码），经 build→parse 往返还原', () => {
    const doc = createTemplateDoc({ title: '根', children: [] });
    // addChild 逆时针定侧配额本身产 [R,R,R,L,L]；setNodeSide 翻转第 2 支为 left →
    // [R,L,R,L,L]（rightCount=2 ≠ 配额 3）——钉住计数读的是持久 side 快照值。
    const kids = ['一', '二', '三', '四', '五'].map((t) => addChild(doc, ROOT_NODE_ID, { text: t }));
    setNodeSide(doc, kids[0] as string, 'right');
    setNodeSide(doc, kids[1] as string, 'left');
    setNodeSide(doc, kids[2] as string, 'right');
    setNodeSide(doc, kids[3] as string, 'left');
    setNodeSide(doc, kids[4] as string, 'left');

    const sheet = docToXmindSheets(doc)[0]!;
    expect(sheet.structureType).toBe('mindmap');
    expect(sheet.rightCount).toBe(2);

    // 生产链整链：buildXmind 落根扩展 right-number → parseXmind 还原同值（roundtrip 同款口径）
    const parsed = parseXmind(buildXmind(docToXmindSheets(doc)));
    expect(parsed.sheets[0]!.rightCount).toBe(2);
    doc.destroy();
  });

  it('全左（持久 side 全 left）：rightCount=0 产键——0=全左合法值，全左状态不丢', () => {
    const doc = createTemplateDoc({ title: '根', children: [] });
    const kids = ['一', '二'].map((t) => addChild(doc, ROOT_NODE_ID, { text: t }));
    setNodeSide(doc, kids[0] as string, 'left');
    setNodeSide(doc, kids[1] as string, 'left');

    const sheet = docToXmindSheets(doc)[0]!;
    expect(sheet.rightCount).toBe(0);
    const parsed = parseXmind(buildXmind(docToXmindSheets(doc)));
    expect(parsed.sheets[0]!.rightCount).toBe(0);
    doc.destroy();
  });

  it('logic 画布不产 rightCount（非 mindmap 无语义，即使分支带持久侧别）', () => {
    const doc = createTemplateDoc({ title: '逻辑', structure: 'logic', children: [] });
    const a = addChild(doc, ROOT_NODE_ID, { text: 'a' });
    setNodeSide(doc, a, 'right');

    const sheet = docToXmindSheets(doc)[0]!;
    expect(sheet.structureType).toBe('logic');
    expect('rightCount' in sheet).toBe(false);
    doc.destroy();
  });

  it('全缺省模板文档（buildSubtree 直建 5 支、无任何持久 side）：折算 index 0-2 视右 → rightCount=3，经 build→parse 往返还原', () => {
    // 引擎对无 side 的根子级按文档序折算定侧（layout.ts:263 `persistedSide ??
    // (i < ROOT_SIDE_RIGHT_QUOTA ? 'right' : 'left')`）——导出计数必须镜像同一折算
    // （Task 4 修正），否则全缺省文档的导出件 right-number 与画布渲染不一致、往返有损。
    const doc = createTemplateDoc({
      title: '根',
      children: [{ text: '一' }, { text: '二' }, { text: '三' }, { text: '四' }, { text: '五' }],
    });

    const sheet = docToXmindSheets(doc)[0]!;
    expect(sheet.rightCount).toBe(3);
    const parsed = parseXmind(buildXmind(docToXmindSheets(doc)));
    expect(parsed.sheets[0]!.rightCount).toBe(3);
    doc.destroy();
  });

  it('混合文档（第 1 支拖入根级无 side、其余 addChild 持久 [R,R,L,L]）：引擎渲染 [R,R,R,L,L] → rightCount=3', () => {
    // 生产可达：EditorPage moveNode 到画布根，core 有意不写 side（operations.ts 侧别
    // 清理只删不写）——第 1 支无 side 按 index 0 折算右，与持久 R,R 汇总=3；修正前只数
    // 持久 side → 2，与引擎渲染（child0 折算右）脱节，先红。
    const doc = createTemplateDoc({ title: '根', children: [{ text: '一' }] }); // buildSubtree 直建：无 side
    addChild(doc, ROOT_NODE_ID, { text: '二' }); // 折算计数 1<3 → 持久 right
    addChild(doc, ROOT_NODE_ID, { text: '三' }); // 2<3 → right
    addChild(doc, ROOT_NODE_ID, { text: '四' }); // 3 → left
    addChild(doc, ROOT_NODE_ID, { text: '五' }); // left

    const sheet = docToXmindSheets(doc)[0]!;
    expect(sheet.rightCount).toBe(3);
    const parsed = parseXmind(buildXmind(docToXmindSheets(doc)));
    expect(parsed.sheets[0]!.rightCount).toBe(3);
    doc.destroy();
  });
});

// ---------------------------------------------------------------------------
// exportXmind 图片写回（2026-11-15 需求方反馈「XMind 导出带图」，M4 挂账清偿）：
// walk 收集 snap.image={key,w,h,placement} 任务 → 逐唯一 storage 键 fetch
// /api/images/{key}（读取端点公开，同 image-export inlineImages 先例）→
// resources/{键尾段} 入 zip extra + node.image={path,w,h,align} 回填；同 key 多节点
// 只 fetch 一次一份；单图失败（!res.ok / fetch throw）跳过图片不中断导出，missingImages
// 点名张数由调用方 toast。
// 断言钉在 buildXmindBytes（= exportXmind 去掉 DOM 下载段的纯产物层）：vitest 为
// node 环境无 document，a[download] 段不进单测——浏览器下载全链由 share-export.e2e
// 覆盖（同一 exportXmind 入口）。zip 产物用 unzipEntries 解包断言字节/manifest。
// ---------------------------------------------------------------------------

const PNG_BYTES = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 13, 10, 26, 10, 1, 2, 3]);

describe('exportXmind 图片写回（buildXmindBytes 产物层，2026-11-15）', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('带图节点：fetch /api/images/{key} → zip 含 resources/x.png（字节=mock）+ 树层 image 四键 + manifest 登记 + missingImages=0', async () => {
    const doc = createTemplateDoc({ title: '根', children: [{ text: 'a' }] });
    const a = childrenIds(doc, ROOT_NODE_ID)[0] as string;
    setImage(doc, a, { key: 'files/f1/x.png', w: 200, h: 100, placement: 'top' });

    const fetchMock = vi.fn(async () => new Response(PNG_BYTES));
    vi.stubGlobal('fetch', fetchMock);
    const { bytes, missingImages } = await buildXmindBytes(doc);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledWith('/api/images/files/f1/x.png');
    expect(missingImages).toBe(0);

    // zip：资源字节原样入包（资源名 = resources/{键尾段}）
    const entries = unzipEntries(bytes);
    expect(entries['resources/x.png']).toEqual(PNG_BYTES);
    // manifest 登记 extra 全部键（Task 1 build 层口径）
    const manifest = JSON.parse(new TextDecoder().decode(entries['manifest.json']!)) as {
      'file-entries': Record<string, unknown>;
    };
    expect(manifest['file-entries']['resources/x.png']).toEqual({});

    // 树层：image 四键回填（align=placement 透传）；build 层产 src='xap:'+path
    const parsed = parseXmind(bytes);
    const child = parsed.sheets[0]!.root.children[0]!;
    expect(child.image).toEqual({ path: 'resources/x.png', w: 200, h: 100, align: 'top' });
    const content = JSON.parse(new TextDecoder().decode(entries['content.json']!)) as Array<{
      rootTopic: { children: { attached: Array<{ image?: { src: string } }> } };
    }>;
    expect(content[0]!.rootTopic.children.attached[0]!.image?.src).toBe('xap:resources/x.png');
    doc.destroy();
  });

  it('同 key 两节点：只 fetch 一次、zip 仅一份 resources 条目、两节点 image 都回填', async () => {
    const doc = createTemplateDoc({ title: '根', children: [{ text: 'a' }, { text: 'b' }] });
    const ids = childrenIds(doc, ROOT_NODE_ID);
    for (const id of ids) setImage(doc, id, { key: 'files/f1/x.png', w: 200, h: 100, placement: 'top' });

    const fetchMock = vi.fn(async () => new Response(PNG_BYTES));
    vi.stubGlobal('fetch', fetchMock);
    const { bytes, missingImages } = await buildXmindBytes(doc);

    expect(fetchMock).toHaveBeenCalledTimes(1); // 同 key 去重：一份字节
    expect(missingImages).toBe(0);
    const entries = unzipEntries(bytes);
    expect(entries['resources/x.png']).toEqual(PNG_BYTES);
    expect(Object.keys(entries).filter((k) => k === 'resources/x.png')).toHaveLength(1);

    const parsed = parseXmind(bytes);
    expect(parsed.sheets[0]!.root.children.map((c) => c.image?.path)).toEqual([
      'resources/x.png',
      'resources/x.png',
    ]);
    doc.destroy();
  });

  it('fetch reject：该节点无 image + missingImages=1 + 其余层级照常导出', async () => {
    const doc = createTemplateDoc({ title: '根', children: [{ text: 'a' }, { text: 'b' }] });
    const ids = childrenIds(doc, ROOT_NODE_ID);
    setImage(doc, ids[0] as string, { key: 'files/f1/broken.png', w: 200, h: 100, placement: 'bottom' });

    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new Error('网络断开');
      }),
    );
    const { bytes, missingImages } = await buildXmindBytes(doc);

    expect(missingImages).toBe(1);
    const parsed = parseXmind(bytes);
    const root = parsed.sheets[0]!.root;
    expect(root.title).toBe('根');
    expect(root.children.map((c) => c.title)).toEqual(['a', 'b']); // 其余导出正常
    expect(root.children[0]!.image).toBeUndefined(); // 失败节点跳过图片
    expect(root.children[1]!.image).toBeUndefined();
    doc.destroy();
  });

  it('res !ok（404）同口径跳过：missingImages=1（res.ok 校验分支）', async () => {
    const doc = createTemplateDoc({ title: '根', children: [{ text: 'a' }] });
    const a = childrenIds(doc, ROOT_NODE_ID)[0] as string;
    setImage(doc, a, { key: 'files/f1/gone.png', w: 80, h: 60, placement: 'left' });

    vi.stubGlobal('fetch', vi.fn(async () => new Response(null, { status: 404 })));
    const { bytes, missingImages } = await buildXmindBytes(doc);

    expect(missingImages).toBe(1);
    const parsed = parseXmind(bytes);
    expect(parsed.sheets[0]!.root.children[0]!.image).toBeUndefined();
    doc.destroy();
  });

  it('无图文档：不 fetch、missingImages=0、zip 无 resources 条目', async () => {
    const doc = createTemplateDoc({ title: '根', children: [{ text: 'a' }] });

    const fetchMock = vi.fn(async () => new Response(PNG_BYTES));
    vi.stubGlobal('fetch', fetchMock);
    const { bytes, missingImages } = await buildXmindBytes(doc);

    expect(fetchMock).toHaveBeenCalledTimes(0);
    expect(missingImages).toBe(0);
    expect(Object.keys(unzipEntries(bytes))).toEqual(['content.json', 'manifest.json', 'metadata.json']);
    doc.destroy();
  });
});
