// xmind-import.ts：XMind 导入胶水（M4 Task 4，FR-IO-001/002）。
//
// file → { title, state, degraded }：大小预检 → parseXmind（@gmind/xmind-io）→
// 经 @gmind/core 操作层组装 Y.Doc（唯一写入口约束：addChild/setNote，绝不直改 Y.Map）→
// docToState → base64。错误一律以 Error.message 归因（FR-IO-001）：
// - file.size > 20MB → 「文件大小超过 20MB 上限」（解析前预检，超大文件不进解析）；
// - XmindParseError UNSUPPORTED_FORMAT → 「无法识别的文件格式（仅支持 .xmind）」；
// - 其余解析错误 → 「文件已损坏，无法解析」。
// 降级提示文案（FR-IO-002）由 degradedSummary 统一构造。
import {
  addChild,
  createTemplateDoc,
  docToState,
  getMeta,
  GmindCoreError,
  ROOT_NODE_ID,
  setNote,
} from '@gmind/core';
import { parseXmind, XmindParseError, type DegradedItem, type XmindNode } from '@gmind/xmind-io';

/** .xmind 导入大小上限（FR-IO-001）：超限直接拒绝，不进入解析。 */
const MAX_IMPORT_BYTES = 20 * 1024 * 1024;

/** 降级类别 → 文案段标签（顺序即括号内段序，与 FR-IO-002 模板一致）。 */
const DEGRADED_LABELS: Array<[DegradedItem['kind'], string]> = [
  ['style', '样式'],
  ['media', '媒体'],
  ['structure', '结构'],
];

/** 降级提示文案（FR-IO-002）：「已降级处理 N 项（样式 x/媒体 y/结构 z）」——
 *  N = 各 kind 计数之和（前缀逐字保留）；计数为 0 的 kind 不出现在括号内。 */
export function degradedSummary(degraded: DegradedItem[]): string {
  const total = degraded.reduce((sum, d) => sum + d.count, 0);
  const counts = new Map(degraded.map((d) => [d.kind, d.count]));
  const segs = DEGRADED_LABELS.filter(([kind]) => (counts.get(kind) ?? 0) > 0)
    .map(([kind, label]) => `${label} ${counts.get(kind)}`)
    .join('/');
  return segs ? `已降级处理 ${total} 项（${segs}）` : `已降级处理 ${total} 项`;
}

/** bytes → base64（与 useEditorDoc.ts 的 base64ToBytes 对称的逆变换）。
 *  大数组分块 String.fromCharCode：一次性 spread 会撞引擎实参个数/call stack 上限。 */
function bytesToBase64(bytes: Uint8Array): string {
  const CHUNK = 0x8000;
  let binary = '';
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return btoa(binary);
}

/** 导入 .xmind 文件：解析 → core 组装 → base64 文档状态。
 *  root 即 ROOT_NODE_ID，文本 = 根主题标题（缺省回落文件名去 .xmind 后缀）；
 *  树按先序 addChild/setNote 组装。degraded 原样透传给调用方呈现（FR-IO-002）。 */
export async function importXmindFile(
  file: File,
): Promise<{ title: string; state: string; degraded: DegradedItem[] }> {
  if (file.size > MAX_IMPORT_BYTES) throw new Error('文件大小超过 20MB 上限');
  const bytes = new Uint8Array(await file.arrayBuffer());
  let parsed: ReturnType<typeof parseXmind>;
  try {
    parsed = parseXmind(bytes);
  } catch (e) {
    if (e instanceof XmindParseError && e.code === 'UNSUPPORTED_FORMAT') {
      throw new Error('无法识别的文件格式（仅支持 .xmind）');
    }
    throw new Error('文件已损坏，无法解析');
  }

  const title = parsed.root.title || file.name.replace(/\.xmind$/i, '');
  const doc = createTemplateDoc({ title, children: [] });
  const walk = (node: XmindNode, parentId: string): void => {
    for (const child of node.children) {
      const id = addChild(doc, parentId, { text: child.title });
      if (child.note) setNote(doc, id, child.note);
      walk(child, id);
    }
  };
  try {
    walk(parsed.root, ROOT_NODE_ID);
  } catch (e) {
    // core 组装失败归因（M4 挂账清偿）：解析出的树超出文档模型可承载范围——
    // GmindCoreError（如 TEXT_TOO_LONG 超长文本被 addChild 拒绝）与深树递归的
    // 栈溢出（RangeError）都按解析失败同文案兜底，core 错误不裸抛给用户。
    if (e instanceof GmindCoreError || e instanceof RangeError) {
      throw new Error('文件已损坏，无法解析');
    }
    throw e;
  }

  return { title: getMeta(doc).title, state: bytesToBase64(docToState(doc)), degraded: parsed.degraded };
}
