// roundtrip.test.ts：buildXmind → parseXmind 往返保真（层级/备注/空子级/标记），产物可被 unzipSync 读回。
// 默认 node 环境：验证 content.json 主路径不依赖 DOM。
// 2026-11-14 导出写回 v2：原生族（有 XMind 原生 marker-id 对应的值）「导入→导出→再导入」
// Gmind 值级集合稳定；emoji/number 组导出零虚增 marker-id（spec §3.2 roundtrip 口径）。
// priority urgent/high/mid 三档为「形近改写」且已逐个钉死（现行 PRIORITY_EXPORT 档位落点，
// spec §3.2「现行」表）：首循环 urgent→p0、high→mid、mid→low；第二循环落定 p0/low/low
// （mid→priority-7→low 后恒定）。仍不在断言范围的往返残余（spec §七登记不导出）：
// progress none（task-start 未实测）、mood sad/cry（无实测 id）。
// 2026-11-15 v2.1（导出返工 Task 1）：structureType 经根 structureClass 往返还原
// （id/manifest/metadata 为写回侧键，解析侧不携带，不在本文件断言面）。
// 2026-11-15 v2.3（导出保真第三波 Task 1）：image 经 topic.image{src:'xap:<path>'}
// + extra 资源字节往返还原 {path,w,h,align}（解析侧剥 xap: 查 resources 表的逆）。
// 2026-11-15 分侧忠实还原 Task 2：rightCount 经根 topic extensions right-number
// 往返还原（build String(n) ↔ parse parseInt 互逆；仅 mindmap 画布落键）。
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
    const parsed = parseXmind(buildXmind([{ title: '', root: tree }]));
    expect(parsed.sheets[0].root).toEqual(tree);
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
    const parsed = parseXmind(buildXmind([{ title: '', root: tree }]));
    expect(parsed.sheets[0].root.children[0].icons).toEqual({ priority: ['p2'] });
    expect(parsed.sheets[0].root.children[1].icons).toEqual({ flag: ['flag'] });
    expect(parsed.sheets[0].root.children[2].icons).toEqual({ priority: ['low'], other: ['important'] });
    expect(parsed.degraded).toEqual([]); // 导出的 marker 均有对应，零降级
  });

  it('M7c-C1 描述往返：description 经自定义键往返保真；空/缺失不产生键', () => {
    const tree: XmindNode = {
      title: '根',
      description: '一句话任务描述',
      children: [
        { title: 'A', description: '子任务描述', children: [] },
        { title: 'B', children: [] }, // 无 description：导入侧同样不产出键
      ],
    };
    const bytes = buildXmind([{ title: '', root: tree }]);
    const sheets = JSON.parse(new TextDecoder().decode(unzipSync(bytes)['content.json'])) as Array<{
      rootTopic: Record<string, unknown>;
    }>;
    const attached = (sheets[0].rootTopic.children as { attached: Array<Record<string, unknown>> }).attached;
    expect(sheets[0].rootTopic.description).toBe('一句话任务描述');
    expect(attached[0].description).toBe('子任务描述');
    expect('description' in attached[1]).toBe(false);
    const parsed = parseXmind(bytes);
    expect(parsed.sheets[0].root).toEqual(tree); // 深度相等：读回逐字节还原（含 B 无 description）
    expect(parsed.degraded).toEqual([]);
  });

  it('构建产物可被 unzipSync 读回 content.json', () => {
    const bytes = buildXmind([{ title: '', root: { title: '根', children: [{ title: 'A', children: [] }] } }]);
    const files = unzipSync(bytes);
    const content = new TextDecoder().decode(files['content.json']);
    const sheets = JSON.parse(content) as unknown[];
    expect(sheets).toHaveLength(1);
    expect(sheets[0]).toMatchObject({ class: 'sheet', rootTopic: { title: '根' } });
  });

  it('v2 原生族往返：导入→导出→再导入 Gmind icons 值级集合稳定（含样式/href；形近三档钉死）', () => {
    // 值级恒等的稳定族（「实测/推断」id 的逆映射，往↔返零改写）
    const STABLE_CHILDREN: XmindNode[] = [
      { title: '优先级', icons: { priority: ['p4'] }, children: [] },
      { title: '低档', icons: { priority: ['low'] }, children: [] }, // priority-9 → clamp 7 → low 恒稳定
      { title: '进度12', icons: { progress: ['p12'] }, children: [] },
      { title: '进度25', icons: { progress: ['p25'] }, children: [] },
      { title: '进度37', icons: { progress: ['p37'] }, children: [] },
      { title: '进度50', icons: { progress: ['p50'] }, children: [] },
      { title: '进度62', icons: { progress: ['p62'] }, children: [] },
      { title: '进度75', icons: { progress: ['p75'] }, children: [] },
      { title: '进度87', icons: { progress: ['p87'] }, children: [] },
      { title: '进度完', icons: { progress: ['done'] }, children: [] },
      { title: '心情', icons: { mood: ['smile'] }, children: [] }, // smiley-laugh → smile → smiley-laugh 恒稳定
      { title: '旗', icons: { flag: ['flag'] }, children: [] },
      { title: '箭头', icons: { arrow: ['up'] }, children: [] },
      { title: '箭头下', icons: { arrow: ['down'] }, children: [] },
      { title: '箭头左', icons: { arrow: ['left'] }, children: [] },
      { title: '箭头右', icons: { arrow: ['right'] }, children: [] },
      {
        title: '其他组多值并存',
        icons: { other: ['like', 'question', 'plus', 'cancel', 'done', 'idea', 'person', 'important'] },
        children: [],
      },
      {
        title: '链接与样式',
        href: 'https://example.com/roundtrip',
        style: { color: '#ff0000', fill: '#00ff00', border: '#0000ff', fontSize: '14' },
        children: [],
      },
    ];
    // 形近改写三档（评审 Important#1 钉死）：导出落最接近档位，非恒等——逐个精确断言
    const REWRITE_CHILDREN: XmindNode[] = [
      { title: '急', icons: { priority: ['urgent'] }, children: [] }, // → priority-1
      { title: '高', icons: { priority: ['high'] }, children: [] }, // → priority-6
      { title: '中', icons: { priority: ['mid'] }, children: [] }, // → priority-7
    ];
    const tree: XmindNode = {
      title: '根',
      children: [...STABLE_CHILDREN, ...REWRITE_CHILDREN], // 形近三档固定在末尾（slice 断言依赖）
    };
    const stableRootOf = (root: XmindNode): XmindNode => ({
      title: root.title,
      children: root.children.slice(0, STABLE_CHILDREN.length),
    });
    const rewrittenOf = (root: XmindNode): XmindNode[] => root.children.slice(STABLE_CHILDREN.length);

    const bytes = buildXmind([{ title: '', root: tree }]);
    const first = parseXmind(bytes);
    expect(first.degraded).toEqual([]); // 导出 id/样式/链接全部有对应：零降级
    expect(stableRootOf(first.sheets[0].root)).toEqual({ title: '根', children: STABLE_CHILDREN }); // 稳定族深度相等
    expect(rewrittenOf(first.sheets[0].root)).toEqual([
      { title: '急', icons: { priority: ['p0'] }, children: [] }, // urgent→priority-1→p0
      { title: '高', icons: { priority: ['mid'] }, children: [] }, // high→priority-6→mid
      { title: '中', icons: { priority: ['low'] }, children: [] }, // mid→priority-7→low
    ]);
    const second = parseXmind(buildXmind([{ title: '', root: first.sheets[0].root }]));
    expect(second.degraded).toEqual([]); // 再导出→再导入：稳定族固定点不漂移
    expect(stableRootOf(second.sheets[0].root)).toEqual({ title: '根', children: STABLE_CHILDREN });
    expect(rewrittenOf(second.sheets[0].root)).toEqual([
      { title: '急', icons: { priority: ['p0'] }, children: [] },
      { title: '高', icons: { priority: ['low'] }, children: [] }, // 第二循环 mid→priority-7 再落 low，此后恒定
      { title: '中', icons: { priority: ['low'] }, children: [] },
    ]);
  });

  it('v2 零虚增：emoji/number 组导出不产出任何 marker-id（混挂节点只含真值 id）', () => {
    const tree: XmindNode = {
      title: '根',
      children: [
        { title: '纯 emoji/number', icons: { emoji: ['😄', '🎉'], number: ['1', '2'] }, children: [] },
        { title: '混挂真值', icons: { emoji: ['😄'], number: ['5'], other: ['done'] }, children: [] },
      ],
    };
    const bytes = buildXmind([{ title: '', root: tree }]);
    const sheets = JSON.parse(
      new TextDecoder().decode(unzipSync(bytes)['content.json']),
    ) as Array<{ rootTopic: { children: { attached: Record<string, unknown>[] } } }>;
    const attached = sheets[0].rootTopic.children.attached;
    expect('markers' in attached[0]).toBe(false); // 纯 emoji/number：无 markers 键=零虚增
    expect(attached[1].markers).toEqual([{ markerId: 'symbol-right' }]); // 只含真值 id，无 emoji/number 虚增
    const parsed = parseXmind(bytes);
    expect(parsed.degraded).toEqual([]); // 产物再导入零图标降级（无造不出的 marker-id）
  });

  it('v2.1 structureType 往返：logic/mindmap/org 经根 structureClass 导出→再导入还原；层级不变；未指定不产', () => {
    const treeOf = (label: string): XmindNode => ({
      title: label,
      children: [
        { title: `${label}-1`, children: [] },
        { title: `${label}-2`, children: [{ title: `${label}-2a`, children: [] }] },
      ],
    });
    const bytes = buildXmind([
      { title: '逻辑图', root: treeOf('逻辑'), structureType: 'logic' },
      { title: '导图', root: treeOf('导图'), structureType: 'mindmap' },
      { title: '组织结构', root: treeOf('组织'), structureType: 'org' },
      { title: '未指定', root: treeOf('缺省') },
    ]);
    const parsed = parseXmind(bytes);
    // 三值经 structureClass 写回再映射还原；未指定的 sheet 不产 structureType 键
    expect(parsed.sheets.map((s) => s.structureType)).toEqual(['logic', 'mindmap', 'org', undefined]);
    expect(parsed.sheets[0].root).toEqual(treeOf('逻辑')); // 层级不变（多级/孙层）
    expect(parsed.degraded).toEqual([]); // structureClass 只在根：零 structureOverride 降级
  });

  it('v2.3 图片往返：build(带 image+extra 字节)→parseXmind 还原 image{path,w,h,align}；theme 零降级', () => {
    // PNG 魔数开头（\x89PNG\r\n\x1a\n）：过 parseXmind resources 魔数白名单嗅探
    const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);
    const tree: XmindNode = {
      title: '根',
      children: [
        { title: '带图', image: { path: 'resources/p.png', w: 100, h: 50, align: 'top' }, children: [] },
        { title: '裸图', image: { path: 'resources/q.png' }, children: [] }, // w/h/align 缺省：往返同样不产
      ],
    };
    // node.image.path=extra 键（zip 资源键）：导出组包与解析查表同键，往返才闭环
    const bytes = buildXmind([{ title: '', root: tree }], {
      'resources/p.png': png,
      'resources/q.png': png,
    });
    const parsed = parseXmind(bytes);
    expect(parsed.sheets[0].root).toEqual(tree); // 深度相等：image 四键逐字段还原
    expect(parsed.sheets[0].root.children[0].image).toEqual({
      path: 'resources/p.png',
      w: 100,
      h: 50,
      align: 'top',
    });
    expect(parsed.sheets[0].root.children[1].image).toEqual({ path: 'resources/q.png' });
    expect(parsed.resources['resources/p.png']?.mime).toBe('image/png'); // 资源表读回（字节+mime）
    expect(parsed.degraded).toEqual([]); // theme 不计降级；图片全部命中 resources：零降级
  });

  // 分侧忠实还原（2026-11-15 Task 2）：rightCount 经根 topic extensions right-number
  // 往返还原（build String(n) ↔ parse parseInt 的逆）；0 同样还原（合法全左值）。
  it('分侧 right-number 往返：build(mindmap+rightCount=3)→parseXmind 还原 rightCount===3；0 还原 0；缺省/logic 不落不还原', () => {
    const treeOf = (): XmindNode => ({
      title: '根',
      children: [
        { title: 'A', children: [] },
        { title: 'B', children: [] },
        { title: 'C', children: [] },
      ],
    });
    const parsed = parseXmind(
      buildXmind([
        { title: '', root: treeOf(), structureType: 'mindmap', rightCount: 3 },
        { title: '', root: treeOf(), structureType: 'mindmap', rightCount: 0 },
        { title: '', root: treeOf(), structureType: 'mindmap' }, // 未计数：不写不还原
        { title: '', root: treeOf(), structureType: 'logic', rightCount: 5 }, // 非 mindmap：build 不落 extensions
      ]),
    );
    expect(parsed.sheets.map((s) => s.rightCount)).toEqual([3, 0, undefined, undefined]);
    expect(parsed.degraded).toEqual([]); // provider 已知（map.unbalanced）：分侧扩展零降级
  });
});

import { zipEntries, unzipEntries } from './index';

describe('unzipEntries（zipEntries 对称开口）', () => {
  it('zip 后解包字节一致', () => {
    const payload = new TextEncoder().encode('{"hello":"世界"}');
    const packed = zipEntries({ 'a/b.json': payload, 'c.txt': new TextEncoder().encode('x') });
    const out = unzipEntries(packed);
    expect(new TextDecoder().decode(out['a/b.json'])).toBe('{"hello":"世界"}');
    expect(new TextDecoder().decode(out['c.txt'])).toBe('x');
  });
});

