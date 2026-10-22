import { describe, expect, it } from 'vitest';
import { childrenIds, countAliveReachable, docFromState, getNode, listCanvases, ROOT_NODE_ID } from '@gmind/core';
import { buildXmind, type XmindNode } from '@gmind/xmind-io';
import { degradedSummary, importXmindFile } from './xmind-import';

/** 测试夹具：bytes → File（.xmind 以 application/octet-stream 传输，同导入入口）。 */
const xmindFile = (name: string, bytes: Uint8Array): File =>
  new File([bytes as BlobPart], name, { type: 'application/octet-stream' });

/** buildXmind 产物中 content.json 的文件名存于 zip 头（未压缩），原样替换后仍是合法 zip
 *  但不再含 content.* —— 构造 UNSUPPORTED_FORMAT 的最小夹具。 */
const zipWithoutContentEntry = (bytes: Uint8Array): Uint8Array =>
  new Uint8Array(Buffer.from(Buffer.from(bytes).toString('latin1').replaceAll('content.json', 'content.jsoN'), 'latin1'));

describe('importXmindFile（M4 Task 4，FR-IO-001）', () => {
  it('正常导入：先序组装 doc（层级/备注），title=根主题，state 可回读，degraded 透传', async () => {
    const tree: XmindNode = {
      title: '项目根主题',
      children: [
        { title: '分支A', note: '分支A的备注', children: [{ title: '孙1', children: [] }] },
        { title: '分支B', children: [] },
      ],
    };
    const result = await importXmindFile(
      xmindFile('项目.xmind', buildXmind([{ title: '', root: tree }])),
    );

    expect(result.title).toBe('项目根主题');
    expect(result.degraded).toEqual([]);

    const doc = docFromState(new Uint8Array(Buffer.from(result.state, 'base64')));
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
    );
    const doc = docFromState(new Uint8Array(Buffer.from(result.state, 'base64')));
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

  it('根主题缺标题：title 回落文件名去 .xmind 后缀', async () => {
    const result = await importXmindFile(xmindFile('我的脑图.xmind', buildXmind([{ title: '', root: { title: '', children: [] } }])));
    expect(result.title).toBe('我的脑图');
  });

  it('超 20MB：拒绝且不解析（NFR-USE-005 文案含原因+下一步「请压缩后重试」）', async () => {
    await expect(
      importXmindFile(xmindFile('大.xmind', new Uint8Array(21 * 1024 * 1024))),
    ).rejects.toThrow('文件大小超过 20MB 上限，请压缩后重试');
  });

  it('合法 zip 但无 content.*：归因含原因+下一步「请更换文件后重试」', async () => {
    const bytes = zipWithoutContentEntry(buildXmind([{ title: '', root: { title: 'x', children: [] } }]));
    await expect(importXmindFile(xmindFile('空容器.xmind', bytes))).rejects.toThrow(
      '无法识别的文件格式（仅支持 .xmind），请更换文件后重试',
    );
  });

  it('乱字节（非 zip）：归因含原因+下一步「请检查文件后重试」', async () => {
    const garbage = new Uint8Array(1024).fill(0x07);
    await expect(importXmindFile(xmindFile('坏.xmind', garbage))).rejects.toThrow('文件已损坏，无法解析，请检查文件后重试');
  });

  it('core 组装失败（子节点文本超长）→ 与解析失败同文案（含下一步），不裸抛 core 错误', async () => {
    // 解析层不校验长度（xmind-io 只搬运 title）：501 字的子标题在解析后由 core 组装
    // walk 的 addChild 以 TEXT_TOO_LONG 拒绝——修复前 GmindCoreError（「节点文本长度已达
    // 上限」）裸抛给用户，修复后与解析失败同文案（M4 挂账清偿：core 组装 walk 移入
    // try/catch，栈溢出 RangeError 同捕获）。
    const overlong = '长'.repeat(501);
    const tree: XmindNode = { title: '根', children: [{ title: overlong, children: [] }] };
    await expect(
      importXmindFile(xmindFile('超长.xmind', buildXmind([{ title: '', root: tree }]))),
    ).rejects.toThrow('文件已损坏，无法解析，请检查文件后重试');
  });
});

describe('degradedSummary（FR-IO-002 降级提示文案）', () => {
  it('全 kind：已降级处理 N 项（样式 x/媒体 y/结构 z）', () => {
    expect(
      degradedSummary([
        { kind: 'style', count: 2 },
        { kind: 'media', count: 1 },
        { kind: 'structure', count: 3 },
      ]),
    ).toBe('已降级处理 6 项（样式 2/媒体 1/结构 3）');
  });

  it('部分 kind：零计数 kind 不出现在括号内，前缀保持「已降级处理 N 项」', () => {
    expect(degradedSummary([{ kind: 'media', count: 4 }])).toBe('已降级处理 4 项（媒体 4）');
    expect(
      degradedSummary([
        { kind: 'style', count: 1 },
        { kind: 'structure', count: 2 },
      ]),
    ).toBe('已降级处理 3 项（样式 1/结构 2）');
  });

  it('空降级：仅前缀', () => {
    expect(degradedSummary([])).toBe('已降级处理 0 项');
  });
});
