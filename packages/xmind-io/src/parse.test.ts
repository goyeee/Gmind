// @vitest-environment jsdom
// parse.test.ts：parseXmind 的 content.json（2020+）主路径、content.xml（XMind 8）回落路径、
// v2 命名制降级（DegradedItem{key,count}，目录序见 DEGRADED_LABELS）、resources 资源表与三种
// 错误码（CORRUPTED / UNSUPPORTED_FORMAT / EMPTY）。zip 夹具用 fflate 现场构造。
// 形状真值以 spec §二/§四 为准：JSON `markers:[{markerId}]`、`children.summary[].title` +
// `summaries[].{topicId,range}`、`branch:"folded"`、XML sheet theme 是**属性**、图片
// `xhtml:src="xap:resources/…"`——不得凭 XMind 文档想象。
import { describe, expect, it } from 'vitest';
import { strToU8, zipSync } from 'fflate';
import { parseXmind, XmindParseError } from './index';
import type { DegradedItem, DegradedKey, XmindErrorCode } from './index';

// ---------------------------------------------------------------------------
// 夹具：测试内直接构造 zip，无需二进制 fixture 文件。
// ---------------------------------------------------------------------------

const sheet = (rootTopic: unknown) =>
  JSON.stringify([{ class: 'sheet', title: 'Sheet 1', rootTopic }]);

const zipOf = (files: Record<string, string | Uint8Array>): Uint8Array =>
  zipSync(Object.fromEntries(Object.entries(files).map(([k, v]) => [k, typeof v === 'string' ? strToU8(v) : v])));

const jsonZip = (contentJson: string): Uint8Array => zipOf({ 'content.json': contentJson });

/** 降级数组 → {key: count} 速查表。 */
const keyOf = (degraded: DegradedItem[]): Record<DegradedKey, number | undefined> =>
  Object.fromEntries(degraded.map((x) => [x.key, x.count])) as Record<DegradedKey, number | undefined>;

// 魔数夹具：png `\x89PNG`、jpg `\xFF\xD8\xFF`、gif `GIF8`、webp `RIFF..WEBP`（spec §四）。
const PNG_BYTES = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13]);
const JPG_BYTES = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0, 0]);
const GIF_BYTES = new Uint8Array([0x47, 0x49, 0x46, 0x38, 0x39, 0x61]);
const WEBP_BYTES = new Uint8Array([0x52, 0x49, 0x46, 0x46, 1, 2, 3, 4, 0x57, 0x45, 0x42, 0x50]);
const TXT_BYTES = strToU8('definitely not an image');

/** 断言 parseXmind 抛出指定 code 的 XmindParseError。 */
function expectParseError(bytes: Uint8Array, code: XmindErrorCode): void {
  try {
    parseXmind(bytes);
  } catch (e) {
    expect(e).toBeInstanceOf(XmindParseError);
    expect((e as XmindParseError).code).toBe(code);
    return;
  }
  throw new Error(`期望抛出 XmindParseError(${code})，但 parseXmind 正常返回了`);
}

// ---------------------------------------------------------------------------
// content.json 主路径
// ---------------------------------------------------------------------------

describe('parseXmind：2020+ content.json', () => {
  it('解析 2020+ content.json：层级/文本/备注', () => {
    const bytes = jsonZip(
      sheet({
        class: 'topic',
        title: '中心',
        notes: { plain: { content: '根备注' } },
        children: {
          attached: [
            { class: 'topic', title: 'A', children: { attached: [{ class: 'topic', title: 'A1' }] } },
            { class: 'topic', title: 'B' },
          ],
        },
      }),
    );
    const { sheets: __s, degraded, resources } = parseXmind(bytes);
    const root = __s[0]!.root;
    expect(root.title).toBe('中心');
    expect(root.note).toBe('根备注');
    expect(root.children.map((c) => c.title)).toEqual(['A', 'B']);
    expect(root.children[0].children[0].title).toBe('A1');
    expect(degraded).toEqual([]);
    expect(resources).toEqual({});
  });

  it('markers v2：task-done→done、symbol-idea→idea、task-half→p50（JSON markers:[{markerId}] 形状）；全映射零降级', () => {
    const bytes = jsonZip(
      sheet({
        class: 'topic',
        title: '中心',
        markers: [{ markerId: 'task-half' }],
        children: {
          attached: [
            { class: 'topic', title: 'A', markers: [{ markerId: 'task-done' }] },
            { class: 'topic', title: 'B', markers: [{ markerId: 'symbol-idea' }] },
          ],
        },
      }),
    );
    const { sheets: __s, degraded } = parseXmind(bytes);
    const root = __s[0]!.root;
    expect(root.icons).toEqual({ progress: ['p50'] });
    expect(root.children[0].icons).toEqual({ progress: ['done'] });
    expect(root.children[1].icons).toEqual({ other: ['idea'] });
    expect(degraded).toEqual([]);
  });

  it('降级计数：labels 计标签、realHTML 纯文本备注、detached 计漂浮主题', () => {
    const bytes = zipOf({
      'content.json': sheet({
        class: 'topic',
        title: '中心',
        markers: [{ markerId: 'priority-1' }],
        children: {
          attached: [
            {
              class: 'topic',
              title: 'A',
              labels: ['标签'],
              notes: { realHTML: { content: '<b>富</b>' } },
            },
          ],
          detached: [{ class: 'topic', title: '漂浮' }],
        },
      }),
      'metadata.json': '{}',
    });
    const { sheets: __s, degraded } = parseXmind(bytes);
    const root = __s[0]!.root;
    expect(root.children).toHaveLength(1); // detached 不进树
    expect(root.children[0].note).toBe('富'); // realHTML 剥标签取文本
    expect(degraded).toEqual([{ key: 'label', count: 1 }, { key: 'floating', count: 1 }]); // 目录序：标签→漂浮（priority-1 已映射进 icons）
  });

  it('M7b-W1 标记映射：priority 1-9 → 企微档位（8/9 clamp 7→low）；flag-*/star-* 落不同组可并存；同组后续与无对应均计图标', () => {
    const topicOf = (markers: unknown[]) => ({
      class: 'topic',
      title: '中心',
      markers,
      children: { attached: [] },
    });
    const bytes = jsonZip(
      JSON.stringify([
        { class: 'sheet', title: 'S', rootTopic: topicOf([{ markerId: 'priority-3' }]) },
      ]),
    );
    expect(parseXmind(bytes).sheets[0]!.root.icons).toEqual({ priority: ['p2'] }); // 3 → p2（企微同档位）

    const hi = parseXmind(
      jsonZip(
        JSON.stringify([
          { class: 'sheet', title: 'S', rootTopic: topicOf([{ markerId: 'priority-9' }, { markerId: 'priority-2' }]) },
        ]),
      ),
    );
    expect(hi.sheets[0]!.root.icons).toEqual({ priority: ['low'] }); // 9→7→low；同组首个胜（priority-9 先出现）
    expect(hi.degraded).toEqual([{ key: 'icon', count: 1 }]); // 被单选吞掉的 priority-2 计入 dropped（R1 2.4）

    const fs = parseXmind(
      jsonZip(
        JSON.stringify([
          {
            class: 'sheet',
            title: 'S',
            rootTopic: topicOf([{ markerId: 'flag-dark-green' }, { markerId: 'star-blue' }]),
          },
        ]),
      ),
    );
    expect(fs.sheets[0]!.root.icons).toEqual({ flag: ['flag'], other: ['important'] }); // M7b：flag/star 落不同组、可并存
    expect(fs.degraded).toEqual([]); // 颜色信息无对应位丢弃，但 marker 均已映射不再计降级

    const sf = parseXmind(
      jsonZip(
        JSON.stringify([
          {
            class: 'sheet',
            title: 'S',
            rootTopic: topicOf([{ markerId: 'star-blue' }, { markerId: 'flag-dark-green' }]),
          },
        ]),
      ),
    );
    expect(sf.sheets[0]!.root.icons).toEqual({ flag: ['flag'], other: ['important'] }); // 与出现顺序无关

    const st = jsonZip(
      JSON.stringify([{ class: 'sheet', title: 'S', rootTopic: topicOf([{ markerId: 'star-red' }]) }],
      ),
    );
    expect(parseXmind(st).sheets[0]!.root.icons).toEqual({ other: ['important'] });

    // 2026-11-14 v2：task-start→progress.none、smiley-smile→mood.smile 已入映射表
    // （markers.test.ts 钉死），改用 spec 点名丢弃的 arrow-refresh/symbol-minus 钉「无对应计图标」。
    const dropped = parseXmind(
      jsonZip(JSON.stringify([{ class: 'sheet', title: 'S', rootTopic: topicOf([{ markerId: 'arrow-refresh' }, { markerId: 'symbol-minus' }]) }])),
    );
    expect(dropped.sheets[0]!.root.icons).toBeUndefined(); // 无对应 → 不产 icons
    expect(dropped.degraded).toEqual([{ key: 'icon', count: 2 }]); // 丢弃并按「图标」登记
  });

  it('概要（两段式）：children.summary[].title 标签 + summaries[].{topicId,range} 引用；(0,0) 单点、(0,2) 区间；range 非法/逆序/越界计概要不产条目', () => {
    const bytes = jsonZip(
      sheet({
        class: 'topic',
        title: '中心',
        summaries: [
          { id: 's1', topicId: 'lbl1', range: '(0,0)' }, // 单点
          { id: 's2', topicId: 'lbl2', range: '(0,2)' }, // 区间
          { id: 's3', topicId: 'lbl1', range: 'abc' }, // 非法
          { id: 's4', topicId: 'lbl1', range: '(2,1)' }, // 逆序
          { id: 's5', topicId: 'lbl1', range: '(1,3)' }, // 越界（attached 仅 3 个：下标 0-2）
          { id: 's6', topicId: 'ghost', range: '(0,1)' }, // 标签查无 → 条目产出、label 空串
        ],
        children: {
          attached: [
            { class: 'topic', title: 'A' },
            { class: 'topic', title: 'B' },
            { class: 'topic', title: 'C' },
          ],
          summary: [
            { id: 'lbl1', title: '要点' },
            { id: 'lbl2', title: '区间' },
          ],
        },
      }),
    );
    const { sheets: __s, degraded } = parseXmind(bytes);
    const root = __s[0]!.root;
    expect(root.summaries).toEqual([
      { start: 0, end: 0, label: '要点' },
      { start: 0, end: 2, label: '区间' },
      { start: 0, end: 1, label: '' },
    ]);
    expect(degraded).toEqual([{ key: 'summary', count: 3 }]); // abc / (2,1) / (1,3)
  });

  it('图片：image.src 剥 xap: 查 resources 表（字节+mime）、w/h float 取整、align 白名单；zip 缺键/魔数不符/非本地路径计图片', () => {
    const bytes = zipOf({
      'content.json': sheet({
        class: 'topic',
        title: '中心',
        image: { src: 'xap:resources/pic.png', width: 79.9, height: 178.4, align: 'left' },
        children: {
          attached: [
            { class: 'topic', title: '缺图', image: { src: 'xap:resources/gone.png' } },
            { class: 'topic', title: '假图', image: { src: 'xap:resources/fake.png' } },
            { class: 'topic', title: '无对齐', image: { src: 'xap:resources/pic.png' } },
            { class: 'topic', title: '外链图', image: { src: 'https://cdn.example.com/pic.png' } },
          ],
        },
      }),
      'resources/pic.png': PNG_BYTES,
      'resources/photo.jpg': JPG_BYTES,
      'resources/fake.png': TXT_BYTES, // 魔数不符 → 不入 resources 表
    });
    const { sheets: __s, degraded, resources } = parseXmind(bytes);
    const root = __s[0]!.root;
    expect(root.image).toEqual({ path: 'resources/pic.png', w: 80, h: 178, align: 'left' });
    expect(root.children[2]!.image).toEqual({ path: 'resources/pic.png' }); // 源无 width/height/align → 三个键都不落
    expect(root.children[0]!.image).toBeUndefined(); // zip 查无键
    expect(root.children[1]!.image).toBeUndefined(); // 魔数不符
    expect(root.children[3]!.image).toBeUndefined(); // 非本地资源
    expect(Object.keys(resources).sort()).toEqual(['resources/photo.jpg', 'resources/pic.png']);
    expect(resources['resources/pic.png']).toEqual({ bytes: PNG_BYTES, mime: 'image/png' });
    expect(resources['resources/photo.jpg']).toEqual({ bytes: JPG_BYTES, mime: 'image/jpeg' });
    expect(keyOf(degraded).image).toBe(3);
  });

  it('href：http/https 透传，xapp:/相对路径计超链接不产键', () => {
    const bytes = jsonZip(
      sheet({
        class: 'topic',
        title: '中心',
        children: {
          attached: [
            { class: 'topic', title: '外链', href: 'https://gmind.dev/a' },
            { class: 'topic', title: '内链', href: 'xapp://file/f1' },
            { class: 'topic', title: '相对', href: 'page1' },
          ],
        },
      }),
    );
    const { sheets: __s, degraded } = parseXmind(bytes);
    const [外链, 内链, 相对] = __s[0]!.root.children;
    expect(外链!.href).toBe('https://gmind.dev/a');
    expect(内链!.href).toBeUndefined();
    expect(相对!.href).toBeUndefined();
    expect(degraded).toEqual([{ key: 'link', count: 2 }]);
  });

  it('样式：style.properties 四键映射（fo:font-size:"14px"→"14"），不支持键逐键计样式属性；fontSize 非法值计样式属性', () => {
    const fourKeys = parseXmind(
      jsonZip(
        sheet({
          class: 'topic',
          title: '中心',
          style: {
            properties: {
              'fo:color': '#111111',
              'svg:fill': '#F0F0F0',
              'svg:stroke-color': '#FF0000',
              'fo:font-size': '14px',
              'fo:font-family': 'Arial',
              'fo:font-weight': 'bold',
            },
          },
        }),
      ),
    );
    expect(fourKeys.sheets[0]!.root.style).toEqual({
      color: '#111111',
      fill: '#F0F0F0',
      border: '#FF0000',
      fontSize: '14',
    });
    expect(fourKeys.degraded).toEqual([{ key: 'styleProp', count: 2 }]); // font-family / font-weight 逐键计

    const badSize = parseXmind(jsonZip(sheet({ class: 'topic', title: '中心', style: { properties: { 'fo:font-size': 'abc' } } })));
    expect(badSize.sheets[0]!.root.style).toBeUndefined();
    expect(badSize.degraded).toEqual([{ key: 'styleProp', count: 1 }]);

    const zeroSize = parseXmind(jsonZip(sheet({ class: 'topic', title: '中心', style: { properties: { 'fo:font-size': '0px' } } })));
    expect(zeroSize.degraded).toEqual([{ key: 'styleProp', count: 1 }]); // ≤0 非法
  });

  it('结构：根 structureClass→structureType（logic.right/map.*/org-chart.*），未知值计结构覆盖落缺省；非根逐个计结构覆盖；sheet theme 不再计入（2026-11-14 需求方拍板：主题由 Gmind 自有主题替换，非内容丢失），legend 忽略', () => {
    const bytes = jsonZip(
      JSON.stringify([
        {
          class: 'sheet',
          title: 'S1',
          theme: { id: 'dark' },
          legend: { x: 1 },
          rootTopic: {
            class: 'topic',
            title: '根1',
            structureClass: 'org.xmind.ui.logic.right',
            children: { attached: [{ class: 'topic', title: '子', structureClass: 'org.xmind.ui.tree' }] },
          },
        },
        { class: 'sheet', title: 'S2', rootTopic: { class: 'topic', title: '根2', structureClass: 'org.xmind.ui.map.unbalanced' } },
        { class: 'sheet', title: 'S3', rootTopic: { class: 'topic', title: '根3', structureClass: 'org.xmind.ui.org-chart.down' } },
        { class: 'sheet', title: 'S4', rootTopic: { class: 'topic', title: '根4', structureClass: 'org.xmind.ui.bubble' } },
      ]),
    );
    const { sheets: __s, degraded } = parseXmind(bytes);
    expect(__s[0]!.structureType).toBe('logic');
    expect(__s[1]!.structureType).toBe('mindmap');
    expect(__s[2]!.structureType).toBe('org');
    expect(__s[3]!.structureType).toBeUndefined(); // 未知结构 → 落缺省
    expect(keyOf(degraded)).not.toHaveProperty('theme'); // 画布主题不再计入（2026-11-14 需求方拍板）
    expect(keyOf(degraded).structureOverride).toBe(2); // 非根「子」+ S4 未知根
    expect(keyOf(degraded).label).toBeUndefined(); // legend 忽略不计
  });

  it('folded：branch:"folded" → folded:true；无键不落键', () => {
    const bytes = jsonZip(
      sheet({
        class: 'topic',
        title: '中心',
        branch: 'folded',
        children: {
          attached: [
            { class: 'topic', title: 'A', branch: 'folded' },
            { class: 'topic', title: 'B' },
          ],
        },
      }),
    );
    const { sheets: __s, degraded } = parseXmind(bytes);
    const root = __s[0]!.root;
    expect(root.folded).toBe(true);
    expect(root.children[0]!.folded).toBe(true);
    expect('folded' in root.children[1]!).toBe(false);
    expect(degraded).toEqual([]);
  });

  it('标注/外框/任务信息/标签/附件/备注内图片各自计数；标注按子树节点数（同漂浮口径）', () => {
    const bytes = jsonZip(
      sheet({
        class: 'topic',
        title: '中心',
        labels: ['l1', 'l2'],
        attachments: [{ title: '1' }, { title: '2' }, { title: '3' }],
        taskInfo: { assignee: '甲' },
        notes: { realHTML: { content: '<p>看<img src="n.png"/></p>' } },
        children: {
          attached: [{ class: 'topic', title: 'A' }],
          callout: [
            { class: 'topic', title: '标注', children: { attached: [{ class: 'topic', title: '内' }] } },
          ],
          boundary: [{ id: 'b1', range: '(0,1)' }],
        },
      }),
    );
    const { degraded } = parseXmind(bytes);
    expect(degraded).toEqual([
      { key: 'label', count: 2 },
      { key: 'attachment', count: 3 },
      { key: 'noteImage', count: 1 },
      { key: 'callout', count: 2 },
      { key: 'boundary', count: 1 },
      { key: 'taskInfo', count: 1 },
    ]);
  });

  it('detached 被外框 topicId 引用 → 豁免漂浮（豁免者子树不下钻），外框本身计外框', () => {
    const bytes = jsonZip(
      sheet({
        class: 'topic',
        title: '中心',
        children: {
          attached: [
            { class: 'topic', title: 'A' },
            { class: 'topic', title: 'B' },
          ],
          detached: [
            { class: 'topic', id: 'dx', title: '被外框消费', children: { attached: [{ class: 'topic', title: '内' }] } },
            { class: 'topic', id: 'dy', title: '真漂浮' },
          ],
          boundary: [{ id: 'b1', topicId: 'dx', range: '(0,1)' }],
        },
      }),
    );
    const { sheets: __s, degraded } = parseXmind(bytes);
    expect(__s[0]!.root.children).toHaveLength(2); // detached 不进树
    expect(degraded).toEqual([{ key: 'boundary', count: 1 }, { key: 'floating', count: 1 }]); // dx 整树（含「内」）豁免，仅 dy 计 1
  });

  it('降级计数：图片/附件/备注内图片/概要各自入键；多画布（裁定 8）：全部 sheet 逐个产出', () => {
    const topicOf = (title: string) => ({ class: 'topic', title });
    const bytes = jsonZip(
      JSON.stringify([
        {
          class: 'sheet',
          title: 'Sheet 1',
          rootTopic: {
            class: 'topic',
            title: '中心',
            image: { src: 'x.png' },
            attachments: [{ title: '附件1' }, { title: '附件2' }],
            summaries: [{ title: '概要' }],
            children: {
              attached: [
                { class: 'topic', title: 'A', notes: { realHTML: { content: '<p>看图 <img src="y.png"/></p>' } } },
              ],
            },
          },
        },
        { class: 'sheet', title: 'Sheet 2', rootTopic: topicOf('x') },
        { class: 'sheet', title: 'Sheet 3', rootTopic: topicOf('y') },
      ]),
    );
    const { sheets: __s, degraded } = parseXmind(bytes);
    const root = __s[0]!.root;
    expect(root.children).toHaveLength(1);
    expect(__s.map((s) => s.title)).toEqual(['Sheet 1', 'Sheet 2', 'Sheet 3']); // 不再拍平：逐 sheet 产出
    expect(__s[1]!.root.title).toBe('x');
    expect(__s[2]!.root.title).toBe('y');
    expect(degraded).toEqual([
      { key: 'image', count: 1 }, // image.src 查 resources 无键
      { key: 'attachment', count: 2 },
      { key: 'noteImage', count: 1 },
      { key: 'summary', count: 1 }, // {title} 无 range → 非法
    ]);
  });

  it('多画布：附加 sheet 缺 rootTopic → 计空画布并跳过（首 sheet 缺根仍 EMPTY）', () => {
    const topicOf = (title: string) => ({ class: 'topic', title });
    const bytes = jsonZip(
      JSON.stringify([
        { class: 'sheet', title: 'Sheet 1', rootTopic: topicOf('中心') },
        { class: 'sheet', title: '坏 Sheet' },
        { class: 'sheet', title: 'Sheet 3', rootTopic: topicOf('好') },
      ]),
    );
    const { sheets: __s, degraded } = parseXmind(bytes);
    expect(__s.map((s) => s.title)).toEqual(['Sheet 1', 'Sheet 3']);
    expect(degraded).toEqual([{ key: 'sheet', count: 1 }]);
  });

  it('plain 备注优先于 realHTML，两者都在时不因 realHTML 剥出空文本', () => {
    const bytes = jsonZip(
      sheet({
        class: 'topic',
        title: '中心',
        notes: { plain: { content: '纯文本' }, realHTML: { content: '<b>纯文本</b>' } },
      }),
    );
    const root = parseXmind(bytes).sheets[0]!.root;
    expect(root.note).toBe('纯文本');
  });

  it('rootTopic 无 title 时 title 为空串（合法），无 markers 等则零降级', () => {
    const bytes = jsonZip(sheet({ class: 'topic' }));
    const { sheets: __s, degraded } = parseXmind(bytes);
    const root = __s[0]!.root;
    expect(root.title).toBe('');
    expect(root.children).toEqual([]);
    expect(root.note).toBeUndefined();
    expect(degraded).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// resources 资源表（zip 扫描 + 魔数嗅探）
// ---------------------------------------------------------------------------

describe('parseXmind：resources 表', () => {
  it('魔数嗅探四格式入表（mime），白名单外不入表，zip 目录条目跳过', () => {
    const bytes = zipOf({
      'content.json': sheet({ class: 'topic', title: '中心' }),
      'resources/a.png': PNG_BYTES,
      'resources/b.jpg': JPG_BYTES,
      'resources/c.gif': GIF_BYTES,
      'resources/d.webp': WEBP_BYTES,
      'resources/e.png': TXT_BYTES,
      'resources/': new Uint8Array(0), // 真实 zip 里的目录条目
    });
    const { resources } = parseXmind(bytes);
    expect(Object.keys(resources).sort()).toEqual([
      'resources/a.png',
      'resources/b.jpg',
      'resources/c.gif',
      'resources/d.webp',
    ]);
    expect(resources['resources/a.png']).toEqual({ bytes: PNG_BYTES, mime: 'image/png' });
    expect(resources['resources/b.jpg']!.mime).toBe('image/jpeg');
    expect(resources['resources/c.gif']!.mime).toBe('image/gif');
    expect(resources['resources/d.webp']!.mime).toBe('image/webp');
    expect('resources/' in resources).toBe(false); // 目录条目跳过
    expect('resources/e.png' in resources).toBe(false); // 魔数不符不入表
  });
});

// ---------------------------------------------------------------------------
// content.xml 回落路径（XMind 8）
// ---------------------------------------------------------------------------

const xmlMap = (sheets: string) =>
  `<?xml version="1.0" encoding="UTF-8" standalone="no"?>` +
  `<map version="2.0" xmlns:xhtml="http://www.w3.org/1999/xhtml" xmlns:xlink="http://www.w3.org/1999/xlink" xmlns:svg="http://www.w3.org/2000/svg">${sheets}</map>`;

const ROOT_TOPIC_XML =
  '<topic id="t1"><title>中心</title><notes><plain>旧备注</plain></notes>' +
  '<children><topics type="attached">' +
  '<topic id="t2"><title>A</title><children><topics type="attached">' +
  '<topic id="t3"><title>A1</title></topic>' +
  '</topics></children></topic>' +
  '</topics><topics type="detached"><topic id="t4"><title>漂浮</title></topic></topics>' +
  '</children></topic>';

describe('parseXmind：content.xml 回落（XMind 8）', () => {
  it('根元素 xmap-content（真实 XMind 8 形状，T7 冒烟暴露）同样解析：不再误判 CORRUPTED', () => {
    // 真实文件根元素是 <xmap-content xmlns="urn:xmind:xmap:xmlns:content:2.0">，旧检查
    // 只认 <map>（合成夹具形状）→ 真实文件全被拒。双形状都接受（parse-xml 根检查注释）。
    const xml =
      '<?xml version="1.0" encoding="UTF-8" standalone="no"?>' +
      '<xmap-content xmlns="urn:xmind:xmap:xmlns:content:2.0" xmlns:xhtml="http://www.w3.org/1999/xhtml" version="2.0">' +
      `<sheet id="s1">${ROOT_TOPIC_XML}</sheet></xmap-content>`;
    const bytes = zipOf({ 'content.xml': xml });
    const { sheets: __s, degraded } = parseXmind(bytes);
    const root = __s[0]!.root;
    expect(root.title).toBe('中心');
    expect(root.children.map((c) => c.title)).toEqual(['A']);
    expect(degraded).toEqual([{ key: 'floating', count: 1 }]);
  });

  it('概要标签桶：真实形状 <topics type="summary">（T7 冒烟暴露）标签可取；detached 形状继续兼容（见概要用例）', () => {
    const topicXml =
      '<topic id="t1"><title>中心</title>' +
      '<summaries>' +
      '<summary id="s1" topic-id="m1" range="(0,0)"/>' +
      '<summary id="s2" topic-id="m2" range="(0,1)"/>' +
      '</summaries>' +
      '<children>' +
      '<topics type="attached">' +
      '<topic id="a1"><title>A</title></topic>' +
      '<topic id="a2"><title>B</title></topic>' +
      '</topics>' +
      '<topics type="summary">' + // 真实 XMind 8：标签 topic 与 attached 平级同桶（非 detached）
      '<topic id="m1"><title>要点</title></topic>' +
      '<topic id="m2"><title>区间</title></topic>' +
      '</topics>' +
      '</children></topic>';
    const bytes = zipOf({ 'content.xml': xmlMap(`<sheet id="s1">${topicXml}</sheet>`) });
    const { sheets: __s, degraded } = parseXmind(bytes);
    const root = __s[0]!.root;
    expect(root.summaries).toEqual([
      { start: 0, end: 0, label: '要点' }, // label 来自 topics type="summary" 的 m1
      { start: 0, end: 1, label: '区间' },
    ]);
    expect(degraded).toEqual([]); // summary 桶 topic 不计漂浮（非 detached），range 全合法
  });

  it('解析 content.xml：层级/文本/备注，detached 计漂浮主题', () => {
    const bytes = zipOf({ 'content.xml': xmlMap(`<sheet id="s1">${ROOT_TOPIC_XML}</sheet>`) });
    const { sheets: __s, degraded } = parseXmind(bytes);
    const root = __s[0]!.root;
    expect(root.title).toBe('中心');
    expect(root.note).toBe('旧备注');
    expect(root.children.map((c) => c.title)).toEqual(['A']);
    expect(root.children[0].children[0].title).toBe('A1');
    expect(degraded).toEqual([{ key: 'floating', count: 1 }]); // 漂浮主题（含子树按节点数计）
  });

  it('markers：<marker-ref marker-id> 双形状落位（task-done/symbol-idea），无对应计图标；labels/img/概要 各自入键', () => {
    const topicXml =
      '<topic id="t1"><title>中心</title>' +
      '<marker-refs><marker-ref marker-id="task-done"/><marker-ref marker-id="symbol-idea"/></marker-refs>' +
      '<labels><label>标签</label></labels>' +
      '<summaries><summary id="sum1" topic-id="t2"><title>概要</title></summary></summaries>' +
      '<children><topics type="attached">' +
      '<topic id="t2"><title>A</title><marker-refs><marker-ref marker-id="flag-blue"/></marker-refs><xhtml:img xlink:href="a.png"/></topic>' +
      '</topics></children></topic>';
    const bytes = zipOf({ 'content.xml': xmlMap(`<sheet id="s1">${topicXml}</sheet>`) });
    const { sheets: __s, degraded } = parseXmind(bytes);
    const root = __s[0]!.root;
    expect(root.icons).toEqual({ progress: ['done'], other: ['idea'] });
    expect(root.children[0].icons).toEqual({ flag: ['flag'] }); // flag-blue → flag 组（颜色丢弃）
    expect(degraded).toEqual([
      { key: 'label', count: 1 },
      { key: 'image', count: 1 }, // a.png 查 resources 无键
      { key: 'summary', count: 1 }, // summary 无 range 属性 → 非法
    ]);
  });

  it('概要：<summary range topic-id> + detached 标签；(0,0) 单点、(0,2) 区间；被引用 detached 豁免漂浮（子树不下钻）；外框同样豁免', () => {
    const topicXml =
      '<topic id="t1"><title>中心</title>' +
      '<summaries>' +
      '<summary id="s1" topic-id="d1" range="(0,0)"/>' +
      '<summary id="s2" topic-id="d2" range="(0,2)"/>' +
      '<summary id="s3" topic-id="d1" range="abc"/>' +
      '</summaries>' +
      '<boundaries><boundary id="b1" topic-id="d3" range="(0,1)"/></boundaries>' +
      '<children>' +
      '<topics type="attached">' +
      '<topic id="a1"><title>A</title></topic>' +
      '<topic id="a2"><title>B</title></topic>' +
      '<topic id="a3"><title>C</title></topic>' +
      '</topics>' +
      '<topics type="detached">' +
      '<topic id="d1"><title>要点</title><children><topics type="attached"><topic id="d1x"><title>不下钻</title></topic></topics></children></topic>' +
      '<topic id="d2"><title>区间</title></topic>' +
      '<topic id="d3"><title>被外框占用</title></topic>' +
      '<topic id="d4"><title>真漂浮</title></topic>' +
      '</topics>' +
      '</children></topic>';
    const bytes = zipOf({ 'content.xml': xmlMap(`<sheet id="s1">${topicXml}</sheet>`) });
    const { sheets: __s, degraded } = parseXmind(bytes);
    const root = __s[0]!.root;
    expect(root.summaries).toEqual([
      { start: 0, end: 0, label: '要点' }, // label 来自同父 detached d1 的 <title>
      { start: 0, end: 2, label: '区间' },
    ]);
    expect(degraded).toEqual([
      { key: 'boundary', count: 1 },
      { key: 'floating', count: 1 }, // d1/d2/d3 被引用豁免（d1 子树「不下钻」不计），仅 d4
      { key: 'summary', count: 1 }, // range="abc"
    ]);
  });

  it('图片：<img xhtml:src="xap:resources/…"> 属性真值；多图首张胜余者计图片；xlink:href 兜底；svg:width/height 取整', () => {
    const topicXml =
      '<topic id="t1"><title>中心</title>' +
      '<img align="bottom" svg:width="188" svg:height="348" xhtml:src="xap:resources/x.png"/>' +
      '<img xhtml:src="xap:resources/y.png"/>' +
      '<img xlink:href="xap:resources/x.png"/>' +
      '<img xhtml:src="xap:resources/gone.png"/>' +
      '<children><topics type="attached"><topic id="a1"><title>A</title></topic></topics></children></topic>';
    const bytes = zipOf({
      'content.xml': xmlMap(`<sheet id="s1">${topicXml}</sheet>`),
      'resources/x.png': PNG_BYTES,
    });
    const { sheets: __s, degraded, resources } = parseXmind(bytes);
    const root = __s[0]!.root;
    expect(root.image).toEqual({ path: 'resources/x.png', w: 188, h: 348, align: 'bottom' });
    expect(resources['resources/x.png']).toEqual({ bytes: PNG_BYTES, mime: 'image/png' });
    expect(degraded).toEqual([{ key: 'image', count: 3 }]); // 首张 x.png 胜出，y.png/重复 x.png/gone.png 逐张计
  });

  it('href：xlink:href http/https 透传，xapp: 计超链接', () => {
    const topicXml =
      '<topic id="t1"><title>中心</title>' +
      '<children><topics type="attached">' +
      '<topic id="a1" xlink:href="https://gmind.dev/a"><title>A</title></topic>' +
      '<topic id="a2" xlink:href="xapp://sheet/s2"><title>B</title></topic>' +
      '</topics></children></topic>';
    const bytes = zipOf({ 'content.xml': xmlMap(`<sheet id="s1">${topicXml}</sheet>`) });
    const { sheets: __s, degraded } = parseXmind(bytes);
    const root = __s[0]!.root;
    expect(root.children[0]!.href).toBe('https://gmind.dev/a');
    expect(root.children[1]!.href).toBeUndefined();
    expect(degraded).toEqual([{ key: 'link', count: 1 }]);
  });

  it('样式：topic style-id → styles.xml 间接表（四键映射 + 不支持键逐键计）；id 缺表逐个计', () => {
    const contentXml = xmlMap(
      `<sheet id="s1">` +
        '<topic id="t1" style-id="css1"><title>中心</title>' +
        '<children><topics type="attached"><topic id="a1" style-id="css404"><title>A</title></topic></topics></children>' +
        '</topic>' +
        `</sheet>`,
    );
    const stylesXml =
      '<?xml version="1.0" encoding="UTF-8" standalone="no"?>' +
      '<styles version="2.0">' +
      '<style id="css1" type="topic">' +
      '<property name="fo:color" value="#111111"/>' +
      '<property name="svg:fill" value="#F0F0F0"/>' +
      '<property name="svg:stroke-color" value="#FF0000"/>' +
      '<property name="fo:font-size" value="14px"/>' +
      '<property name="fo:font-family" value="Arial"/>' +
      '</style>' +
      '</styles>';

    const hit = parseXmind(zipOf({ 'content.xml': contentXml, 'styles.xml': stylesXml }));
    expect(hit.sheets[0]!.root.style).toEqual({
      color: '#111111',
      fill: '#F0F0F0',
      border: '#FF0000',
      fontSize: '14',
    });
    expect(hit.sheets[0]!.root.children[0]!.style).toBeUndefined(); // css404 缺表
    expect(hit.degraded).toEqual([{ key: 'styleProp', count: 2 }]); // font-family + css404

    const miss = parseXmind(zipOf({ 'content.xml': contentXml })); // zip 无 styles.xml
    expect(miss.sheets[0]!.root.style).toBeUndefined();
    expect(miss.degraded).toEqual([{ key: 'styleProp', count: 2 }]); // 两个 style-id 逐个计
  });

  it('结构：根 structure-class 映射 structureType、非根计结构覆盖；sheet theme 属性与子元素都不再计入（2026-11-14 需求方拍板）；legend 忽略', () => {
    const contentXml = xmlMap(
      '<sheet id="s1" theme="theme-dark"><legend><xhtml:div/></legend><theme><map-styles/></theme>' +
        '<topic id="t1" structure-class="org.xmind.ui.logic.right"><title>中心</title>' +
        '<children><topics type="attached"><topic id="a1" structure-class="org.xmind.ui.tree"><title>A</title></topic></topics></children>' +
        '</topic>' +
        '</sheet>',
    );
    const { sheets: __s, degraded } = parseXmind(zipOf({ 'content.xml': contentXml }));
    expect(__s[0]!.structureType).toBe('logic');
    expect(degraded).toEqual([
      { key: 'structureOverride', count: 1 }, // 非根 a1；theme 属性+子元素均不再计入
    ]);
  });

  it('标注/外框/任务信息/标签/附件各自计数（XML callout 按子树节点数）', () => {
    const topicXml =
      '<topic id="t1"><title>中心</title>' +
      '<labels><label>标签</label></labels>' +
      '<attachments><attachment/><attachment/></attachments>' +
      '<taskinfo percent-done="40"/>' +
      '<task-info percent-done="60"/>' + // 备选拼写同样计任务信息
      '<children>' +
      '<topics type="attached"><topic id="a1"><title>A</title></topic></topics>' +
      '<topics type="callout"><topic id="c1"><title>标注</title><children><topics type="attached"><topic id="c2"><title>内</title></topic></topics></children></topic></topics>' +
      '</children></topic>';
    const bytes = zipOf({ 'content.xml': xmlMap(`<sheet id="s1">${topicXml}</sheet>`) });
    const { degraded } = parseXmind(bytes);
    expect(degraded).toEqual([
      { key: 'label', count: 1 },
      { key: 'attachment', count: 2 },
      { key: 'callout', count: 2 },
      { key: 'taskInfo', count: 2 }, // taskinfo + task-info 两种拼写逐个计
    ]);
  });

  it('xml 多画布：附加 sheet 逐个产出（裁定 8），不再计空画布', () => {
    const bytes = zipOf({
      'content.xml': xmlMap(
        `<sheet id="s1">${ROOT_TOPIC_XML}</sheet><sheet id="s2"><title>第二张</title><topic id="t9"><title>x</title></topic></sheet>`,
      ),
    });
    const { sheets: __s, degraded } = parseXmind(bytes);
    expect(__s).toHaveLength(2);
    expect(__s[1]!.title).toBe('第二张'); // XMind 8 sheet 级 <title> 提取
    expect(__s[1]!.root.title).toBe('x');
    expect(degraded).toEqual([{ key: 'floating', count: 1 }]); // 仅漂浮主题（额外 sheet 自此进多画布）
  });

  it('xml 多画布：附加 sheet 缺 topic → 计空画布并跳过', () => {
    const bytes = zipOf({
      'content.xml': xmlMap(
        `<sheet id="s1">${ROOT_TOPIC_XML}</sheet><sheet id="s2"><title>坏 Sheet</title></sheet>`,
      ),
    });
    const { degraded } = parseXmind(bytes);
    expect(degraded).toEqual([{ key: 'floating', count: 1 }, { key: 'sheet', count: 1 }]);
  });

  it('xml 根元素非 <map> → CORRUPTED', () => {
    const bytes = zipOf({ 'content.xml': '<?xml version="1.0"?><foo><bar/></foo>' });
    expectParseError(bytes, 'CORRUPTED');
  });

  it('xml 未闭合标签 → CORRUPTED', () => {
    const bytes = zipOf({ 'content.xml': '<map><sheet><topic><title>x</title></topic></sheet>' });
    expectParseError(bytes, 'CORRUPTED');
  });

  it('xml 有 sheet 无 topic → EMPTY', () => {
    const bytes = zipOf({ 'content.xml': xmlMap('<sheet id="s1"/>') });
    expectParseError(bytes, 'EMPTY');
  });
});

// ---------------------------------------------------------------------------
// 错误契约
// ---------------------------------------------------------------------------

describe('parseXmind：错误契约', () => {
  it('非法 zip 字节 → CORRUPTED', () => {
    expectParseError(new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]), 'CORRUPTED');
  });

  it('content.json 非法 JSON → CORRUPTED', () => {
    expectParseError(jsonZip('{not-json'), 'CORRUPTED');
  });

  it('content.json 顶层不是数组 → CORRUPTED', () => {
    expectParseError(jsonZip('{"class":"sheet"}'), 'CORRUPTED');
  });

  it('zip 既无 content.json 也无 content.xml → UNSUPPORTED_FORMAT（行为不回归）', () => {
    const bytes = zipOf({ 'readme.txt': strToU8('hi'), 'metadata.json': strToU8('{}') });
    expectParseError(bytes, 'UNSUPPORTED_FORMAT');
  });

  it('sheet 无 rootTopic → EMPTY', () => {
    const bytes = jsonZip(JSON.stringify([{ class: 'sheet', title: 'Sheet 1' }]));
    expectParseError(bytes, 'EMPTY');
  });

  it('sheet 数组为空 → EMPTY', () => {
    expectParseError(jsonZip('[]'), 'EMPTY');
  });
});
