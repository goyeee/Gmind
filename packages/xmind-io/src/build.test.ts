// build.test.ts：buildXmind 产物结构——可被 unzipSync 读回，content.json 形状正确。
// 2026-11-14 导出写回 v2：href/style 五键（topic href + style 四键过滤非空，fontSize
// 产 "<n>px"）、extra 第二参（仅 e2e 夹具开口，键原样合入 zip）、不传 extra 时产物
// 与现状逐字节一致（条目字节金样钉死）。
// 2026-11-15 v2.1（导出返工 Task 1）：sheet/topic id（缺省 crypto.randomUUID，测试注
// 入确定性工厂）、根 structureClass 三值映射、manifest.json 条目、metadata creator 对
// 象形式——既有金样用例改注入工厂，条目字节金样重捕获。
// 2026-11-15 v2.3（导出保真第三波 Task 1）：每 sheet 携带 theme（金样串独立捕获拼入
// 条件字节金样）、topic.image 四键展开（w/h/align 缺省不产键）、manifest 登记 extra
// 全部键——依据：需求方验收反馈「图片没导出来」「连接线直愣愣的」。
// 2026-11-15 v2.4（导出主题按结构选型 Task 1）：theme 二选一——mindmap 画布→
// THEME_MINDMAP（curve 曲线，金样串独立捕获钉死）、logic/org/缺省→THEME_LOGIC
// （v2.3 原 DEFAULT_THEME 改名，roundedElbow 金样不回归）——依据：需求方反馈
// 思维导图页导出线条「直愣愣」+ 35 份真实思维导图文件 27 份 curve 主流统计。
// 2026-11-15 分侧忠实还原 Task 2：mindmap+rightCount → 根 topic extensions
// right-number 金样逐字写回（content 值为字符串数字；0=全左合法）；缺省/非
// mindmap 不产键——无 rightCount 的既有产物条目字节金样零改动（上方用例钉死）。
import { describe, expect, it } from 'vitest';
import { unzipSync } from 'fflate';
import { buildXmind, zipEntries } from './index';
import type { XmindNode, XmindStructureType } from './index';

/** v2.1 id 断言用递归形状：id + 可选 children.attached（产物仅非空子级才有 children 键）。 */
type AssertTopic = { id?: unknown; children?: { attached?: AssertTopic[] } };

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
/** 金样 content.json 串（逐字节捕获自 v2.1 实现；id 注入确定性工厂 id-1~id-4，调用序=
 *  sheet→root→A→A1 先序；metadata.json/manifest.json 同为 v2.1 形状；v2.3 起 sheet 末位
 *  追加 theme，见 GOLDEN_THEME_JSON）。
 *  注：fflate zipSync 容器头嵌 Date.now() 时间戳，zip 原始字节不具跨次运行确定性——
 *  「与 v2.1 产物逐字节一致」钉在条目字节层（条目集 + 各条目字节），容器结构未动零风险。 */
/** v2.3 theme 金样串：**独立**捕获自本机真实 Zen 金样「张智建总结计划 2025-08-01.xmind」
 *  content.json 的 sheet.theme（compact JSON，与 JSON.stringify 同形）——非转抄实现产物，
 *  拼入金样即证 build.ts THEME_LOGIC（v2.3 名 DEFAULT_THEME）与金样 theme 逐字节一致
 *  （十五键全文）。 */
const GOLDEN_THEME_JSON =
  '{"centralTopic":{"id":"e61f909d-0249-4b87-866f-2a7881b15030","properties":{"fo:font-family":"NeverMind","fo:font-size":"28pt","fo:font-weight":"600","fo:font-style":"normal","fo:text-transform":"manual","fo:text-decoration":"none","fo:text-align":"center","svg:fill":"#4D86DB","fill-pattern":"solid","line-width":"2pt","line-color":"#4D86DB","line-pattern":"solid","border-line-width":"0pt","shape-class":"org.xmind.topicShape.roundedRect","line-class":"org.xmind.branchConnection.roundedfold","arrow-end-class":"org.xmind.arrowShape.none","alignment-by-level":"actived"}},"mainTopic":{"id":"537df260-9612-4fed-a26c-a114a66efde3","properties":{"fo:font-family":"NeverMind","fo:font-size":"18pt","fo:font-weight":"600","fo:font-style":"normal","fo:text-transform":"manual","fo:text-decoration":"none","fo:text-align":"left","fill-pattern":"solid","border-line-width":"0pt","shape-class":"org.xmind.topicShape.roundedRect","line-class":"org.xmind.branchConnection.roundedElbow"}},"subTopic":{"id":"9e449fd4-7218-4b16-ab44-4c5f5fc4127c","properties":{"fo:font-family":"NeverMind","fo:font-size":"14pt","fo:font-weight":"400","fo:font-style":"normal","fo:text-transform":"manual","fo:text-decoration":"none","fo:text-align":"left","fill-pattern":"solid","border-line-width":"0pt","shape-class":"org.xmind.topicShape.roundedRect","line-class":"org.xmind.branchConnection.roundedElbow"}},"summaryTopic":{"id":"a2b6b85d-716b-4814-a5b3-4412a4f06ebf","properties":{"fo:font-family":"Montserrat","fo:font-size":"14pt","fo:font-weight":"400","fo:font-style":"normal","fo:text-transform":"manual","fo:text-decoration":"none","fo:text-align":"center","svg:fill":"#00000000","fill-pattern":"solid","border-line-color":"#4D86DB","shape-class":"org.xmind.topicShape.roundedRect","line-class":"org.xmind.branchConnection.roundedElbow"}},"calloutTopic":{"id":"d663932a-c424-4e13-8496-e26e3ce34283","properties":{"fo:font-family":"NeverMind","fo:font-size":"14pt","fo:font-weight":"600","fo:font-style":"normal","fo:text-transform":"manual","fo:text-decoration":"none","fo:text-align":"left","svg:fill":"#4D86DB","fill-pattern":"solid","border-line-color":"#4D86DB","shape-class":"org.xmind.topicShape.ellipse"}},"floatingTopic":{"id":"9319e51f-7887-4891-a790-fc92128171fd","properties":{"fo:font-family":"Montserrat","fo:font-size":"14pt","fo:font-weight":"normal","fo:font-style":"normal","fo:text-transform":"manual","fo:text-decoration":"none","fo:text-align":"center","svg:fill":"#EEEBEE","fill-pattern":"solid","line-pattern":"solid","border-line-color":"#EEEBEE","border-line-width":"0pt","shape-class":"org.xmind.topicShape.roundedRect","line-class":"org.xmind.branchConnection.roundedElbow","arrow-end-class":"org.xmind.arrowShape.none"}},"boundary":{"id":"71580337-3dff-489b-b5b3-927007835355","properties":{"fo:font-family":"\'NeverMind\',\'Microsoft YaHei\',\'PingFang SC\',\'Microsoft JhengHei\',\'sans-serif\',sans-serif","fo:font-size":"14pt","fo:font-weight":"600","fo:font-style":"normal","fo:text-transform":"manual","fo:text-decoration":"none","fo:text-align":"center","svg:fill":"#4D86DB","fill-pattern":"solid","line-width":"2","line-color":"#4D86DB","line-pattern":"dash","shape-class":"org.xmind.boundaryShape.roundedRect"}},"summary":{"id":"a2bbba5a-4253-437e-b807-d31b5dcff18d","properties":{"line-width":"2pt","line-color":"#4D86DB","line-pattern":"solid","shape-class":"org.xmind.summaryShape.square"}},"relationship":{"id":"6eca12dd-30c8-44cc-ab5e-05685b89bc36","properties":{"fo:font-family":"\'NeverMind\',\'Microsoft YaHei\',\'PingFang SC\',\'Microsoft JhengHei\',\'sans-serif\',sans-serif","fo:font-size":"13pt","fo:font-weight":"600","fo:font-style":"normal","fo:text-transform":"manual","fo:text-decoration":"none","fo:text-align":"center","line-width":"2","line-color":"#4D86DB","line-pattern":"dash","shape-class":"org.xmind.relationshipShape.curved","arrow-begin-class":"org.xmind.arrowShape.none","arrow-end-class":"org.xmind.arrowShape.triangle"}},"map":{"id":"395b0355-65ec-4298-8267-b12857d8ab77","properties":{"svg:fill":"#FFFFFF","multi-line-colors":"#D3BD6C #ADB66B #76B18A #54A39B #5192A4 #7878A0","color-list":"#000229 #1F2766 #52CC83 #4D86DB #99142F #245570","line-tapered":"none"}},"importantTopic":{"id":"804cc97b-bce9-4393-8633-ac6a8957d319","properties":{"svg:fill":"#86DB4D","fill-pattern":"solid","border-line-color":"#86DB4D"}},"minorTopic":{"id":"0ce9108f-71bc-4ef0-919c-697679279061","properties":{"svg:fill":"#DB4D86","fill-pattern":"solid","border-line-color":"#DB4D86"}},"expiredTopic":{"id":"cc15dbe9-4956-470d-b379-a55185ff73ef","properties":{"fo:text-decoration":"line-through","svg:fill":"#00000000"}},"skeletonThemeId":"a148ee55687bdfc44af2fa5f16","colorThemeId":"Rainbow-#4D86DB-MULTI_LINE_COLORS"}';
/** v2.4 mindmap 主题金样串：**独立**捕获自本机真实思维导图金样「邢安家2025.08.01.xmind」
 *  content.json 中 map.unbalanced 画布的 sheet.theme（compact JSON，与 JSON.stringify
 *  同形）——非转抄实现产物，拼入金样即证 build.ts THEME_MINDMAP 与金样 theme 逐字节
 *  一致：十键（subTopic/summary/boundary/calloutTopic/centralTopic/mainTopic/
 *  summaryTopic/floatingTopic/relationship/map，各层 `{type,properties}` 原文），
 *  central/main/sub/summaryTopic 的 line-class 全 curve，无 skeletonThemeId/
 *  colorThemeId 键。 */
const GOLDEN_MINDMAP_THEME_JSON =
  '{"subTopic":{"type":"topic","properties":{"border-line-color":"#558ED5","border-line-width":"3pt","fo:font-family":"Microsoft YaHei","line-class":"org.xmind.branchConnection.curve","line-color":"#558ED5","line-width":"1pt"}},"summary":{"type":"summary","properties":{"line-color":"#C3D69B","line-width":"5pt","shape-class":"org.xmind.summaryShape.square"}},"boundary":{"type":"boundary","properties":{"fo:color":"#FFFFFF","fo:font-family":"Microsoft YaHei","fo:font-size":"10pt","fo:font-style":"italic","line-color":"#77933C","line-pattern":"dot","line-width":"3pt","shape-class":"org.xmind.boundaryShape.roundedRect","svg:fill":"#C3D69B","svg:opacity":".2"}},"calloutTopic":{"type":"topic","properties":{"border-line-color":"#F1BD51","border-line-width":"2pt","fo:font-family":"Microsoft YaHei","svg:fill":"#FBF09C"}},"centralTopic":{"type":"topic","properties":{"border-line-color":"#558ED5","border-line-width":"5pt","fo:color":"#376092","fo:font-family":"Microsoft YaHei","line-class":"org.xmind.branchConnection.curve","line-color":"#558ED5","line-width":"1pt","shape-class":"org.xmind.topicShape.roundedRect","svg:fill":"#DCE6F2"}},"mainTopic":{"type":"topic","properties":{"border-line-color":"#558ED5","border-line-width":"2pt","fo:color":"#17375E","fo:font-family":"Microsoft YaHei","line-class":"org.xmind.branchConnection.curve","line-color":"#558ED5","line-width":"1pt","shape-class":"org.xmind.topicShape.roundedRect","svg:fill":"#DCE6F2"}},"summaryTopic":{"type":"topic","properties":{"border-line-width":"0pt","fo:color":"#FFFFFF","fo:font-family":"Microsoft YaHei","fo:font-size":"10pt","fo:font-style":"italic","line-class":"org.xmind.branchConnection.curve","shape-class":"org.xmind.topicShape.roundedRect","svg:fill":"#77933C"}},"floatingTopic":{"type":"topic","properties":{"border-line-width":"0pt","fo:color":"#FFFFFF","fo:font-family":"Microsoft YaHei","fo:font-weight":"bold","line-color":"#558ED5","svg:fill":"#558ED5"}},"relationship":{"type":"relationship","properties":{"arrow-end-class":"org.xmind.arrowShape.triangle","fo:color":"#595959","fo:font-family":"Microsoft YaHei","fo:font-size":"10pt","fo:font-style":"italic","fo:font-weight":"normal","fo:text-decoration":"none","line-color":"#77933C","line-pattern":"dash","line-width":"3pt"}},"map":{"type":"map","properties":{"color-gradient":"none","line-tapered":"none","multi-line-colors":"none","svg:fill":"#FFFFFF"}}}';
const GOLDEN_CONTENT_JSON =
  '[{"class":"sheet","id":"id-1","title":"Sheet 1","rootTopic":{"class":"topic","id":"id-2","title":"中心","notes":{"plain":{"content":"根备注"}},"children":{"attached":[{"class":"topic","id":"id-3","title":"A","markers":[{"markerId":"priority-5"},{"markerId":"flag-red"}],"children":{"attached":[{"class":"topic","id":"id-4","title":"A1"}]}}]}},"theme":' +
  GOLDEN_THEME_JSON +
  '}]';
/** v2.1 确定性 id 工厂：每次调用产全新计数器（三次构建同 id 序，条目字节才可逐字节比对）。 */
const goldenIds = (): (() => string) => {
  let n = 0;
  return () => `id-${++n}`;
};

describe('buildXmind', () => {
  it('生成 zip：含 content.json 与 manifest.json/metadata.json，content.json 可解析且形状正确', () => {
    let n = 0;
    const seq = (p: string) => () => `${p}-${++n}`;
    const tree: XmindNode = {
      title: '中心',
      note: '根备注',
      children: [{ title: 'A', children: [{ title: 'A1', children: [] }] }],
    };
    const bytes = buildXmind([{ title: 'Sheet 1', root: tree }], undefined, seq('id'));
    const files = unzipSync(bytes);
    expect(Object.keys(files).sort()).toEqual(['content.json', 'manifest.json', 'metadata.json']);
    const sheets = JSON.parse(new TextDecoder().decode(files['content.json']));
    expect(sheets).toHaveLength(1);
    expect(sheets[0].class).toBe('sheet');
    expect(sheets[0].id).toBe('id-1'); // sheet id（v2.1）：先于本画布全部 topic
    expect(sheets[0].rootTopic).toEqual({
      class: 'topic',
      id: 'id-2',
      title: '中心',
      notes: { plain: { content: '根备注' } },
      children: {
        attached: [
          {
            class: 'topic',
            id: 'id-3',
            title: 'A',
            children: { attached: [{ class: 'topic', id: 'id-4', title: 'A1' }] },
          },
        ],
      },
    });
    expect(JSON.parse(new TextDecoder().decode(files['metadata.json']))).toEqual({
      creator: { name: 'Gmind', version: '1.0' }, // v2.1：creator 升对象形式
    });
  });

  it('无备注/无子级时不产生冗余字段', () => {
    let n = 0;
    const seq = (p: string) => () => `${p}-${++n}`;
    const bytes = buildXmind([{ title: 'Sheet 1', root: { title: '单点', children: [] } }], undefined, seq('id'));
    const files = unzipSync(bytes);
    const sheets = JSON.parse(new TextDecoder().decode(files['content.json']));
    // id（v2.1）之外不产冗余键：无 notes/markers/children 等键
    expect(sheets[0].rootTopic).toEqual({ class: 'topic', id: 'id-2', title: '单点' });
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
      'manifest.json',
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

  it('注入 idFactory（extra 缺省/空对象）时产物与 v2.3 金样逐字节一致（条目字节金样）', () => {
    const readEntries = (bytes: Uint8Array): Record<string, string> => {
      const files = unzipSync(bytes);
      return Object.fromEntries(
        Object.keys(files)
          .sort()
          .map((k) => [k, new TextDecoder().decode(files[k])]),
      );
    };
    const baseline = readEntries(buildXmind(GOLDEN_SHEETS, undefined, goldenIds()));
    // 条目集与各条目字节逐字节等于金样（id-1~id-4 / v2.3 theme 拼入 content.json /
    // manifest / metadata 对象形式；theme 段=真实金样独立捕获串，证 THEME_LOGIC 逐字一致）
    expect(Object.keys(baseline)).toEqual(['content.json', 'manifest.json', 'metadata.json']);
    expect(baseline['content.json']).toBe(GOLDEN_CONTENT_JSON);
    expect(baseline['manifest.json']).toBe('{"file-entries":{"content.json":{},"metadata.json":{}}}');
    expect(baseline['metadata.json']).toBe('{"creator":{"name":"Gmind","version":"1.0"}}');
    // 空对象 extra 与不传：条目字节完全一致（第二参缺省零影响；idFactory 各自全新计数）
    expect(readEntries(buildXmind(GOLDEN_SHEETS, {}, goldenIds()))).toEqual(baseline);
    expect(readEntries(buildXmind(GOLDEN_SHEETS, undefined, goldenIds()))).toEqual(baseline);
    // v2.3：传 extra 时 manifest 逐键登记（核心两键在前、extra 键随后，字节钉）
    const withExtra = readEntries(
      buildXmind(GOLDEN_SHEETS, { 'resources/pic.png': new Uint8Array([1]) }, goldenIds()),
    );
    expect(withExtra['manifest.json']).toBe(
      '{"file-entries":{"content.json":{},"metadata.json":{},"resources/pic.png":{}}}',
    );
  });

  // —— v2.1（2026-11-15 导出返工 Task 1）：id/structureClass/manifest/metadata 写回 ——
  // 依据：需求方反馈导出件在 XMind 8 打不开（Zen SheetDeserializer.parseTopic 对 topic id
  // 断言非空），对照本机真实 Zen JSON 金样（creator Vana 24.01）补齐必需键。

  it('v2.1 id 写回：注入确定性工厂，sheet 与每层 topic 均产非空唯一 id（先序遍历序）', () => {
    let n = 0;
    const seq = (p: string) => () => `${p}-${++n}`;
    const tree: XmindNode = {
      title: '根',
      children: [
        { title: 'A', children: [{ title: 'A1', children: [] }] },
        { title: 'B', children: [] },
      ],
    };
    const files = unzipSync(buildXmind([{ title: '画布', root: tree }], undefined, seq('id')));
    const sheets = JSON.parse(new TextDecoder().decode(files['content.json'])) as Array<{
      id?: unknown;
      rootTopic: AssertTopic;
    }>;
    expect(sheets[0].id).toBe('id-1'); // sheet id 先于本画布全部 topic
    expect(sheets[0].rootTopic.id).toBe('id-2'); // 根 → 子 → 孙：先序
    expect(sheets[0].rootTopic.children?.attached?.[0].id).toBe('id-3'); // A
    expect(sheets[0].rootTopic.children?.attached?.[0].children?.attached?.[0].id).toBe('id-4'); // A1
    expect(sheets[0].rootTopic.children?.attached?.[1].id).toBe('id-5'); // B
    // 通用面：每层 topic 都有非空 string id 且全树唯一（递归兜底，不依赖上方点位枚举）
    const ids: string[] = [];
    const walk = (t: Record<string, unknown>): void => {
      expect(typeof t.id).toBe('string');
      expect(t.id as string).not.toBe('');
      ids.push(t.id as string);
      const kids = (t.children as { attached?: unknown[] } | undefined)?.attached ?? [];
      for (const c of kids as Record<string, unknown>[]) walk(c);
    };
    walk(sheets[0].rootTopic);
    expect(new Set(ids).size).toBe(ids.length);
    // 缺省工厂（生产路径）：crypto.randomUUID 的 UUID 形状，sheet 与 topic 不撞
    const defSheets = JSON.parse(
      new TextDecoder().decode(
        unzipSync(buildXmind([{ title: '', root: { title: 'r', children: [] } }]))['content.json'],
      ),
    ) as Array<{ id?: unknown; rootTopic: { id?: unknown } }>;
    const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
    expect(defSheets[0].id).toMatch(UUID);
    expect(defSheets[0].rootTopic.id).toMatch(UUID);
    expect(defSheets[0].id).not.toBe(defSheets[0].rootTopic.id);
  });

  it('v2.1 structureClass：structureType 三值映射 XMind 标准结构 id；缺省不产键；仅 rootTopic 携带', () => {
    const CASES: Array<[XmindStructureType, string]> = [
      ['logic', 'org.xmind.ui.logic.right'], // 本机真实金样实证值
      ['mindmap', 'org.xmind.ui.map.unbalanced'],
      ['org', 'org.xmind.ui.org-chart.balanced'],
    ];
    for (const [structureType, expected] of CASES) {
      const files = unzipSync(
        buildXmind([{ title: '', root: { title: '根', children: [{ title: '子', children: [] }] }, structureType }]),
      );
      const sheets = JSON.parse(new TextDecoder().decode(files['content.json'])) as Array<{
        rootTopic: Record<string, unknown> & { children: { attached: Record<string, unknown>[] } };
      }>;
      expect(sheets[0].rootTopic.structureClass).toBe(expected);
      // 结构类只出现在 rootTopic：子 topic 恒无（解析侧 parse-json:218 非根计 structureOverride）
      expect('structureClass' in sheets[0].rootTopic.children.attached[0]).toBe(false);
    }
    const bare = JSON.parse(
      new TextDecoder().decode(
        unzipSync(buildXmind([{ title: '', root: { title: '根', children: [] } }]))['content.json'],
      ),
    ) as Array<{ rootTopic: Record<string, unknown> }>;
    expect('structureClass' in bare[0].rootTopic).toBe(false); // 无 structureType：不产键
  });

  it('v2.1 容器：zip 含 manifest.json，file-entries 登记 content.json/metadata.json；metadata creator 对象形式', () => {
    const files = unzipSync(buildXmind([{ title: '', root: { title: '根', children: [] } }]));
    expect(Object.keys(files).sort()).toEqual(['content.json', 'manifest.json', 'metadata.json']);
    expect(JSON.parse(new TextDecoder().decode(files['manifest.json']))).toEqual({
      'file-entries': { 'content.json': {}, 'metadata.json': {} },
    });
    expect(JSON.parse(new TextDecoder().decode(files['metadata.json']))).toEqual({
      creator: { name: 'Gmind', version: '1.0' },
    });
  });

  // —— v2.3（2026-11-15 导出保真第三波 Task 1）：sheet theme + topic.image + manifest 登记 extra ——
  // 依据：需求方验收反馈「图片没导出来」「连接线直愣愣的，和 XMind 软件创建的不一样」——
  // 根因=导出件缺 theme（线条质感来源）与图片写回；theme 值逐字借自本机真实 Zen 金样。

  it('v2.3 theme 写回：缺省 structureType 的 sheet 带 THEME_LOGIC，mainTopic/subTopic line-class 均 roundedElbow', () => {
    const files = unzipSync(
      buildXmind([
        { title: '一', root: { title: '根一', children: [] } },
        { title: '二', root: { title: '根二', children: [{ title: '子', children: [] }] } },
      ]),
    );
    const sheets = JSON.parse(new TextDecoder().decode(files['content.json'])) as Array<{
      theme?: {
        mainTopic?: { properties?: Record<string, unknown> };
        subTopic?: { properties?: Record<string, unknown> };
      };
    }>;
    expect(sheets).toHaveLength(2);
    for (const s of sheets) {
      // 「直愣愣」根因：缺 theme 时 XMind 落默认直线连接线；金样质感来源=roundedElbow
      // （两画布均缺省 structureType → v2.4 起落 THEME_LOGIC，期望不回归）
      expect(s.theme?.mainTopic?.properties?.['line-class']).toBe('org.xmind.branchConnection.roundedElbow');
      expect(s.theme?.subTopic?.properties?.['line-class']).toBe('org.xmind.branchConnection.roundedElbow');
    }
  });

  it('v2.4 theme 按结构选型：mindmap→THEME_MINDMAP（curve 三层、无 skeletonThemeId）；logic/org/缺省→THEME_LOGIC', () => {
    const files = unzipSync(
      buildXmind([
        { title: '', root: { title: '根', children: [] }, structureType: 'mindmap' },
        { title: '', root: { title: '根', children: [] }, structureType: 'logic' },
        { title: '', root: { title: '根', children: [] }, structureType: 'org' },
        { title: '', root: { title: '根', children: [] } }, // 缺省 structureType → THEME_LOGIC
      ]),
    );
    const sheets = JSON.parse(new TextDecoder().decode(files['content.json'])) as Array<{
      theme?: {
        centralTopic?: { properties?: Record<string, unknown> };
        mainTopic?: { properties?: Record<string, unknown> };
        subTopic?: { properties?: Record<string, unknown> };
      } & Record<string, unknown>;
    }>;
    expect(sheets).toHaveLength(4);
    // mindmap：曲线主题与真实金样逐字节一致（十键零自造；serialize 保序即键序/值序全等）
    expect(JSON.stringify(sheets[0].theme)).toBe(GOLDEN_MINDMAP_THEME_JSON);
    const mind = sheets[0].theme ?? {};
    expect(mind.mainTopic?.properties?.['line-class']).toBe('org.xmind.branchConnection.curve');
    expect(mind.centralTopic?.properties?.['line-class']).toBe('org.xmind.branchConnection.curve');
    expect(mind.subTopic?.properties?.['line-class']).toBe('org.xmind.branchConnection.curve');
    expect('skeletonThemeId' in mind).toBe(false); // 金样无此键，实现不得自造
    // logic/org/缺省：roundedElbow 逻辑主题不回归（org 无真实样本，暂随 logic——登记待校准）
    for (const s of [sheets[1], sheets[2], sheets[3]]) {
      expect(s.theme?.mainTopic?.properties?.['line-class']).toBe('org.xmind.branchConnection.roundedElbow');
      expect(s.theme?.subTopic?.properties?.['line-class']).toBe('org.xmind.branchConnection.roundedElbow');
    }
  });

  it('v2.3 图片写回：node.image 展开为 topic.image{src,width,height,align}，w/h/align 缺省不产键', () => {
    let n = 0;
    const seq = (p: string) => () => `${p}-${++n}`;
    const tree: XmindNode = {
      title: '根',
      children: [
        { title: '全键', image: { path: 'resources/p.png', w: 100, h: 50, align: 'top' }, children: [] },
        { title: '裸路径', image: { path: 'resources/q.png' }, children: [] }, // w/h/align 缺省不产键
        { title: '只有宽', image: { path: 'resources/r.png', w: 80 }, children: [] },
        { title: '无图', children: [] },
      ],
    };
    const files = unzipSync(buildXmind([{ title: '', root: tree }], undefined, seq('id')));
    const sheets = JSON.parse(new TextDecoder().decode(files['content.json'])) as Array<{
      rootTopic: Record<string, unknown> & { children: { attached: Array<Record<string, unknown>> } };
    }>;
    const attached = sheets[0].rootTopic.children.attached;
    expect('image' in sheets[0].rootTopic).toBe(false); // 无 image 不产键
    expect(attached[0].image).toEqual({ src: 'xap:resources/p.png', width: 100, height: 50, align: 'top' });
    expect(attached[1].image).toEqual({ src: 'xap:resources/q.png' }); // 缺省三键均不产
    expect(attached[2].image).toEqual({ src: 'xap:resources/r.png', width: 80 }); // h/align 缺省不产
    expect('image' in attached[3]).toBe(false);
  });

  it('v2.3 manifest 登记 extra：file-entries 含 extra 全部键（含子目录），核心条目恒在', () => {
    const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2]);
    const files = unzipSync(
      buildXmind(
        [{ title: '', root: { title: '根', children: [] } }],
        { 'resources/a.png': png, 'resources/sub/b.jpg': new Uint8Array([0xff, 0xd8, 0xff, 1]) },
      ),
    );
    const manifest = JSON.parse(new TextDecoder().decode(files['manifest.json'])) as {
      'file-entries': Record<string, unknown>;
    };
    expect(manifest['file-entries']['resources/a.png']).toEqual({});
    expect(manifest['file-entries']['resources/sub/b.jpg']).toEqual({});
    expect(manifest['file-entries']['content.json']).toEqual({}); // 核心条目恒登记
    expect(manifest['file-entries']['metadata.json']).toEqual({});
  });

  // —— 分侧忠实还原（2026-11-15 Task 2）：根 topic extensions right-number 写回 ——
  // 依据：XMind 把思维导图（map.unbalanced）左右分布存在根主题扩展 right-number
  // （attached 文档序前 N 支居右）；导出写回后 XMind 打开导出件分支左右与 Gmind 一致。
  // 金样形状逐字采信自本机真实 Zen JSON 根 topic：
  // `"extensions":[{"provider":"org.xmind.ui.map.unbalanced","content":[{"name":"right-number","content":"3"}]}]`。

  it('分侧写回：mindmap+rightCount=3 → 根 topic.extensions 金样逐字（条目字节层）；仅根携带', () => {
    let n = 0;
    const seq = (p: string) => () => `${p}-${++n}`;
    const files = unzipSync(
      buildXmind(
        [
          {
            title: '',
            root: { title: '根', children: [{ title: 'A', children: [] }] },
            structureType: 'mindmap',
            rightCount: 3,
          },
        ],
        undefined,
        seq('id'),
      ),
    );
    // 条目字节层逐字金样：extensions 紧随 structureClass（根专属键收尾，子级键序不动），
    // theme 段=THEME_MINDMAP 独立捕获串（v2.4 金样不回归）
    const contentStr = new TextDecoder().decode(files['content.json']);
    expect(contentStr).toBe(
      '[{"class":"sheet","id":"id-1","title":"Sheet 1","rootTopic":{"class":"topic","id":"id-2","title":"根","children":{"attached":[{"class":"topic","id":"id-3","title":"A"}]},"structureClass":"org.xmind.ui.map.unbalanced","extensions":[{"provider":"org.xmind.ui.map.unbalanced","content":[{"name":"right-number","content":"3"}]}]},"theme":' +
        GOLDEN_MINDMAP_THEME_JSON +
        '}]',
    );
    // 形状断言（解析后对象级）：金样逐字——content 是 [{name,content}] 数组、值为字符串数字
    const sheets = JSON.parse(contentStr) as Array<{
      rootTopic: Record<string, unknown> & { children: { attached: Record<string, unknown>[] } };
    }>;
    expect(sheets[0].rootTopic.extensions).toEqual([
      { provider: 'org.xmind.ui.map.unbalanced', content: [{ name: 'right-number', content: '3' }] },
    ]);
    expect('extensions' in sheets[0].rootTopic.children.attached[0]).toBe(false); // 仅根携带（解析侧子主题忽略）
  });

  it('分侧写回：rightCount=0 → content "0"（全左合法，不因 falsy 丢键）', () => {
    const sheets = JSON.parse(
      new TextDecoder().decode(
        unzipSync(
          buildXmind([
            { title: '', root: { title: '根', children: [] }, structureType: 'mindmap', rightCount: 0 },
          ]),
        )['content.json'],
      ),
    ) as Array<{ rootTopic: { extensions?: unknown } }>;
    expect(sheets[0].rootTopic.extensions).toEqual([
      { provider: 'org.xmind.ui.map.unbalanced', content: [{ name: 'right-number', content: '0' }] },
    ]);
  });

  it('分侧写回：缺省 rightCount / logic+rightCount=5 / 缺省结构+rightCount=5 → 均不产 extensions 键', () => {
    const rootOf = (): XmindNode => ({ title: '根', children: [] });
    const sheets = JSON.parse(
      new TextDecoder().decode(
        unzipSync(
          buildXmind([
            { title: '', root: rootOf(), structureType: 'mindmap' }, // mindmap 未计数：不产
            { title: '', root: rootOf(), structureType: 'logic', rightCount: 5 }, // 非 mindmap：写了 XMind 也不读，不产
            { title: '', root: rootOf(), rightCount: 5 }, // 缺省结构（落 logic 主题）：不产
          ]),
        )['content.json'],
      ),
    ) as Array<{ rootTopic: Record<string, unknown> }>;
    expect(sheets.map((s) => 'extensions' in s.rootTopic)).toEqual([false, false, false]);
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
