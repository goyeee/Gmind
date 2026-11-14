// build.test.ts：buildXmind 产物结构——可被 unzipSync 读回，content.json 形状正确。
// 2026-11-14 导出写回 v2：href/style 五键（topic href + style 四键过滤非空，fontSize
// 产 "<n>px"）、extra 第二参（仅 e2e 夹具开口，键原样合入 zip）、不传 extra 时产物
// 与现状逐字节一致（条目字节金样钉死）。
import { describe, expect, it } from 'vitest';
import { unzipSync } from 'fflate';
import { buildXmind, zipEntries } from './index';
import type { XmindNode } from './index';

/** 金样树（捕获自 v2 实现落地前的产物，覆盖 note/icons/children 路径）。 */
const GOLDEN_TREE: XmindNode = {
  title: '中心',
  note: '根备注',
  children: [
    {
      title: 'A',
      icons: { priority: ['p4'], flag: ['flag'] },
      children: [{ title: 'A1', children: [] }],
    },
  ],
};
const GOLDEN_SHEETS = [{ title: 'Sheet 1', root: GOLDEN_TREE }];
/** 金样 content.json 串（逐字节捕获自实现前的产物；metadata.json 恒为 '{"creator":"Gmind"}'）。
 *  注：fflate zipSync 容器头嵌 Date.now() 时间戳，zip 原始字节不具跨次运行确定性——
 *  「与现状逐字节一致」钉在条目字节层（条目集 + 各条目字节），容器结构未动零风险。 */
const GOLDEN_CONTENT_JSON =
  '[{"class":"sheet","title":"Sheet 1","rootTopic":{"class":"topic","title":"中心","notes":{"plain":{"content":"根备注"}},"children":{"attached":[{"class":"topic","title":"A","markers":[{"markerId":"priority-5"},{"markerId":"flag-red"}],"children":{"attached":[{"class":"topic","title":"A1"}]}}]}}}]';

describe('buildXmind', () => {
  it('生成 zip：含 content.json 与 metadata.json，content.json 可解析且形状正确', () => {
    const tree: XmindNode = {
      title: '中心',
      note: '根备注',
      children: [{ title: 'A', children: [{ title: 'A1', children: [] }] }],
    };
    const bytes = buildXmind([{ title: 'Sheet 1', root: tree }]);
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
    const bytes = buildXmind([{ title: 'Sheet 1', root: { title: '单点', children: [] } }]);
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
        { title: 'C', icons: { other: ['done'], emoji: ['😄'] }, children: [] }, // v2：done→symbol-right；emoji 无原生源不导出
      ],
    };
    const files = unzipSync(buildXmind([{ title: 'Sheet 1', root: tree }]));
    const sheets = JSON.parse(new TextDecoder().decode(files['content.json']));
    const rootTopic = sheets[0].rootTopic;
    expect(rootTopic.markers).toBeUndefined(); // 根无标记不产 markers 键
    const a = rootTopic.children.attached[0];
    expect(a.markers).toEqual([{ markerId: 'priority-5' }, { markerId: 'flag-red' }]);
    expect(a.children.attached[0].markers).toEqual([{ markerId: 'priority-1' }]); // urgent→1
    expect(rootTopic.children.attached[1].markers).toEqual([{ markerId: 'star-red' }]);
    expect(rootTopic.children.attached[2].markers).toEqual([{ markerId: 'symbol-right' }]); // v2：other.done→symbol-right；emoji 不产出
  });

  it('v2 导出写回：topic href 有值产键、空/缺省不产键', () => {
    const tree: XmindNode = {
      title: '根',
      href: 'https://example.com/a',
      children: [
        { title: '空串', href: '', children: [] }, // 空串：不产键
        { title: '无 href', children: [] },
        { title: '子链接', href: 'https://example.com/b', children: [] },
      ],
    };
    const sheets = JSON.parse(
      new TextDecoder().decode(unzipSync(buildXmind([{ title: '', root: tree }]))['content.json']),
    ) as Array<{ rootTopic: Record<string, unknown> & { children: { attached: Record<string, unknown>[] } } }>;
    expect(sheets[0].rootTopic.href).toBe('https://example.com/a');
    expect('href' in sheets[0].rootTopic.children.attached[0]).toBe(false);
    expect('href' in sheets[0].rootTopic.children.attached[1]).toBe(false);
    expect(sheets[0].rootTopic.children.attached[2].href).toBe('https://example.com/b');
  });

  it('v2 导出写回：style 四键产 style.properties，fontSize 产 "<n>px"，表外/空值键不产', () => {
    const tree: XmindNode = {
      title: '根',
      style: { color: '#ff0000', fill: '#00ff00', border: '#0000ff', fontSize: '14' },
      children: [
        { title: '只填一项', style: { fill: '#336699' }, children: [] },
        { title: 'fontSize 带单位小数', style: { fontSize: '12.6px' }, children: [] }, // 取整 → 13px
        { title: '全空值', style: { color: '', fill: '', border: '', fontSize: '' }, children: [] }, // 不产 style 键
        { title: '表外键与非法字号', style: { 'fo:font-family': 'Arial', fontSize: 'abc', fill: '#123456' }, children: [] }, // 只产 fill
        {
          title: '非字符串字号',
          style: { fontSize: 14, fill: '#223344' } as unknown as Record<string, string>, // 类型违规输入（评审 Minor#1 守卫）：只产 fill，不抛错
          children: [],
        },
        { title: '无 style', children: [] },
      ],
    };
    const sheets = JSON.parse(
      new TextDecoder().decode(unzipSync(buildXmind([{ title: '', root: tree }]))['content.json']),
    ) as Array<{ rootTopic: Record<string, unknown> & { children: { attached: Array<Record<string, unknown>> } } }>;
    expect(sheets[0].rootTopic.style).toEqual({
      properties: {
        'fo:color': '#ff0000',
        'svg:fill': '#00ff00',
        'svg:stroke-color': '#0000ff',
        'fo:font-size': '14px', // "<n>px" 形状（解析侧去 px 取整的逆）
      },
    });
    expect(sheets[0].rootTopic.children.attached[0].style).toEqual({ properties: { 'svg:fill': '#336699' } });
    expect(sheets[0].rootTopic.children.attached[1].style).toEqual({ properties: { 'fo:font-size': '13px' } });
    expect('style' in sheets[0].rootTopic.children.attached[2]).toBe(false);
    expect(sheets[0].rootTopic.children.attached[3].style).toEqual({ properties: { 'svg:fill': '#123456' } });
    expect(sheets[0].rootTopic.children.attached[4].style).toEqual({ properties: { 'svg:fill': '#223344' } });
    expect('style' in sheets[0].rootTopic.children.attached[5]).toBe(false);
  });

  it('extra 第二参：键原样合入 zip 条目（字节不改动），仅夹具开口', () => {
    const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);
    const bytes = buildXmind([{ title: '', root: { title: '根', children: [] } }], {
      'content.json': new Uint8Array([1, 2, 3]), // 同名夹具键（评审 Minor#2）：核心条目恒胜，不被 extra 覆盖
      'resources/pic.png': png,
      'resources/sub/inner.png': new Uint8Array([9, 8, 7]),
    });
    const files = unzipSync(bytes);
    expect(Object.keys(files).sort()).toEqual([
      'content.json',
      'metadata.json',
      'resources/pic.png',
      'resources/sub/inner.png',
    ]);
    expect(Array.from(files['content.json'])).not.toEqual([1, 2, 3]); // 核心条目未被夹具击穿
    expect(Array.from(files['resources/pic.png'])).toEqual(Array.from(png)); // 字节原样
    expect(Array.from(files['resources/sub/inner.png'])).toEqual([9, 8, 7]);
    const sheets = JSON.parse(new TextDecoder().decode(files['content.json'])) as unknown[];
    expect(sheets).toHaveLength(1); // 核心条目不受影响
  });

  it('不传 extra（或传空对象）时产物与现状逐字节一致（条目字节金样）', () => {
    const readEntries = (bytes: Uint8Array): Record<string, string> => {
      const files = unzipSync(bytes);
      return Object.fromEntries(
        Object.keys(files)
          .sort()
          .map((k) => [k, new TextDecoder().decode(files[k])]),
      );
    };
    const baseline = readEntries(buildXmind(GOLDEN_SHEETS));
    // 条目集与各条目字节逐字节等于现状（金样捕获自 v2 落地前实现）
    expect(Object.keys(baseline)).toEqual(['content.json', 'metadata.json']);
    expect(baseline['content.json']).toBe(GOLDEN_CONTENT_JSON);
    expect(baseline['metadata.json']).toBe('{"creator":"Gmind"}');
    // 空对象 extra 与不传：条目字节完全一致（第二参缺省零影响）
    expect(readEntries(buildXmind(GOLDEN_SHEETS, {}))).toEqual(baseline);
    expect(readEntries(buildXmind(GOLDEN_SHEETS, undefined))).toEqual(baseline);
  });
});

// zipEntries（index.ts 极小开口，2026-11-14 Task 6 fix round 1 裁定①）：包一层内部
// zipSync 供 e2e 夹具组 zip——fflate 恒为 xmind-io 私有依赖，web e2e 进程不直引。
describe('zipEntries', () => {
  it('键原样合入 zip：文本经 TextEncoder 入条目、字节条目原样读回', () => {
    const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 1, 2, 3, 4]); // \x89PNG 魔数开头
    const entries: Record<string, Uint8Array> = {
      'resources/pic.png': png,
      'content.json': new TextEncoder().encode(JSON.stringify([{ class: 'sheet', title: '画布 1' }])),
    };
    const files = unzipSync(zipEntries(entries));
    expect(Object.keys(files).sort()).toEqual(['content.json', 'resources/pic.png']);
    expect(Array.from(files['resources/pic.png'])).toEqual(Array.from(png)); // 字节原样
    expect(JSON.parse(new TextDecoder().decode(files['content.json']))).toEqual([
      { class: 'sheet', title: '画布 1' },
    ]);
  });
});
