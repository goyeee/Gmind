import { deflateRawSync } from 'node:zlib';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import * as core from '@gmind/core';
import {
  childrenIds,
  countAliveReachable,
  docFromState,
  getNode,
  getMeta,
  listCanvases,
  listSummaries,
  ROOT_NODE_ID,
} from '@gmind/core';
import { buildXmind, DEGRADED_LABELS, type DegradedItem, type DegradedKey, type XmindNode } from '@gmind/xmind-io';
import { readImageSize } from './imageUpload';
import { degradedSummary, importXmindFile, type ImportDeps } from './xmind-import';

// —— 测试基建 ————————————————————————————————————————————————

// gmind-core 写入口包装为透传 mock：原实现照跑（行为零变更），但可断言调用时序与
// 形参位（origin='system'、canvasId 归位）——2026-11-14 v2 顺手修的 spy 断言面。
vi.mock('@gmind/core', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@gmind/core')>();
  return {
    ...actual,
    addChild: vi.fn(actual.addChild),
    setText: vi.fn(actual.setText),
    setNote: vi.fn(actual.setNote),
    setDescription: vi.fn(actual.setDescription),
    setHref: vi.fn(actual.setHref),
    setImage: vi.fn(actual.setImage),
    setNodeSide: vi.fn(actual.setNodeSide),
    setIcon: vi.fn(actual.setIcon),
    setStyle: vi.fn(actual.setStyle),
    setSummary: vi.fn(actual.setSummary),
    setCollapsed: vi.fn(actual.setCollapsed),
    setDocMeta: vi.fn(actual.setDocMeta),
    addCanvas: vi.fn(actual.addCanvas),
    renameCanvas: vi.fn(actual.renameCanvas),
  };
});

// readImageSize 依赖浏览器 Image/createObjectURL（node 单测环境不可用）→ 固定
// 自然尺寸 400×696；clampImageSize 为纯函数，保持原实现（复用不复制）。
vi.mock('./imageUpload', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./imageUpload')>();
  return { ...actual, readImageSize: vi.fn(async () => ({ w: 400, h: 696, url: 'blob:mock' })) };
});

beforeEach(() => {
  vi.clearAllMocks();
});

/** 测试夹具：bytes → File（.xmind 以 application/octet-stream 传输，同导入入口）。 */
const xmindFile = (name: string, bytes: Uint8Array): File =>
  new File([bytes as BlobPart], name, { type: 'application/octet-stream' });

/** buildXmind 产物中 content.json 的文件名存于 zip 头（未压缩），原样替换后仍是合法 zip
 *  但不再含 content.* —— 构造 UNSUPPORTED_FORMAT 的最小夹具。 */
const zipWithoutContentEntry = (bytes: Uint8Array): Uint8Array =>
  new Uint8Array(Buffer.from(Buffer.from(bytes).toString('latin1').replaceAll('content.json', 'content.jsoN'), 'latin1'));

/** 解码导入产物 docState → Y.Doc（回读断言面）。 */
const docOf = (stateB64: string) => docFromState(new Uint8Array(Buffer.from(stateB64, 'base64')));

/** 两段式 deps 的可控 mock：文件 id 恒 file-1、图片键恒 img-1。 */
function makeDeps(over: Partial<ImportDeps> = {}): ImportDeps {
  return {
    createFile: vi.fn(async () => ({ id: 'file-1' })),
    uploadImage: vi.fn(async () => ({ key: 'img-1' })),
    putDocState: vi.fn(async () => {}),
    ...over,
  };
}

// —— 手工 zip 装配（web 测试树无 fflate 依赖；buildXmind 的 extra 开口无法携带
//    topic 级 image 引用，故最小 local header + central directory + EOCD 手写）——

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = (c & 1) !== 0 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(data: Uint8Array): number {
  let c = 0xffffffff;
  for (let i = 0; i < data.length; i += 1) c = CRC_TABLE[(c ^ data[i]!) & 0xff]! ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function manualZip(files: Record<string, Uint8Array>): Uint8Array {
  const enc = new TextEncoder();
  const u16 = (v: number): Uint8Array => {
    const b = new Uint8Array(2);
    new DataView(b.buffer).setUint16(0, v, true);
    return b;
  };
  const u32 = (v: number): Uint8Array => {
    const b = new Uint8Array(4);
    new DataView(b.buffer).setUint32(0, v, true);
    return b;
  };
  const cat = (parts: Uint8Array[]): Uint8Array => {
    const out = new Uint8Array(parts.reduce((s, p) => s + p.length, 0));
    let off = 0;
    for (const p of parts) {
      out.set(p, off);
      off += p.length;
    }
    return out;
  };
  const locals: Uint8Array[] = [];
  const centrals: Uint8Array[] = [];
  let offset = 0;
  for (const [name, raw] of Object.entries(files)) {
    const nameB = enc.encode(name);
    const data = deflateRawSync(raw);
    const crc = crc32(raw);
    // local header 共享段：version/flag/method/time/date/crc/尺寸/名长（EOCD 前各 10 字节）
    const shared = cat([
      u16(20), u16(0), u16(8), u16(0), u16(0), u32(crc), u32(data.length), u32(raw.length), u16(nameB.length), u16(0),
    ]);
    locals.push(cat([u32(0x04034b50), shared, nameB, data]));
    centrals.push(cat([
      u32(0x02014b50), u16(20), shared,
      u16(0), u16(0), u16(0), u32(0), u32(offset), // comment len、disk、int attrs、ext attrs、local offset
      nameB,
    ]));
    offset += locals[locals.length - 1]!.length;
  }
  const cd = cat(centrals);
  return cat([
    ...locals,
    cd,
    u32(0x06054b50), u16(0), u16(0), u16(centrals.length), u16(centrals.length), u32(cd.length), u32(offset), u16(0),
  ]);
}

const jsonEntry = (v: unknown): Uint8Array => new TextEncoder().encode(JSON.stringify(v));

/** PNG 魔数头（嗅探白名单内即可，parse 后 readImageSize 已 mock，无需真图）。 */
const pngMagic = (extra = 8): Uint8Array =>
  new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, ...new Array<number>(extra).fill(0)]);

// —— importXmindFile ————————————————————————————————————————

describe('importXmindFile（FR-IO-001；2026-11-14 v2 两段式）', () => {
  it('正常导入：先序组装 doc（层级/备注），title=原文件名去后缀（2026-11-14 需求方拍板），state 可回读，degraded 透传', async () => {
    const tree: XmindNode = {
      title: '项目根主题',
      children: [
        { title: '分支A', note: '分支A的备注', children: [{ title: '孙1', children: [] }] },
        { title: '分支B', children: [] },
      ],
    };
    const result = await importXmindFile(
      xmindFile('项目.xmind', buildXmind([{ title: '', root: tree }])),
      makeDeps(),
    );

    expect(result.title).toBe('项目'); // 原文件名优先（2026-11-14 需求方拍板），根主题只作回落
    expect(result.degraded).toEqual([]);

    const doc = docOf(result.state);
    expect(countAliveReachable(doc)).toBe(3); // 可达活跃口径（root 不计）：分支A/孙1/分支B → 3
    expect(getNode(doc, ROOT_NODE_ID)?.text).toBe('项目根主题');
    const kids = childrenIds(doc, ROOT_NODE_ID);
    expect(kids).toHaveLength(2);
    expect(getNode(doc, kids[0] as string)?.text).toBe('分支A');
    expect(getNode(doc, kids[0] as string)?.note).toBe('分支A的备注');
    expect(getNode(doc, childrenIds(doc, kids[0] as string)[0] as string)?.text).toBe('孙1');
    expect(getNode(doc, kids[1] as string)?.text).toBe('分支B');
  });

  it('多画布（裁定 8）：多 Sheet .xmind 导入 → 每张 Sheet 一张画布（首 Sheet 进首画布，其余 addCanvas）', async () => {
    const result = await importXmindFile(
      xmindFile(
        '多画布.xmind',
        buildXmind([
          { title: 'Sheet 1', root: { title: '首画布根', children: [{ title: 'A', children: [] }] } },
          { title: '规划', root: { title: '规划根', children: [{ title: 'B', children: [] }] } },
          { title: '', root: { title: '第三', children: [] } },
        ]),
      ),
      makeDeps(),
    );
    const doc = docOf(result.state);
    const canvases = listCanvases(doc);
    expect(canvases.map((c) => c.name)).toEqual(['Sheet 1', '规划', 'Sheet 3']); // 首 Sheet 名落到首画布；buildXmind 对空标题回落 Sheet N
    expect(getNode(doc, ROOT_NODE_ID, canvases[0].id)?.text).toBe('首画布根'); // 首 Sheet 进首画布（root 恒 'root'）
    expect(getNode(doc, childrenIds(doc, ROOT_NODE_ID, canvases[0].id)[0] as string, canvases[0].id)?.text).toBe('A');
    const secondRoot = canvases[1].rootId;
    expect(getNode(doc, secondRoot, canvases[1].id)?.text).toBe('规划根');
    expect(getNode(doc, childrenIds(doc, secondRoot, canvases[1].id)[0] as string, canvases[1].id)?.text).toBe('B');
    const thirdRoot = canvases[2].rootId;
    expect(getNode(doc, thirdRoot, canvases[2].id)?.text).toBe('第三');
  });

  it('文件名仅剩后缀：title 回落根主题（原文件名优先的回落腿）', async () => {
    const result = await importXmindFile(
      xmindFile('.xmind', buildXmind([{ title: '', root: { title: '备选根标题', children: [] } }])),
      makeDeps(),
    );
    expect(result.title).toBe('备选根标题');
  });

  it('左右均衡定侧（2026-11-14 需求方不满右配额 3）：mindmap 画布按子树规模贪心均衡，同侧保持原有顺序', async () => {
    // 权重：A=3（A+A1+A2）、B=C=D=1、E=2。贪心（两侧并列取右）：A→右(3,0)、B→左(3,1)、
    // C→左(3,2)、D→左(3,3)、E→并列取右(5,3) → 右侧 A/E（权重 5）、左侧 B/C/D（权重 3），
    // 5 个分支 3/2 分侧不再受右配额 3 限制。
    const tree: XmindNode = {
      title: '根',
      children: [
        { title: 'A', children: [{ title: 'A1', children: [] }, { title: 'A2', children: [] }] },
        { title: 'B', children: [] },
        { title: 'C', children: [] },
        { title: 'D', children: [] },
        { title: 'E', children: [{ title: 'E1', children: [] }] },
      ],
    };
    const result = await importXmindFile(
      xmindFile('均衡.xmind', buildXmind([{ title: '', root: tree }])),
      makeDeps(),
    );
    const doc = docOf(result.state);
    const kids = childrenIds(doc, ROOT_NODE_ID);
    expect(kids).toHaveLength(5);
    expect(kids.map((id) => getNode(doc, id)?.side)).toEqual(['right', 'left', 'left', 'left', 'right']);
    // 同侧保持原有先后顺序
    expect(
      kids.filter((id) => getNode(doc, id)?.side === 'right').map((id) => getNode(doc, id)?.text),
    ).toEqual(['A', 'E']);
  });

  it('logic 画布不做均衡定侧（侧别无语义，保持 addChild 右配额既有值）', async () => {
    const bytes = manualZip({
      'content.json': jsonEntry([
        {
          class: 'sheet',
          title: 'S',
          rootTopic: {
            class: 'topic',
            title: '中心',
            structureClass: 'org.xmind.ui.logic.right',
            children: {
              attached: [
                { class: 'topic', title: '一', children: [] },
                { class: 'topic', title: '二', children: [] },
                { class: 'topic', title: '三', children: [] },
                { class: 'topic', title: '四', children: [] },
              ],
            },
          },
        },
      ]),
    });
    const result = await importXmindFile(xmindFile('逻辑.xmind', bytes), makeDeps());
    const doc = docOf(result.state);
    expect(getMeta(doc).structureType).toBe('logic');
    const kids = childrenIds(doc, ROOT_NODE_ID);
    // addChild 右配额 3：前 3 右、第 4 左——导入不覆盖 logic 画布的侧别
    expect(kids.map((id) => getNode(doc, id)?.side)).toEqual(['right', 'right', 'right', 'left']);
  });

  it('超 20MB：拒绝且不解析（NFR-USE-005 文案含原因+下一步「请压缩后重试」）', async () => {
    await expect(
      importXmindFile(xmindFile('大.xmind', new Uint8Array(21 * 1024 * 1024)), makeDeps()),
    ).rejects.toThrow('文件大小超过 20MB 上限，请压缩后重试');
  });

  it('合法 zip 但无 content.*：归因含原因+下一步「请更换文件后重试」', async () => {
    const bytes = zipWithoutContentEntry(buildXmind([{ title: '', root: { title: 'x', children: [] } }]));
    await expect(importXmindFile(xmindFile('空容器.xmind', bytes), makeDeps())).rejects.toThrow(
      '无法识别的文件格式（仅支持 .xmind），请更换文件后重试',
    );
  });

  it('乱字节（非 zip）：归因含原因+下一步「请检查文件后重试」', async () => {
    const garbage = new Uint8Array(1024).fill(0x07);
    await expect(importXmindFile(xmindFile('坏.xmind', garbage), makeDeps())).rejects.toThrow('文件已损坏，无法解析，请检查文件后重试');
  });

  it('core 组装失败（子节点文本超长）→ 与解析失败同文案（含下一步），不裸抛 core 错误', async () => {
    // 解析层不校验长度（xmind-io 只搬运 title）：501 字的子标题在 core 组装 walk 的
    // addChild 以 TEXT_TOO_LONG 拒绝——GmindCoreError 不裸抛给用户（栈溢出 RangeError 同捕获）。
    const overlong = '长'.repeat(501);
    const tree: XmindNode = { title: '根', children: [{ title: overlong, children: [] }] };
    await expect(
      importXmindFile(xmindFile('超长.xmind', buildXmind([{ title: '', root: tree }])), makeDeps()),
    ).rejects.toThrow('文件已损坏，无法解析，请检查文件后重试');
  });

  it('无图快路径：resources 空 → createFile/uploadImage/putDocState 均不被调，fileId=null', async () => {
    const deps = makeDeps();
    const result = await importXmindFile(
      xmindFile('快.xmind', buildXmind([{ title: '', root: { title: '根', children: [] } }])),
      deps,
    );
    expect(result.fileId).toBeNull();
    expect(deps.createFile).not.toHaveBeenCalled();
    expect(deps.uploadImage).not.toHaveBeenCalled();
    expect(deps.putDocState).not.toHaveBeenCalled();
    expect(vi.mocked(readImageSize)).not.toHaveBeenCalled();
  });

  it('有图两段式：createFile→uploadImage→setImage→putDocState 时序；setImage 参数 {key,w,h,placement:align}', async () => {
    // readImageSize 默认 mock 自然尺寸 400×696 → clampImageSize（200px 等比钳制）→ 115×200
    const deps = makeDeps();
    const bytes = manualZip({
      'content.json': jsonEntry([
        {
          class: 'sheet',
          title: 'S',
          rootTopic: {
            class: 'topic',
            title: '根',
            children: {
              attached: [
                {
                  class: 'topic',
                  title: '带图',
                  image: { src: 'xap:resources/pic.png', width: 400, height: 696, align: 'right' },
                },
              ],
            },
          },
        },
      ]),
      'resources/pic.png': pngMagic(),
    });
    const result = await importXmindFile(xmindFile('图.xmind', bytes), deps);

    expect(result.fileId).toBe('file-1');
    expect(deps.createFile).toHaveBeenCalledTimes(1);
    expect(deps.uploadImage).toHaveBeenCalledTimes(1);
    expect(deps.putDocState).toHaveBeenCalledTimes(1);
    // 阶段一 state0（建文件时）无图；最终 state（putDocState 收到的同一份）有图
    const state0 = docOf((deps.createFile as ReturnType<typeof vi.fn>).mock.calls[0]![1] as string);
    const finalDoc = docOf(result.state);
    const nodeId = childrenIds(finalDoc, ROOT_NODE_ID)[0] as string;
    expect(getNode(state0, nodeId)?.image).toBeNull();
    // setImage 落盘参数：key 来自 uploadImage 返回、尺寸来自 200px 钳制、placement=align
    expect(getNode(finalDoc, nodeId)?.image).toEqual({ key: 'img-1', w: 115, h: 200, placement: 'right' });
    expect(deps.putDocState).toHaveBeenCalledWith('file-1', result.state);
    // 时序：createFile < uploadImage < setImage < putDocState（invocationCallOrder 全局序）
    const order = [
      vi.mocked(deps.createFile).mock.invocationCallOrder[0]!,
      vi.mocked(deps.uploadImage).mock.invocationCallOrder[0]!,
      vi.mocked(core.setImage).mock.invocationCallOrder[0]!,
      vi.mocked(deps.putDocState).mock.invocationCallOrder[0]!,
    ];
    expect(order[0]).toBeLessThan(order[1]!);
    expect(order[1]).toBeLessThan(order[2]!);
    expect(order[2]).toBeLessThan(order[3]!);
    expect(result.degraded).toEqual([]);
  });

  it('uploadImage 拒绝：计图片降级且导入继续，返回可用 docState，putDocState 照常回写', async () => {
    const deps = makeDeps({
      uploadImage: vi.fn(async () => {
        throw new Error('上传失败（500）');
      }),
    });
    const bytes = manualZip({
      'content.json': jsonEntry([
        {
          class: 'sheet',
          title: '',
          rootTopic: {
            class: 'topic',
            title: '根',
            children: { attached: [{ class: 'topic', title: '带图', image: { src: 'xap:resources/pic.png' } }] },
          },
        },
      ]),
      'resources/pic.png': pngMagic(),
    });
    const result = await importXmindFile(xmindFile('图.xmind', bytes), deps);
    expect(result.fileId).toBe('file-1');
    expect(result.degraded).toEqual([{ key: 'image', count: 1 }]);
    const doc = docOf(result.state);
    expect(getNode(doc, ROOT_NODE_ID)?.text).toBe('根'); // doc 可回读（导入未中断）
    expect(deps.putDocState).toHaveBeenCalledWith('file-1', result.state);
  });

  it('putDocState 拒绝：整体 reject、文件已建、该图不进降级计数（终审 Important#2：文件停留无图初态，行为挂账 m4-acceptance 补记）', async () => {
    const deps = makeDeps({
      putDocState: vi.fn(async () => {
        throw new Error('回写失败（500）');
      }),
    });
    const bytes = manualZip({
      'content.json': jsonEntry([
        {
          class: 'sheet',
          title: '',
          rootTopic: {
            class: 'topic',
            title: '根',
            children: { attached: [{ class: 'topic', title: '带图', image: { src: 'xap:resources/pic.png' } }] },
          },
        },
      ]),
      'resources/pic.png': pngMagic(),
    });
    await expect(importXmindFile(xmindFile('图.xmind', bytes), deps)).rejects.toThrow('回写失败（500）');
    expect(deps.createFile).toHaveBeenCalledTimes(1); // 文件已建（停留无图初态，是否回收待需求方裁定）
    expect(deps.uploadImage).toHaveBeenCalledTimes(1); // 图上传成功（未走失败路径 ⟹ degraded 不含该图）
    expect(deps.putDocState).toHaveBeenCalledTimes(1); // 回写被拒 = 整体 reject 唯一来源
  });

  it('单图超 10MB：预检拦截，不发起 uploadImage，计图片降级，其余照常', async () => {
    const deps = makeDeps();
    // PNG 魔数头（入 resources 表）+ 零填充到 10MB+1（预检按字节计）
    const big = new Uint8Array(10 * 1024 * 1024 + 1);
    big.set(pngMagic(0));
    const bytes = manualZip({
      'content.json': jsonEntry([
        {
          class: 'sheet',
          title: '',
          rootTopic: {
            class: 'topic',
            title: '根',
            children: {
              attached: [
                { class: 'topic', title: '带图', image: { src: 'xap:resources/big.png', align: 'bottom' } },
                { class: 'topic', title: '普通', children: [] },
              ],
            },
          },
        },
      ]),
      'resources/big.png': big,
    });
    const result = await importXmindFile(xmindFile('大图.xmind', bytes), deps);
    expect(deps.uploadImage).not.toHaveBeenCalled();
    expect(result.degraded).toEqual([{ key: 'image', count: 1 }]);
    expect(result.fileId).toBe('file-1'); // 两段式文件已建、docState 已回写
    expect(deps.putDocState).toHaveBeenCalledTimes(1);
    const doc = docOf(result.state);
    expect(getNode(doc, childrenIds(doc, ROOT_NODE_ID)[1] as string)?.text).toBe('普通'); // 兄弟节点不受影响
  });

  it("同一资源被多节点引用：逐节点上传（uploadImage ×2）、placement:align??'bottom' 缺省兜底，各节点各自落 key", async () => {
    const deps = makeDeps();
    const bytes = manualZip({
      'content.json': jsonEntry([
        {
          class: 'sheet',
          title: '',
          rootTopic: {
            class: 'topic',
            title: '根',
            children: {
              attached: [
                // 两图均无 align（解析器缺省恒 undefined）→ setImage 落 placement 缺省 'bottom'（承重兜底分支）
                { class: 'topic', title: '图1', image: { src: 'xap:resources/pic.png' } },
                { class: 'topic', title: '图2', image: { src: 'xap:resources/pic.png' } },
              ],
            },
          },
        },
      ]),
      'resources/pic.png': pngMagic(),
    });
    const result = await importXmindFile(xmindFile('同图.xmind', bytes), deps);
    expect(deps.uploadImage).toHaveBeenCalledTimes(2);
    const doc = docOf(result.state);
    const kids = childrenIds(doc, ROOT_NODE_ID);
    expect(getNode(doc, kids[0] as string)?.image?.key).toBe('img-1');
    expect(getNode(doc, kids[1] as string)?.image?.key).toBe('img-1');
    // 缺省兜底分支：无 align → placement 'bottom'（400×696 经 200px 钳制 → 115×200）
    expect(getNode(doc, kids[0] as string)?.image).toEqual({ key: 'img-1', w: 115, h: 200, placement: 'bottom' });
    expect(getNode(doc, kids[1] as string)?.image).toEqual({ key: 'img-1', w: 115, h: 200, placement: 'bottom' });
    expect(result.degraded).toEqual([]);
  });

  it('混合态：部分图成功部分失败——成功者落盘、失败者计图片（上传拒绝+10MB 预检两种）、导入不中断', async () => {
    // ok.png 正常上传；fail.png 上传拒绝；big.png 超 10MB 预检拦截——三种图同单导入
    const deps = makeDeps({
      uploadImage: vi.fn(async (_fileId: string, file: File) => {
        if (file.name === 'fail.png') throw new Error('上传失败（500）');
        return { key: 'img-ok' };
      }),
    });
    const big = new Uint8Array(10 * 1024 * 1024 + 1);
    big.set(pngMagic(0));
    const bytes = manualZip({
      'content.json': jsonEntry([
        {
          class: 'sheet',
          title: '',
          rootTopic: {
            class: 'topic',
            title: '根',
            children: {
              attached: [
                { class: 'topic', title: '成功图', image: { src: 'xap:resources/ok.png', align: 'left' } },
                { class: 'topic', title: '拒绝图', image: { src: 'xap:resources/fail.png' } },
                { class: 'topic', title: '超限图', image: { src: 'xap:resources/big.png' } },
                { class: 'topic', title: '普通', children: [] },
              ],
            },
          },
        },
      ]),
      'resources/ok.png': pngMagic(),
      'resources/fail.png': pngMagic(),
      'resources/big.png': big,
    });
    const result = await importXmindFile(xmindFile('混合.xmind', bytes), deps);
    expect(result.fileId).toBe('file-1'); // 导入不中断，两段式完成
    expect(deps.uploadImage).toHaveBeenCalledTimes(2); // 超限图不发起（预检），拒绝图发起后被拒
    const doc = docOf(result.state);
    const kids = childrenIds(doc, ROOT_NODE_ID);
    expect(getNode(doc, kids[0] as string)?.image).toEqual({ key: 'img-ok', w: 115, h: 200, placement: 'left' });
    expect(getNode(doc, kids[1] as string)?.image).toBeNull();
    expect(getNode(doc, kids[2] as string)?.image).toBeNull();
    expect(getNode(doc, kids[3] as string)?.text).toBe('普通'); // 兄弟节点不受影响
    expect(result.degraded).toEqual([{ key: 'image', count: 2 }]); // 拒绝 + 超限，两种失败各计一枚
    expect(deps.putDocState).toHaveBeenCalledWith('file-1', result.state); // 终态仍回写
  });

  it('落盘 v2：description/href/style 四键/folded/markers（setIcon 进度联动）真实生效', async () => {
    const bytes = manualZip({
      'content.json': jsonEntry([
        {
          class: 'sheet',
          title: '',
          rootTopic: {
            class: 'topic',
            title: '根',
            description: '一句话描述',
            href: 'https://example.com/doc',
            branch: 'folded',
            markers: [{ markerId: 'task-done' }],
            style: { properties: { 'fo:color': '#ff0000', 'svg:fill': '#ffffff', 'svg:stroke-color': '#000000', 'fo:font-size': '14px' } },
            children: { attached: [{ class: 'topic', title: '普通', children: [] }] },
          },
        },
      ]),
    });
    const result = await importXmindFile(xmindFile('落盘.xmind', bytes), makeDeps());
    expect(result.fileId).toBeNull(); // 无图 → 快路径（落盘接线与两段式无关）
    const doc = docOf(result.state);
    const root = getNode(doc, ROOT_NODE_ID);
    expect(root?.description).toBe('一句话描述');
    expect(root?.href).toBe('https://example.com/doc');
    expect(root?.collapsed).toBe(true);
    expect(root?.icons.progress).toEqual(['done']);
    expect(root?.task.progress).toBe(100); // setIcon 进度组反向联动
    expect(root?.style).toMatchObject({ color: '#ff0000', fill: '#ffffff', border: '#000000', fontSize: '14' });
  });

  it('概要：setSummary 落盘（kids.slice(start,end+1)，label 经 children.summary 映射）', async () => {
    const bytes = manualZip({
      'content.json': jsonEntry([
        {
          class: 'sheet',
          title: '',
          rootTopic: {
            class: 'topic',
            title: '根',
            summaries: [{ id: 's1', topicId: 'lbl1', range: '(0,1)' }],
            children: {
              summary: [{ id: 'lbl1', title: '概要标签' }],
              attached: [
                { class: 'topic', title: 'A', children: [] },
                { class: 'topic', title: 'B', children: [] },
                { class: 'topic', title: 'C', children: [] },
              ],
            },
          },
        },
      ]),
    });
    const result = await importXmindFile(xmindFile('概要.xmind', bytes), makeDeps());
    expect(result.degraded).toEqual([]);
    const doc = docOf(result.state);
    const kids = childrenIds(doc, ROOT_NODE_ID);
    const summaries = listSummaries(doc);
    expect(summaries).toHaveLength(1);
    expect(summaries[0]?.label).toBe('概要标签');
    expect(summaries[0]?.nodeIds).toEqual(kids.slice(0, 2));
  });

  it('概要 label 超长：setSummary 抛 SUMMARY_INVALID → 计概要降级，doc 无残缺条目', async () => {
    const bytes = manualZip({
      'content.json': jsonEntry([
        {
          class: 'sheet',
          title: '',
          rootTopic: {
            class: 'topic',
            title: '根',
            summaries: [{ id: 's1', topicId: 'lbl1', range: '(0,0)' }],
            children: {
              summary: [{ id: 'lbl1', title: '长'.repeat(501) }],
              attached: [{ class: 'topic', title: 'A', children: [] }],
            },
          },
        },
      ]),
    });
    const result = await importXmindFile(xmindFile('超长概要.xmind', bytes), makeDeps());
    expect(result.degraded).toEqual([{ key: 'summary', count: 1 }]);
    expect(listSummaries(docOf(result.state))).toEqual([]); // 校验先于事务：零残缺
  });

  it('structureType：首画布 setDocMeta（logic）、次画布 addCanvas（org）、未指定缺省 mindmap', async () => {
    const bytes = manualZip({
      'content.json': jsonEntry([
        {
          class: 'sheet',
          title: '首',
          rootTopic: { class: 'topic', title: '根1', structureClass: 'org.xmind.ui.logic.right', children: { attached: [{ class: 'topic', title: 'a', children: [] }] } },
        },
        {
          class: 'sheet',
          title: '第二',
          rootTopic: { class: 'topic', title: '根2', structureClass: 'org.xmind.ui.org-chart.vertical', children: { attached: [{ class: 'topic', title: 'b', children: [] }] } },
        },
        { class: 'sheet', title: '第三', rootTopic: { class: 'topic', title: '根3', children: [] } },
      ]),
    });
    const result = await importXmindFile(xmindFile('结构.xmind', bytes), makeDeps());
    const doc = docOf(result.state);
    const canvases = listCanvases(doc);
    expect(getMeta(doc, canvases[0].id).structureType).toBe('logic'); // 首画布走 setDocMeta
    expect(getMeta(doc, canvases[1].id).structureType).toBe('org'); // 次画布 addCanvas 携带
    expect(getMeta(doc, canvases[2].id).structureType).toBe('mindmap'); // 未指定缺省
    expect(result.degraded).toEqual([]);
    // 导入完成回拨首画布（getMeta 缺省画布=activeCanvasId → 首画布）
    expect(getMeta(doc).structureType).toBe('logic');
    // setDocMeta 只受理首画布结构（画布缺省解析=activeCanvasId，此时仍指首画布）；addCanvas 结构经 opts 携带。
    // 首个调用是文件名覆写（2026-11-14 需求方拍板：meta.title=原文件名，中心主题保持根原文）
    expect(vi.mocked(core.setDocMeta).mock.calls).toEqual([
      [expect.anything(), { title: '结构' }, 'system'],
      [expect.anything(), { structureType: 'logic' }, 'system'],
    ]);
    expect(vi.mocked(core.addCanvas).mock.calls[0]![1]).toMatchObject({ name: '第二', structureType: 'org' });
  });

  it('origin 修正：全部写入口 origin=system；canvasId 归位（addChild 第 4 参 origin、第 5 参 canvasId）', async () => {
    const bytes = manualZip({
      'content.json': jsonEntry([
        {
          class: 'sheet',
          title: '首',
          rootTopic: {
            class: 'topic',
            title: '根1',
            structureClass: 'org.xmind.ui.logic.right',
            notes: { plain: { content: '根备注' } },
            description: '根描述',
            href: 'https://example.com/1',
            branch: 'folded',
            markers: [{ markerId: 'task-done' }],
            summaries: [{ id: 's1', topicId: 'l1', range: '(0,0)' }],
            style: { properties: { 'fo:color': '#123456' } },
            children: {
              summary: [{ id: 'l1', title: '概要' }],
              attached: [{ class: 'topic', title: 'A', notes: { plain: { content: 'A注' } }, image: { src: 'xap:resources/pic.png' } }],
            },
          },
        },
        {
          class: 'sheet',
          title: '规划',
          rootTopic: {
            class: 'topic',
            title: '根2',
            children: { attached: [{ class: 'topic', title: 'B', children: [] }] },
          },
        },
      ]),
      'resources/pic.png': pngMagic(),
    });
    const result = await importXmindFile(xmindFile('origin.xmind', bytes), makeDeps());
    const canvases = listCanvases(docOf(result.state));
    const secondCanvasId = canvases[1].id;

    // 各写入口 origin 形参位逐一断言（spy 形参位断言）
    const opCalls: Array<[string, unknown[][]]> = [
      ['addChild', vi.mocked(core.addChild).mock.calls],
      ['setText', vi.mocked(core.setText).mock.calls],
      ['setNote', vi.mocked(core.setNote).mock.calls],
      ['setDescription', vi.mocked(core.setDescription).mock.calls],
      ['setHref', vi.mocked(core.setHref).mock.calls],
      ['setImage', vi.mocked(core.setImage).mock.calls],
      ['setIcon', vi.mocked(core.setIcon).mock.calls],
      ['setStyle', vi.mocked(core.setStyle).mock.calls],
      ['setSummary', vi.mocked(core.setSummary).mock.calls],
      ['setCollapsed', vi.mocked(core.setCollapsed).mock.calls],
      ['setDocMeta', vi.mocked(core.setDocMeta).mock.calls],
      ['addCanvas', vi.mocked(core.addCanvas).mock.calls],
      ['renameCanvas', vi.mocked(core.renameCanvas).mock.calls],
    ];
    const ORIGIN_IDX: Record<string, number> = {
      addChild: 3, setText: 3, setNote: 3, setDescription: 3, setHref: 3, setImage: 3,
      setIcon: 4, setStyle: 3, setSummary: 3, setCollapsed: 3, setDocMeta: 2, addCanvas: 2, renameCanvas: 3,
    };
    for (const [name, calls] of opCalls) {
      expect(calls.length, `${name} 应至少被调用一次`).toBeGreaterThan(0);
      for (const call of calls) {
        expect(call[ORIGIN_IDX[name]!], `${name} origin 位应为 'system'`).toBe('system');
      }
    }
    // canvasId 归位：首画布节点 canvasId=undefined；次画布 addChild 第 5 参 = 该画布 id
    const secondCanvasAdds = vi.mocked(core.addChild).mock.calls.filter((c) => c[4] === secondCanvasId);
    expect(secondCanvasAdds.length).toBeGreaterThan(0);
    for (const call of secondCanvasAdds) expect(call[4]).toBe(secondCanvasId);
    // setText（次画布根标题）同样归位
    expect(vi.mocked(core.setText).mock.calls.some((c) => c[4] === secondCanvasId)).toBe(true);
    // setImage（首画布子节点 A）canvasId=undefined
    expect(vi.mocked(core.setImage).mock.calls[0]![4]).toBeUndefined();
  });
});

// —— degradedSummary（FR-IO-002 v2 逐项点名文案） ——————————————————

describe('degradedSummary（2026-11-14 v2）', () => {
  it('全零/空 → 已完整导入', () => {
    expect(degradedSummary([])).toBe('已完整导入');
    expect(degradedSummary([
      { key: 'icon', count: 0 },
      { key: 'image', count: 0 },
    ])).toBe('已完整导入');
  });

  it('单项：未导入：图标 N', () => {
    expect(degradedSummary([{ key: 'icon', count: 2 }])).toBe('未导入：图标 2');
    expect(degradedSummary([{ key: 'image', count: 1 }])).toBe('未导入：图片 1');
  });

  it('多项目录序：乱序输入按 DEGRADED_LABELS 目录序输出、「、」连接', () => {
    const unordered: DegradedItem[] = [
      { key: 'boundary', count: 1 },
      { key: 'icon', count: 2 },
      { key: 'summary', count: 3 },
    ];
    const order = Object.keys(DEGRADED_LABELS);
    expect(order.indexOf('icon')).toBeLessThan(order.indexOf('boundary'));
    expect(order.indexOf('boundary')).toBeLessThan(order.indexOf('summary'));
    expect(degradedSummary(unordered)).toBe('未导入：图标 2、外框 1、概要 3');
  });

  it('未知 key 容错：不崩、未知项不出现在文案', () => {
    expect(
      degradedSummary([
        { key: 'icon', count: 1 },
        { key: 'mystery' as DegradedKey, count: 5 },
      ]),
    ).toBe('未导入：图标 1');
    expect(degradedSummary([{ key: 'mystery' as DegradedKey, count: 5 }])).toBe('已完整导入');
  });
});
