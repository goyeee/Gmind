import { afterEach, describe, expect, it, vi } from 'vitest';
import { MAX_TEXT_LENGTH } from '@gmind/core';
import {
  copyNodes,
  cutNodes,
  pasteNodes,
  pasteText,
  writeToSystemClipboard,
  readFromSystemClipboard,
  readInternalFallback,
  type ClipboardPayload,
  type IDocHandle,
} from './clipboard';

/**
 * 剪贴板层测试桩（M1b Task 10 TDD）：
 * StubDoc 用普通对象树同时实现 DocReader（getMeta/getNode/childrenIds）与
 * IDocHandle（addChild/setText/setNote/setHref/setImage/setIcon/setStyle），
 * 快照形状镜像 core NodeSnapshot（富字段），写方法全部记录调用以便断言参数与顺序。
 */

const INTERNAL_MIME = 'web application/vnd.gmind+json';

interface StubNode {
  id: string;
  text: string;
  parentId: string;
  children: string[];
  note: string;
  href: string;
  image: { key: string; w: number; h: number } | null;
  icons: Record<string, string>;
  style: Record<string, string>;
  collapsed: boolean;
  deleted: boolean;
}

type Call = { op: string; args: unknown[] };

class StubDoc implements IDocHandle {
  nodes = new Map<string, StubNode>();
  calls: Call[] = [];
  private seq = 0;

  addNode(init: Partial<StubNode> & { id: string }): StubNode {
    const node: StubNode = {
      text: '',
      parentId: 'root',
      children: [],
      note: '',
      href: '',
      image: null,
      icons: {},
      style: {},
      collapsed: false,
      deleted: false,
      ...init,
    };
    this.nodes.set(node.id, node);
    if (init.parentId !== undefined) this.nodes.get(init.parentId)?.children.push(node.id);
    return node;
  }

  /** StubNode 生成的新节点（addChild）挂到 parent 下。 */
  private attach(parentId: string, id: string, index?: number): void {
    const parent = this.nodes.get(parentId);
    if (!parent) throw new Error(`stub: parent ${parentId} 不存在`);
    if (index === undefined) parent.children.push(id);
    else parent.children.splice(index, 0, id);
  }

  getMeta() {
    return { title: 'T', structureType: 'mindmap', themeId: 'gmind-blue' };
  }

  getNode(id: string): ReturnType<StubDoc['snapshot']> | null {
    return this.snapshot(id);
  }

  private snapshot(id: string) {
    const n = this.nodes.get(id);
    if (!n) return null;
    return {
      id,
      text: n.text,
      parentId: n.parentId,
      childIds: [...n.children],
      collapsed: n.collapsed,
      deleted: n.deleted,
      note: n.note,
      href: n.href,
      image: n.image ? { ...n.image } : null,
      icons: { ...n.icons },
      style: { ...n.style },
    };
  }

  childrenIds(id: string): string[] {
    return this.snapshot(id)?.childIds ?? [];
  }

  addChild(parentId: string, opts: { index?: number; text?: string } = {}, origin?: string): string {
    this.calls.push({ op: 'addChild', args: [parentId, opts, origin] });
    const id = `n${++this.seq}`;
    this.nodes.set(id, {
      id,
      text: opts.text ?? '',
      parentId,
      children: [],
      note: '',
      href: '',
      image: null,
      icons: {},
      style: {},
      collapsed: false,
      deleted: false,
    });
    this.attach(parentId, id, opts.index);
    return id;
  }

  setText(id: string, text: string, origin?: string): void {
    this.calls.push({ op: 'setText', args: [id, text, origin] });
    const n = this.nodes.get(id);
    if (n) n.text = text;
  }

  setNote(id: string, note: string, origin?: string): void {
    this.calls.push({ op: 'setNote', args: [id, note, origin] });
    const n = this.nodes.get(id);
    if (n) n.note = note;
  }

  setHref(id: string, href: string, origin?: string): void {
    this.calls.push({ op: 'setHref', args: [id, href, origin] });
    const n = this.nodes.get(id);
    if (n) n.href = href;
  }

  setImage(id: string, image: { key: string; w: number; h: number } | null, origin?: string): void {
    this.calls.push({ op: 'setImage', args: [id, image, origin] });
    const n = this.nodes.get(id);
    if (n) n.image = image ? { ...image } : null;
  }

  setIcon(id: string, group: string, value: string | null, origin?: string): void {
    this.calls.push({ op: 'setIcon', args: [id, group, value, origin] });
    const n = this.nodes.get(id);
    if (!n) return;
    if (value === null) delete n.icons[group];
    else n.icons[group] = value;
  }

  setStyle(id: string, patch: Record<string, string | number | null>, origin?: string): void {
    this.calls.push({ op: 'setStyle', args: [id, patch, origin] });
    const n = this.nodes.get(id);
    if (!n) return;
    for (const [k, v] of Object.entries(patch)) {
      if (v === null) delete n.style[k];
      else n.style[k] = String(v);
    }
  }

  /** 页面传入 cutNodes 的 deleteFn 替身（墓碑 + 摘出父 children，镜像 core deleteNodes 行为）。 */
  deleteNodes(ids: string[]): void {
    for (const id of ids) {
      const n = this.nodes.get(id);
      if (!n || n.deleted) continue;
      n.deleted = true;
      const parent = this.nodes.get(n.parentId);
      if (parent) parent.children = parent.children.filter((c) => c !== id);
    }
  }

  ops(): string[] {
    return this.calls.map((c) => c.op);
  }

  adds(): { parent: string; opts: { index?: number; text?: string } }[] {
    return this.calls
      .filter((c) => c.op === 'addChild')
      .map((c) => ({ parent: c.args[0] as string, opts: c.args[1] as { index?: number; text?: string } }));
  }
}

function emptyNode(id: string, text: string): ClipboardPayload['roots'][number] {
  return { id, text, note: '', href: '', image: null, icons: {}, style: {}, children: [] };
}

afterEach(() => {
  vi.unstubAllGlobals();
  delete (navigator as unknown as { clipboard?: unknown }).clipboard;
});

describe('copyNodes（内部结构化 + 文本大纲双格式）', () => {
  it('3 层子树含 style/icons/note/href/image → payload 森林字段完整', () => {
    const doc = new StubDoc();
    doc.addNode({ id: 'root' });
    doc.addNode({
      id: 'a',
      parentId: 'root',
      text: 'A',
      note: '备注A',
      href: 'https://a.example',
      image: { key: 'img-a', w: 100, h: 80 },
      icons: { priority: 'high' },
      style: { color: '#ff0000' },
    });
    doc.addNode({ id: 'a1', parentId: 'a', text: 'A1', style: { color: '#00ff00' } });
    doc.addNode({ id: 'a1a', parentId: 'a1', text: 'A1A' });
    doc.addNode({ id: 'b', parentId: 'root', text: 'B' });

    const { internal, text } = copyNodes(doc, ['a', 'b']);

    expect(internal.v).toBe(1);
    expect(internal.roots).toHaveLength(2);
    const a = internal.roots[0];
    expect(a.id).toBe('a');
    expect(a.text).toBe('A');
    expect(a.note).toBe('备注A');
    expect(a.href).toBe('https://a.example');
    expect(a.image).toEqual({ key: 'img-a', w: 100, h: 80 });
    expect(a.icons).toEqual({ priority: 'high' });
    expect(a.style).toEqual({ color: '#ff0000' });
    expect(a.children).toHaveLength(1);
    expect(a.children[0].id).toBe('a1');
    expect(a.children[0].style).toEqual({ color: '#00ff00' });
    expect(a.children[0].children[0].id).toBe('a1a');
    expect(a.children[0].children[0].children).toEqual([]);
    expect(internal.roots[1]).toEqual(emptyNode('b', 'B'));

    // 文本大纲：每根 0 个 Tab，逐层 +1；多根以 \n 拼接
    expect(text).toBe('A\n\tA1\n\t\tA1A\nB');
  });

  it('缺失 / 墓碑 id 跳过（copy 不抛错）', () => {
    const doc = new StubDoc();
    doc.addNode({ id: 'root' });
    doc.addNode({ id: 'b', parentId: 'root', text: 'B' });
    doc.addNode({ id: 'dead', parentId: 'root', text: 'X', deleted: true });

    const { internal, text } = copyNodes(doc, ['nope', 'dead', 'b']);
    expect(internal.roots).toEqual([emptyNode('b', 'B')]);
    expect(text).toBe('B');
  });
});

describe('pasteNodes（内部 payload 粘贴）', () => {
  const twoRootPayload: ClipboardPayload = {
    v: 1,
    roots: [
      {
        id: 'src1',
        text: 'R1',
        note: 'n1',
        href: 'https://h.example',
        image: { key: 'old-key', w: 12, h: 34 },
        icons: { priority: 'high', star: '5' },
        style: { color: 'red' },
        children: [emptyNode('srcC', 'C1')],
      },
      emptyNode('src2', 'R2'),
    ],
  };

  it('首根插 index、其余追加；富字段写回；返回先序新 id；remap 被等待且用新 key', async () => {
    const doc = new StubDoc();
    doc.addNode({ id: 'root' });
    doc.addNode({ id: 'p', parentId: 'root', text: 'P', children: [] });
    doc.addNode({ id: 'e', parentId: 'p', text: 'E' }); // p.children = [E]
    const remap = vi.fn(async (key: string) => `new-${key}`);

    const ids = await pasteNodes(doc, 'p', 1, twoRootPayload, 'user', remap);

    expect(remap).toHaveBeenCalledTimes(1);
    expect(remap).toHaveBeenCalledWith('old-key');

    // addChild 顺序：R1（index=1）→ C1（R1 的新子，追加）→ R2（追加）
    const adds = doc.adds();
    expect(adds).toHaveLength(3);
    expect(adds[0]).toEqual({ parent: 'p', opts: { index: 1, text: 'R1' } });
    expect(adds[1].parent).toBe(ids[0]); // R1 内的 C1
    expect(adds[1].opts).toEqual({ text: 'C1' }); // 追加（无 index）
    expect(adds[2]).toEqual({ parent: 'p', opts: { text: 'R2' } }); // 第二根追加到末尾

    // 先序 id：R1 → C1 → R2
    expect(ids).toHaveLength(3);
    expect(doc.ops()).toEqual([
      'addChild', // R1
      'setNote',
      'setHref',
      'setImage',
      'setIcon', // priority
      'setIcon', // star
      'setStyle',
      'addChild', // C1（空字段不产生额外写调用）
      'addChild', // R2
    ]);

    // 富字段落值（image 用 remap 后的新 key）
    const r1 = doc.nodes.get(ids[0])!;
    expect(r1.text).toBe('R1');
    expect(r1.note).toBe('n1');
    expect(r1.href).toBe('https://h.example');
    expect(r1.image).toEqual({ key: 'new-old-key', w: 12, h: 34 });
    expect(r1.icons).toEqual({ priority: 'high', star: '5' });
    expect(r1.style).toEqual({ color: 'red' });

    // 结构：p.children = [E, R1, R2]（首根插在 index=1，R2 追加末尾）
    expect(doc.nodes.get('p')!.children).toEqual(['e', ids[0], ids[2]]);
    expect(doc.nodes.get(ids[0])!.children).toEqual([ids[1]]);

    // origin 透传
    expect(doc.calls[0].args[2]).toBe('user');
  });

  it('无 remap 时 image 沿用原 key；空富字段不产生写调用', async () => {
    const doc = new StubDoc();
    doc.addNode({ id: 'root' });
    doc.addNode({ id: 'p', parentId: 'root', text: 'P' });
    const payload: ClipboardPayload = {
      v: 1,
      roots: [
        {
          id: 's',
          text: 'S',
          note: '',
          href: '',
          image: { key: 'keep', w: 1, h: 2 },
          icons: {},
          style: {},
          children: [],
        },
      ],
    };
    const ids = await pasteNodes(doc, 'p', 0, payload);
    expect(doc.nodes.get(ids[0])!.image).toEqual({ key: 'keep', w: 1, h: 2 });
    expect(doc.ops()).toEqual(['addChild', 'setImage']);
  });

  it('parent 缺失 / 墓碑 → 抛 PARENT_INVALID 且零写入', async () => {
    const doc = new StubDoc();
    doc.addNode({ id: 'root' });
    doc.addNode({ id: 'dead', parentId: 'root', text: 'D', deleted: true });

    await expect(pasteNodes(doc, 'nope', 0, twoRootPayload)).rejects.toThrow('PARENT_INVALID');
    await expect(pasteNodes(doc, 'dead', 0, twoRootPayload)).rejects.toThrow('PARENT_INVALID');
    expect(() => pasteText(doc, 'nope', 0, '文本')).toThrow('PARENT_INVALID'); // pasteText 同步路径
    expect(doc.calls).toHaveLength(0);
  });
});

describe('pasteText（纯文本大纲路径，镜像 core insertSpec）', () => {
  it('2 层 Tab 缩进 → 嵌套 addChild（先根后子，cursor 语义）', () => {
    const doc = new StubDoc();
    doc.addNode({ id: 'root' });
    doc.addNode({ id: 'p', parentId: 'root', text: 'P' });

    const ids = pasteText(doc, 'p', 0, 'Parent\n\tChild A\n\t\tGrand\n\tChild B');

    const adds = doc.adds();
    expect(adds).toHaveLength(4);
    expect(adds[0]).toEqual({ parent: 'p', opts: { index: 0, text: 'Parent' } });
    expect(adds[1].parent).toBe(ids[0]);
    expect(adds[1].opts).toEqual({ index: 0, text: 'Child A' });
    expect(adds[2].parent).toBe(ids[1]);
    expect(adds[2].opts).toEqual({ index: 0, text: 'Grand' });
    expect(adds[3].parent).toBe(ids[0]);
    expect(adds[3].opts).toEqual({ index: 1, text: 'Child B' });
    // 先序：P → CA → G → CB
    expect(ids).toHaveLength(4);
    expect(doc.nodes.get(ids[0])!.children).toEqual([ids[1], ids[3]]);
  });

  it('多根 cursor 语义：Y 紧跟 X（index、index+1），镜像 core insertSpec', () => {
    const doc = new StubDoc();
    doc.addNode({ id: 'root' });
    doc.addNode({ id: 'p', parentId: 'root', text: 'P' });
    doc.addNode({ id: 'e', parentId: 'p', text: 'E' });
    doc.nodes.get('p')!.children = ['e'];

    const ids = pasteText(doc, 'p', 1, 'X\nY');
    expect(doc.nodes.get('p')!.children).toEqual(['e', ids[0], ids[1]]);
  });

  it(`任一行超 ${MAX_TEXT_LENGTH} → 抛 TEXT_TOO_LONG 且零写入（预校验先于任何 mutation）`, () => {
    const doc = new StubDoc();
    doc.addNode({ id: 'root' });
    doc.addNode({ id: 'p', parentId: 'root', text: 'P' });

    expect(() => pasteText(doc, 'p', 0, `ok\n${'x'.repeat(MAX_TEXT_LENGTH + 1)}`)).toThrow('TEXT_TOO_LONG');
    expect(doc.calls).toHaveLength(0);

    // 恰好 500 合法
    const ids = pasteText(doc, 'p', 0, 'x'.repeat(MAX_TEXT_LENGTH));
    expect(ids).toHaveLength(1);
  });
});

describe('cutNodes（copy 先行 + deleteFn）', () => {
  it('返回删除前状态的 payload；deleteFn 以原 ids 调用恰一次', async () => {
    const doc = new StubDoc();
    doc.addNode({ id: 'root' });
    doc.addNode({ id: 'a', parentId: 'root', text: 'A' });
    doc.addNode({ id: 'a1', parentId: 'a', text: 'A1' });
    const deleteFn = vi.fn((ids: string[]) => doc.deleteNodes(ids));

    const result = cutNodes(doc, ['a', 'nope'], deleteFn);

    // copy 先于 delete：payload 反映删除前结构
    expect(result.internal.roots[0].id).toBe('a');
    expect(result.internal.roots[0].children[0].text).toBe('A1');
    expect(result.text).toBe('A\n\tA1');
    expect(deleteFn).toHaveBeenCalledTimes(1);
    expect(deleteFn).toHaveBeenCalledWith(['a', 'nope']);
    // 删除已生效
    expect(doc.getNode('a')?.deleted).toBe(true);
    expect(doc.nodes.get('root')!.children).toEqual([]);
    // 且 payload 仍可 paste
    const doc2 = new StubDoc();
    doc2.addNode({ id: 'root' });
    doc2.addNode({ id: 'p', parentId: 'root', text: 'P' });
    const ids = await pasteNodes(doc2, 'p', 0, result.internal);
    expect(doc2.adds()).toHaveLength(2);
    expect(ids).toHaveLength(2);
  });
});

describe('系统剪贴板（jsdom 降级 + 两 MIME）', () => {
  const payload: ClipboardPayload = { v: 1, roots: [emptyNode('s', 'S')] };

  it('jsdom 无 clipboard API → write 返回 false，内存兜底持有 lastInternal', async () => {
    expect(await writeToSystemClipboard({ internal: payload, text: 'S' })).toBe(false);
    expect(readInternalFallback()).toBe(payload);
    await expect(readFromSystemClipboard()).resolves.toEqual({ internal: payload, text: null });
  });

  it('有 clipboard API → 单 ClipboardItem 携带两 MIME，返回 true（成功也更新 lastInternal）', async () => {
    const written: unknown[][] = [];
    const write = vi.fn(async (items: unknown[]) => {
      written.push(items);
    });
    Object.defineProperty(navigator, 'clipboard', { value: { write }, configurable: true });
    class FakeClipboardItem {
      data: Record<string, string>;
      constructor(data: Record<string, string>) {
        this.data = data;
      }
    }
    vi.stubGlobal('ClipboardItem', FakeClipboardItem);

    expect(await writeToSystemClipboard({ internal: payload, text: 'S' })).toBe(true);
    expect(write).toHaveBeenCalledTimes(1);
    const items = written[0] as unknown as InstanceType<typeof FakeClipboardItem>[];
    expect(items).toHaveLength(1);
    expect(Object.keys(items[0].data)).toEqual(['text/plain', INTERNAL_MIME]);
    expect(items[0].data['text/plain']).toBe('S');
    expect(JSON.parse(items[0].data[INTERNAL_MIME])).toEqual(payload);

    // 成功也更新内存兜底：卸掉 API 后仍可读回
    delete (navigator as unknown as { clipboard?: unknown }).clipboard;
    await expect(readFromSystemClipboard()).resolves.toEqual({ internal: payload, text: null });
  });

  it('read：系统剪贴板含 gmind MIME → internal 解析 + 纯文本', async () => {
    const read = vi.fn(async () => [
      {
        types: ['text/plain', INTERNAL_MIME],
        getType: async (t: string) => new Blob([t === INTERNAL_MIME ? JSON.stringify(payload) : 'S']),
      },
    ]);
    Object.defineProperty(navigator, 'clipboard', { value: { read }, configurable: true });
    await expect(readFromSystemClipboard()).resolves.toEqual({ internal: payload, text: 'S' });
  });

  it('read：仅纯文本（外部应用复制）→ internal 为 null，不回退 stale lastInternal', async () => {
    await writeToSystemClipboard({ internal: payload, text: 'S' }); // 失败路径先污染 lastInternal
    const read = vi.fn(async () => [
      { types: ['text/plain'], getType: async () => new Blob(['external']) },
    ]);
    Object.defineProperty(navigator, 'clipboard', { value: { read }, configurable: true });
    await expect(readFromSystemClipboard()).resolves.toEqual({ internal: null, text: 'external' });
  });

  it('read：read() 抛出（权限拒绝）→ 回退内存兜底 {internal: lastInternal, text: null}', async () => {
    await writeToSystemClipboard({ internal: payload, text: 'S' });
    const read = vi.fn(async () => {
      throw new Error('denied');
    });
    Object.defineProperty(navigator, 'clipboard', { value: { read }, configurable: true });
    await expect(readFromSystemClipboard()).resolves.toEqual({ internal: payload, text: null });
  });

  it('read：gmind MIME 内容损坏 → internal 为 null（text 仍可用）', async () => {
    const read = vi.fn(async () => [
      {
        types: ['text/plain', INTERNAL_MIME],
        getType: async (t: string) => new Blob([t === INTERNAL_MIME ? 'not-json{{{' : 'S']),
      },
    ]);
    Object.defineProperty(navigator, 'clipboard', { value: { read }, configurable: true });
    await expect(readFromSystemClipboard()).resolves.toEqual({ internal: null, text: 'S' });
  });
});
