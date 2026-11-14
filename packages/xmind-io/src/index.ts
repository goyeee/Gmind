// index.ts：@gmind/xmind-io 导出面——纯数据进出，不依赖 yjs / @gmind/*，可在任意端使用。
// 2026-11-14 导入保真 v2：parseXmind 额外返回 resources（zip 内媒体经魔数白名单嗅探入表，
// 供导入胶水上传图片用）；扫描跳过 zip 目录条目；styles.xml 预解析成间接表传给 XML 解析。
// 降级为命名制 DegradedItem{key,count}（目录序见 DEGRADED_LABELS）。
import { unzipSync, zipSync } from 'fflate';
import { parseContentJson } from './parse-json';
import { parseContentXml, parseStylesTable } from './parse-xml';
import type { DegradedItem, XmindResources, XmindSheet } from './types';
import { XmindParseError } from './types';

export { buildXmind } from './build';
export { iconsToMarkerIds, markersToIcons } from './markers';
export { DEGRADED_LABELS, XmindParseError } from './types';
export type {
  XmindIcons,
  XmindNode,
  XmindSheet,
  XmindStructureType,
  XmindResource,
  XmindResources,
  DegradedKey,
  DegradedItem,
  XmindErrorCode,
} from './types';

/**
 * 供 e2e 夹具构造 zip 的极小开口：包一层本包内部已用的 fflate `zipSync`——web 等
 * e2e 进程经 `@gmind/xmind-io` 组装合成 .xmind（如 apps/web/e2e/helpers/
 * xmind-fixture.ts），**不直接依赖 fflate**（fflate 恒为 xmind-io 私有依赖，e2e
 * 进程不可解析，见 error-copy.e2e.spec.ts 头注「构造依赖 fflate（xmind-io 私有
 * 依赖）」先例）。导出主链路不调用（buildXmind 自组 zip，不产 resources/）。
 */
export function zipEntries(entries: Record<string, Uint8Array>): Uint8Array {
  return zipSync(entries);
}

/** 魔数嗅探（spec §四白名单）：png `\x89PNG` / jpg `\xFF\xD8\xFF` / gif `GIF8` / webp `RIFF..WEBP`；
 *  白名单外返回 undefined（不入 resources 表，引用处计图片降级）。 */
function sniffImageMime(b: Uint8Array): string | undefined {
  if (
    b.length >= 4 &&
    b[0] === 0x89 &&
    b[1] === 0x50 &&
    b[2] === 0x4e &&
    b[3] === 0x47
  ) {
    return 'image/png';
  }
  if (b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'image/jpeg';
  if (b.length >= 4 && b[0] === 0x47 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x38) return 'image/gif';
  if (
    b.length >= 12 &&
    b[0] === 0x52 &&
    b[1] === 0x49 &&
    b[2] === 0x46 &&
    b[3] === 0x46 && // RIFF
    b[8] === 0x57 &&
    b[9] === 0x45 &&
    b[10] === 0x42 &&
    b[11] === 0x50 // WEBP
  ) {
    return 'image/webp';
  }
  return undefined;
}

/** 解析 .xmind（zip 容器）：content.json（2020+）优先，回落 content.xml（XMind 8）。
 *  提取层级/文本/备注/标记/href/图片（resources 表）/概要/样式/折叠/结构；其余未导入特性
 *  按 DegradedKey 命名制逐项计数（目录序见 DEGRADED_LABELS）。多画布（计划四，裁定 8）：
 *  全部 sheet 逐个产出（不再取 [0] 拍平）。 */
export function parseXmind(bytes: Uint8Array): {
  sheets: XmindSheet[];
  degraded: DegradedItem[];
  resources: XmindResources;
} {
  let files: Record<string, Uint8Array>;
  try {
    files = unzipSync(bytes);
  } catch {
    throw new XmindParseError('CORRUPTED', '无法解压 .xmind：不是合法的 zip 容器');
  }

  // 资源表：跳过目录条目（真实 zip 有 `resources/` 目录项），魔数白名单外不入表。
  const resources: XmindResources = {};
  for (const [path, data] of Object.entries(files)) {
    if (path.endsWith('/')) continue;
    const mime = sniffImageMime(data);
    if (mime) resources[path] = { bytes: data, mime };
  }

  // styles.xml 预解析（存在时）：style-id → 属性表，供 XML 解析走间接表（JSON 路径用不到）。
  const styles = parseStylesTable(files['styles.xml']);

  const json = files['content.json'];
  if (json) return { ...parseContentJson(json, resources), resources };
  const xml = files['content.xml'];
  if (xml) return { ...parseContentXml(xml, resources, styles), resources };
  throw new XmindParseError('UNSUPPORTED_FORMAT', 'zip 中既无 content.json 也无 content.xml');
}
