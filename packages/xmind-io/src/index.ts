// index.ts：@gmind/xmind-io 导出面——纯数据进出，不依赖 yjs / @gmind/*，可在任意端使用。
import { unzipSync } from 'fflate';
import { parseContentJson } from './parse-json';
import { parseContentXml } from './parse-xml';
import type { DegradedItem, XmindNode } from './types';
import { XmindParseError } from './types';

export { buildXmind } from './build';
export { XmindParseError } from './types';
export type { XmindNode, DegradedKind, DegradedItem, XmindErrorCode } from './types';

/** 解析 .xmind（zip 容器）：content.json（2020+）优先，回落 content.xml（XMind 8）。
 *  只保留层级/文本/备注；样式、标记、标签、图片、附件、漂浮主题、概要、额外 sheet 计入降级。 */
export function parseXmind(bytes: Uint8Array): { root: XmindNode; degraded: DegradedItem[] } {
  let files: Record<string, Uint8Array>;
  try {
    files = unzipSync(bytes);
  } catch {
    throw new XmindParseError('CORRUPTED', '无法解压 .xmind：不是合法的 zip 容器');
  }

  const json = files['content.json'];
  if (json) return parseContentJson(json);
  const xml = files['content.xml'];
  if (xml) return parseContentXml(xml);
  throw new XmindParseError('UNSUPPORTED_FORMAT', 'zip 中既无 content.json 也无 content.xml');
}
