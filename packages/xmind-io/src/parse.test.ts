// @vitest-environment jsdom
// parse.test.ts：parseXmind 的 content.json（2020+）主路径、content.xml（XMind 8）回落路径、
// 降级计数与三种错误码（CORRUPTED / UNSUPPORTED_FORMAT / EMPTY）。zip 夹具用 fflate 现场构造。
import { describe, expect, it } from 'vitest';
import { strToU8, zipSync } from 'fflate';
import { parseXmind, XmindParseError } from './index';
import type { XmindErrorCode } from './index';

// ---------------------------------------------------------------------------
// 夹具：测试内直接构造 zip，无需二进制 fixture 文件。
// ---------------------------------------------------------------------------

const sheet = (rootTopic: unknown) =>
  JSON.stringify([{ class: 'sheet', title: 'Sheet 1', rootTopic }]);

const zipOf = (files: Record<string, string>): Uint8Array =>
  zipSync(Object.fromEntries(Object.entries(files).map(([k, v]) => [k, strToU8(v)])));

const jsonZip = (contentJson: string): Uint8Array => zipOf({ 'content.json': contentJson });

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
    const { root, degraded } = parseXmind(bytes);
    expect(root.title).toBe('中心');
    expect(root.note).toBe('根备注');
    expect(root.children.map((c) => c.title)).toEqual(['A', 'B']);
    expect(root.children[0].children[0].title).toBe('A1');
    expect(degraded).toEqual([]);
  });

  it('降级计数：labels/realHTML 备注/漂浮主题（M7a-T1：markers 有对应者映射不再计降级）', () => {
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
    const { root, degraded } = parseXmind(bytes);
    expect(root.children).toHaveLength(1); // detached 不进树
    expect(root.children[0].note).toBe('富'); // realHTML 剥标签取文本
    const kinds = Object.fromEntries(degraded.map((d) => [d.kind, d.count]));
    expect(kinds.style).toBe(1); // 仅 labels（priority-1 已映射进 icons）
    expect(kinds.media).toBeUndefined(); // 本例无媒体
    expect(kinds.structure).toBeGreaterThanOrEqual(1); // detached
  });

  it('M7a-T1 标记映射：priority 1-7 原值、8/9 收敛 7；flag-*/star-* → icon；star 恒胜；同组后续与无对应均计降级', () => {
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
    expect(parseXmind(bytes).root.icons).toEqual({ priority: '3' });

    const hi = parseXmind(
      jsonZip(
        JSON.stringify([
          { class: 'sheet', title: 'S', rootTopic: topicOf([{ markerId: 'priority-9' }, { markerId: 'priority-2' }]) },
        ]),
      ),
    );
    expect(hi.root.icons).toEqual({ priority: '7' }); // 9→7；同组首个胜（priority-9 先出现）
    expect(hi.degraded).toEqual([{ kind: 'style', count: 1 }]); // 被单选吞掉的 priority-2 计入 dropped（R1 2.4）

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
    expect(fs.root.icons).toEqual({ icon: 'important' }); // star 恒胜：无条件覆盖 flag 映射（对齐 repair）
    expect(fs.degraded).toEqual([{ kind: 'style', count: 1 }]); // 被 star 吞掉的 flag 计入 dropped

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
    expect(sf.root.icons).toEqual({ icon: 'important' }); // star 恒胜与出现顺序无关
    expect(sf.degraded).toEqual([{ kind: 'style', count: 1 }]); // 两种顺序下 flag 同样被吞掉计入 dropped

    const st = jsonZip(
      JSON.stringify([{ class: 'sheet', title: 'S', rootTopic: topicOf([{ markerId: 'star-red' }]) }],
      ),
    );
    expect(parseXmind(st).root.icons).toEqual({ icon: 'important' });

    const dropped = parseXmind(
      jsonZip(JSON.stringify([{ class: 'sheet', title: 'S', rootTopic: topicOf([{ markerId: 'task-start' }, { markerId: 'smiley-smile' }]) }])),
    );
    expect(dropped.root.icons).toBeUndefined(); // 无对应 → 不产 icons
    expect(dropped.degraded).toEqual([{ kind: 'style', count: 2 }]); // 丢弃并登记
  });

  it('降级计数：图片/附件/备注内图片 → media，概要/额外 sheet → structure', () => {
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
    const { root, degraded } = parseXmind(bytes);
    expect(root.children).toHaveLength(1);
    const kinds = Object.fromEntries(degraded.map((d) => [d.kind, d.count]));
    expect(kinds.media).toBe(4); // topic.image 1 + attachments 2 + 备注内图片 1
    expect(kinds.structure).toBe(3); // summaries 1 + 额外 sheet 2
    expect(kinds.style).toBeUndefined(); // 无样式类降级则不输出该 kind
  });

  it('style 属性与 sheet theme 计入 style 降级', () => {
    const bytes = jsonZip(
      JSON.stringify([
        {
          class: 'sheet',
          title: 'Sheet 1',
          theme: { id: 'theme-dark' },
          rootTopic: { class: 'topic', title: '中心', style: { id: 'css-1' } },
        },
      ]),
    );
    const { degraded } = parseXmind(bytes);
    expect(degraded).toEqual([{ kind: 'style', count: 2 }]);
  });

  it('plain 备注优先于 realHTML，两者都在时不因 realHTML 剥出空文本', () => {
    const bytes = jsonZip(
      sheet({
        class: 'topic',
        title: '中心',
        notes: { plain: { content: '纯文本' }, realHTML: { content: '<b>纯文本</b>' } },
      }),
    );
    const { root } = parseXmind(bytes);
    expect(root.note).toBe('纯文本');
  });

  it('rootTopic 无 title 时 title 为空串（合法），无 markers 等则零降级', () => {
    const bytes = jsonZip(sheet({ class: 'topic' }));
    const { root, degraded } = parseXmind(bytes);
    expect(root.title).toBe('');
    expect(root.children).toEqual([]);
    expect(root.note).toBeUndefined();
    expect(degraded).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// content.xml 回落路径（XMind 8）
// ---------------------------------------------------------------------------

const xmlMap = (sheets: string) =>
  `<?xml version="1.0" encoding="UTF-8" standalone="no"?>` +
  `<map version="2.0" xmlns:xhtml="http://www.w3.org/1999/xhtml" xmlns:xlink="http://www.w3.org/1999/xlink">${sheets}</map>`;

const ROOT_TOPIC_XML =
  '<topic id="t1"><title>中心</title><notes><plain>旧备注</plain></notes>' +
  '<children><topics type="attached">' +
  '<topic id="t2"><title>A</title><children><topics type="attached">' +
  '<topic id="t3"><title>A1</title></topic>' +
  '</topics></children></topic>' +
  '</topics><topics type="detached"><topic id="t4"><title>漂浮</title></topic></topics>' +
  '</children></topic>';

describe('parseXmind：content.xml 回落（XMind 8）', () => {
  it('解析 content.xml：层级/文本/备注，detached 计入降级', () => {
    const bytes = zipOf({ 'content.xml': xmlMap(`<sheet id="s1">${ROOT_TOPIC_XML}</sheet>`) });
    const { root, degraded } = parseXmind(bytes);
    expect(root.title).toBe('中心');
    expect(root.note).toBe('旧备注');
    expect(root.children.map((c) => c.title)).toEqual(['A']);
    expect(root.children[0].children[0].title).toBe('A1');
    const kinds = Object.fromEntries(degraded.map((d) => [d.kind, d.count]));
    expect(kinds.structure).toBe(1); // 漂浮主题（含子树按节点数计）
    expect(kinds.style).toBeUndefined();
    expect(kinds.media).toBeUndefined();
  });

  it('xml markers 映射三组制（priority/flag/star），无对应才计降级；labels/图片/概要 计入对应降级', () => {
    const topicXml =
      '<topic id="t1"><title>中心</title>' +
      '<marker-refs><marker-ref marker-id="priority-1"/><marker-ref marker-id="star-red"/><marker-ref marker-id="task-start"/></marker-refs>' +
      '<labels><label>标签</label></labels>' +
      '<summaries><summary id="sum1" topic-id="t2"><title>概要</title></summary></summaries>' +
      '<children><topics type="attached">' +
      '<topic id="t2"><title>A</title><marker-refs><marker-ref marker-id="flag-blue"/></marker-refs><xhtml:img xlink:href="a.png"/></topic>' +
      '</topics></children></topic>';
    const bytes = zipOf({ 'content.xml': xmlMap(`<sheet id="s1">${topicXml}</sheet>`) });
    const { root, degraded } = parseXmind(bytes);
    expect(root.icons).toEqual({ priority: '1', icon: 'important' }); // priority-1 + star-red→important
    expect(root.children[0].icons).toEqual({ icon: 'flag' }); // flag-blue → icon flag
    const kinds = Object.fromEntries(degraded.map((d) => [d.kind, d.count]));
    expect(kinds.style).toBe(2); // task-start（无对应丢弃）+ label 1
    expect(kinds.media).toBe(1); // 图片
    expect(kinds.structure).toBe(1); // 概要
  });

  it('xml 额外 sheet 计入 structure 降级', () => {
    const bytes = zipOf({
      'content.xml': xmlMap(
        `<sheet id="s1">${ROOT_TOPIC_XML}</sheet><sheet id="s2"><topic id="t9"><title>x</title></topic></sheet>`,
      ),
    });
    const { degraded } = parseXmind(bytes);
    const kinds = Object.fromEntries(degraded.map((d) => [d.kind, d.count]));
    expect(kinds.structure).toBe(2); // 漂浮 1 + 额外 sheet 1
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

  it('zip 既无 content.json 也无 content.xml → UNSUPPORTED_FORMAT', () => {
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
