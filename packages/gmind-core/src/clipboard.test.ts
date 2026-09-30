import { describe, expect, it } from 'vitest';
import * as Y from 'yjs';
import { ROOT_NODE_ID, countNodes, createTemplateDoc } from './doc';
import { GmindCoreError } from './errors';
import { addChild, deleteNodes } from './operations';
import { childrenIds, countAlive, getNode } from './read';
import { MAX_TEXT_LENGTH } from './constants';
import { insertSpec, outlineToSpec, subtreeToOutlineText, type SpecNode } from './clipboard';

/** 断言 fn 抛出指定 code 的 GmindCoreError。 */
function expectErrorCode(fn: () => unknown, code: GmindCoreError['code']): void {
  try {
    fn();
    expect.unreachable();
  } catch (e) {
    expect(e).toBeInstanceOf(GmindCoreError);
    expect((e as GmindCoreError).code).toBe(code);
  }
}

/** 固定树：root → [A[A-1[A-1-1], A-2], B[B1]]。 */
function buildTestTree(): Y.Doc {
  return createTemplateDoc({
    title: '中心',
    children: [
      { text: 'A', children: [{ text: 'A-1', children: [{ text: 'A-1-1' }] }, { text: 'A-2' }] },
      { text: 'B', children: [{ text: 'B1' }] },
    ],
  });
}

/** 递归比较两棵子树：除 id/parentId/childIds 外的 getNode 快照逐点一致（结构 + 文本 + 默认字段）。
 *  side（逆时针定侧的持久侧别）一并归一掉：它是创建上下文相关的布局提示——复制走
 *  大纲文本不携带 side，粘贴端按 addChild 默认定侧重算（第 1~3 右/第 4 起左），两侧
 *  文档的建序不同即合理地不同，不属于大纲往返的保真范围。 */
function expectSameShape(docA: Y.Doc, aId: string, docB: Y.Doc, bId: string): void {
  const a = getNode(docA, aId)!;
  const b = getNode(docB, bId)!;
  const normalize = (n: ReturnType<typeof getNode>) =>
    n === null ? null : { ...n, id: null, parentId: null, childIds: [] as string[], side: undefined };
  expect(normalize(b)).toEqual(normalize(a));
  expect(b.childIds).toHaveLength(a.childIds.length);
  expect(b.id).not.toBe(a.id);
  for (let i = 0; i < a.childIds.length; i += 1) {
    expectSameShape(docA, a.childIds[i]!, docB, b.childIds[i]!);
  }
}

describe('subtreeToOutlineText', () => {
  it('三层子树按深度输出 Tab 缩进（根 0 个 Tab，根的子节点 1 个 Tab）', () => {
    const doc = buildTestTree();
    const aId = childrenIds(doc, ROOT_NODE_ID)[0]!;
    const lines = subtreeToOutlineText(doc, aId).split('\n');
    expect(lines).toEqual(['A', '\tA-1', '\t\tA-1-1', '\tA-2']);
  });

  it('节点 text 内的换行导出时折叠为单个空格（文档化限制）', () => {
    const doc = createTemplateDoc({ title: '中心', children: [] });
    addChild(doc, ROOT_NODE_ID, { text: 'line1\nline2' });
    addChild(doc, ROOT_NODE_ID, { text: 'a\n\nb' });
    const out = subtreeToOutlineText(doc, ROOT_NODE_ID);
    expect(out).toBe('中心\n\tline1 line2\n\ta b');
    expect(subtreeToOutlineText(doc, childrenIds(doc, ROOT_NODE_ID)[0]!)).toBe('line1 line2');
  });

  it('id 不存在抛 NODE_NOT_FOUND', () => {
    const doc = buildTestTree();
    expectErrorCode(() => subtreeToOutlineText(doc, 'nope'), 'NODE_NOT_FOUND');
  });

  it('墓碑节点不可导出，抛 NODE_DELETED', () => {
    const doc = buildTestTree();
    const aId = childrenIds(doc, ROOT_NODE_ID)[0]!;
    deleteNodes(doc, [aId]);
    expectErrorCode(() => subtreeToOutlineText(doc, aId), 'NODE_DELETED');
  });
});

describe('outlineToSpec', () => {
  it('解析 Tab 缩进层级', () => {
    const spec = outlineToSpec('A\n\tA-1\n\t\tA-1-1\n\tA-2');
    expect(spec).toEqual([
      {
        text: 'A',
        children: [
          { text: 'A-1', children: [{ text: 'A-1-1', children: [] }] },
          { text: 'A-2', children: [] },
        ],
      },
    ]);
  });

  it('解析偶数空格缩进（空格数 ÷2 取整为层级；4 空格直接缩进钳制为上一行子节点）', () => {
    const spec = outlineToSpec('L0\n  L1\n    L2\n      L3');
    expect(spec[0]!.text).toBe('L0');
    expect(spec[0]!.children[0]!.text).toBe('L1');
    expect(spec[0]!.children[0]!.children[0]!.text).toBe('L2');
    expect(spec[0]!.children[0]!.children[0]!.children[0]!.text).toBe('L3');

    const clamped = outlineToSpec('R\n    C');
    expect(clamped).toHaveLength(1);
    expect(clamped[0]!.children.map((c) => c.text)).toEqual(['C']);
  });

  it('跳过空行与纯空白行', () => {
    const spec = outlineToSpec('A\n\n   \n\tA-1\n\t\n');
    expect(spec).toEqual([{ text: 'A', children: [{ text: 'A-1', children: [] }] }]);
  });

  it('返回森林（多个顶层条目）', () => {
    const spec = outlineToSpec('A\n\tA-1\nB\n\tB-1');
    expect(spec.map((r) => r.text)).toEqual(['A', 'B']);
    expect(spec[0]!.children[0]!.text).toBe('A-1');
    expect(spec[1]!.children[0]!.text).toBe('B-1');
  });

  it('同层缩进的首行保留原始层级，后续同层行为森林兄弟（不并成单根链）', () => {
    expect(outlineToSpec('\tA\n\tB')).toEqual([
      { text: 'A', children: [] },
      { text: 'B', children: [] },
    ]);
    expect(outlineToSpec('  A\n  B')).toEqual([
      { text: 'A', children: [] },
      { text: 'B', children: [] },
    ]);
  });

  it('解析入口归一化 CRLF/CR，节点 text 不残留 \\r', () => {
    expect(outlineToSpec('A\r\n\tB\r\n')).toEqual([
      { text: 'A', children: [{ text: 'B', children: [] }] },
    ]);
    expect(outlineToSpec('A\r\tB')).toEqual([
      { text: 'A', children: [{ text: 'B', children: [] }] },
    ]);
  });

  it('反常缩进钳制到最近合法祖先层级，结果确定（不抛错）', () => {
    // 1 个 Tab 之后出现 3 个 Tab：钳制为 1 Tab 节点（A-1）的子节点
    const text = 'A\n\tA-1\n\t\t\tDeep';
    const spec = outlineToSpec(text);
    expect(spec[0]!.children[0]!.children.map((c) => c.text)).toEqual(['Deep']);
    expect(outlineToSpec(text)).toEqual(spec);

    // 深层之后直接回到 0 级（回退超过一层）：钳制为森林新根
    const spec2 = outlineToSpec('A\n\tA-1\n\t\tA-1-1\nTop');
    expect(spec2.map((r) => r.text)).toEqual(['A', 'Top']);
    expect(spec2[1]!.children).toEqual([]);
  });
});

describe('insertSpec', () => {
  it('返回先序新节点 id 数组，数量与 spec 节点数一致', () => {
    const doc = createTemplateDoc({ title: '中心', children: [] });
    const spec: SpecNode[] = [
      { text: 'P', children: [{ text: 'P-1', children: [] }, { text: 'P-2', children: [{ text: 'P-2-1', children: [] }] }] },
      { text: 'Q', children: [] },
    ];
    const ids = insertSpec(doc, ROOT_NODE_ID, 0, spec);
    expect(ids).toHaveLength(5);
    expect(ids.map((id) => getNode(doc, id)!.text)).toEqual(['P', 'P-1', 'P-2', 'P-2-1', 'Q']);
  });

  it('index 为首个 spec 根在 parent children 中的位置，后续兄弟 spec 紧随其后插入', () => {
    const doc = createTemplateDoc({ title: '中心', children: [{ text: 'X' }] });
    insertSpec(doc, ROOT_NODE_ID, 0, [{ text: 'P', children: [] }, { text: 'Q', children: [] }]);
    expect(childrenIds(doc, ROOT_NODE_ID).map((id) => getNode(doc, id)!.text)).toEqual([
      'P', 'Q', 'X',
    ]);

    insertSpec(doc, ROOT_NODE_ID, 1, [{ text: 'R', children: [] }]);
    expect(childrenIds(doc, ROOT_NODE_ID).map((id) => getNode(doc, id)!.text)).toEqual([
      'P', 'R', 'Q', 'X',
    ]);
  });

  it('spec 含超长文本（含深层嵌套）全量预校验抛 TEXT_TOO_LONG，且文档零变更', () => {
    const doc = createTemplateDoc({ title: '中心', children: [] });
    const long = 'x'.repeat(MAX_TEXT_LENGTH + 1);
    const aliveBefore = countAlive(doc);
    const nodesBefore = countNodes(doc);

    expectErrorCode(
      () => insertSpec(doc, ROOT_NODE_ID, 0, [{ text: 'OK', children: [] }, { text: long, children: [] }]),
      'TEXT_TOO_LONG',
    );
    // 违规节点藏在深层同样先被拒
    expectErrorCode(
      () => insertSpec(doc, ROOT_NODE_ID, 0, [{ text: 'OK', children: [{ text: long, children: [] }] }]),
      'TEXT_TOO_LONG',
    );
    expect(countAlive(doc)).toBe(aliveBefore);
    expect(countNodes(doc)).toBe(nodesBefore);
  });

  it('合法 spec 行为不变（预校验后逐点插入）', () => {
    const doc = createTemplateDoc({ title: '中心', children: [] });
    const ids = insertSpec(doc, ROOT_NODE_ID, 0, [
      { text: 'P', children: [{ text: 'P-1', children: [] }] },
    ]);
    expect(ids).toHaveLength(2);
    expect(ids.map((id) => getNode(doc, id)!.text)).toEqual(['P', 'P-1']);
  });

  it('parent 为墓碑抛 NODE_DELETED；不存在抛 NODE_NOT_FOUND；拒绝时文档零变更', () => {
    const doc = buildTestTree();
    const aId = childrenIds(doc, ROOT_NODE_ID)[0]!;
    deleteNodes(doc, [aId]);
    const aliveBefore = countAlive(doc);

    expectErrorCode(() => insertSpec(doc, aId, 0, [{ text: 'N', children: [] }]), 'NODE_DELETED');
    expectErrorCode(() => insertSpec(doc, 'nope', 0, [{ text: 'N', children: [] }]), 'NODE_NOT_FOUND');
    expect(countAlive(doc)).toBe(aliveBefore);
  });
});

describe('往返：导出 → 解析 → 粘贴', () => {
  it('doc A 子树导出解析后插入全新 doc B，两树快照一致（id 不同）', () => {
    const docA = buildTestTree();
    const aId = childrenIds(docA, ROOT_NODE_ID)[0]!;

    const text = subtreeToOutlineText(docA, aId);
    const spec = outlineToSpec(text);

    const docB = createTemplateDoc({ title: '另一份', children: [] });
    const ids = insertSpec(docB, ROOT_NODE_ID, 0, spec);
    expect(ids).toHaveLength(4); // A、A-1、A-1-1、A-2

    expectSameShape(docA, aId, docB, ids[0]!);
  });

  it('森林 spec 粘贴为多个根级子树，保持相对顺序', () => {
    const docA = buildTestTree();
    const [aId, bId] = childrenIds(docA, ROOT_NODE_ID);
    const spec = [
      ...outlineToSpec(subtreeToOutlineText(docA, aId!)),
      ...outlineToSpec(subtreeToOutlineText(docA, bId!)),
    ];
    expect(spec.map((r) => r.text)).toEqual(['A', 'B']);

    const docB = createTemplateDoc({ title: '空文档', children: [] });
    const ids = insertSpec(docB, ROOT_NODE_ID, 0, spec);
    expect(ids).toHaveLength(6); // A、A-1、A-1-1、A-2、B、B1
    expect(ids.map((id) => getNode(docB, id)!.text)).toEqual([
      'A', 'A-1', 'A-1-1', 'A-2', 'B', 'B1',
    ]);
    expectSameShape(docA, aId!, docB, ids[0]!);
    expectSameShape(docA, bId!, docB, ids[4]!);
  });
});
