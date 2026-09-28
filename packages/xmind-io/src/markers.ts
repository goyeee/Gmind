// markers.ts：XMind marker-id ⇄ Gmind 三组制标记的双向映射（M7a-T1 目录对齐）。
//
// 导入口径（spec M7a T1 裁定 + M7a-R1 评审对齐 repair）：priority-1..7 → '1'-'7'；
// priority-8/9 → '7'（XMind 九档收敛到 Gmind 七档上限）；flag-*（任意颜色）→ icon
// 'flag'；star-* → icon 'important'（颜色信息无对应位，丢弃）；flag 与 star 并存时
// **star 恒胜**（无条件覆盖 flag 的映射结果，与 repair.ts「star 胜过 flag」同口径，
// 与出现顺序无关，被吞掉的 flag 计入 dropped）；同组其余重复 marker 取**首个出现**（组内单选语义），被单选吞掉的
// 后续 marker 与无对应的 marker 族（task-*/people/symbol 等）、无法解析的 id 一并计入
// dropped（style 降级，FR-IO-002「未映射丢弃并登记」口径）。emoji 组不从 XMind 导入
// （XMind 表情 marker 族 id 与 Gmind 目录无稳定对应）。
//
// 导出口径（「仅出三组」）：priority '1'-'7' → priority-N；icon 'flag' → flag-red、
// icon 'important' → star-red（代表性原生 id，颜色不保真）；其余 icon slug 与 emoji
// 字符无 XMind 原生 marker 对应，不导出（不造不存在 的 marker-id，保证产物在
// XMind 中可打开）。

import type { XmindIcons } from './types';

/** 导入方向：marker-id 列表 → 三组制标记 + 丢弃计数（计入 style 降级）。 */
export function markersToIcons(ids: string[]): { icons: XmindIcons; dropped: number } {
  let dropped = 0;
  const icons: XmindIcons = {};
  let prioritySeen = false;
  let flagSeen = false;
  let starSeen = false;
  for (const id of ids) {
    if (typeof id !== 'string' || id === '') {
      dropped += 1;
      continue;
    }
    const pr = /^priority-([1-9])$/.exec(id);
    if (pr) {
      if (prioritySeen) {
        dropped += 1; // 同组后续：组内单选吞掉 → 未映射丢弃并登记（M7a-R1 2.4）
      } else {
        prioritySeen = true;
        const n = Number(pr[1]);
        icons.priority = n >= 8 ? '7' : (pr[1] as string);
      }
      continue;
    }
    if (/^flag-/.test(id)) {
      if (flagSeen) dropped += 1; // 同组后续：被吞掉 → 登记（star 恒胜时同样计入）
      else flagSeen = true;
      continue;
    }
    if (/^star-/.test(id)) {
      if (starSeen) dropped += 1; // 同组后续：被吞掉 → 登记
      else starSeen = true;
      continue;
    }
    dropped += 1; // 无对应：丢弃并登记
  }
  if (starSeen) {
    icons.icon = 'important'; // star 恒胜：无条件覆盖 flag 分支结果（对齐 repair）
    if (flagSeen) dropped += 1; // 同组（icon）被 star 吞掉的 flag：未在结果中映射 → 登记（M7a-R1 2.4）
  } else if (flagSeen) {
    icons.icon = 'flag';
  }
  return { icons, dropped };
}

/** icon slug → 导出用 XMind 原生 marker-id（仅有把握的两个；其余不导出）。 */
const EXPORT_ICON_IDS: Record<string, string> = {
  flag: 'flag-red',
  important: 'star-red',
};

/** 导出方向：三组制标记 → XMind marker-id 列表（仅出三组中有原生对应的值）。 */
export function iconsToMarkerIds(icons: XmindIcons | undefined): string[] {
  if (!icons) return [];
  const out: string[] = [];
  if (icons.priority !== undefined && /^[1-7]$/.test(icons.priority)) {
    out.push(`priority-${icons.priority}`);
  }
  if (icons.icon !== undefined && EXPORT_ICON_IDS[icons.icon] !== undefined) {
    out.push(EXPORT_ICON_IDS[icons.icon] as string);
  }
  // emoji 与其余 icon slug：无 XMind 原生 marker 对应，不导出（头注口径）
  return out;
}
