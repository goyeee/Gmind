// markers.ts：XMind marker-id ⇄ Gmind 三组制标记的双向映射（M7a-T1 目录对齐）。
//
// 导入口径（spec M7a T1 裁定）：priority-1..7 → '1'-'7'；priority-8/9 → '7'（XMind 九档
// 收敛到 Gmind 七档上限）；flag-*（任意颜色）→ icon 'flag'；star-* → icon 'important'
// （颜色信息无对应位，丢弃）；同组多个 marker 取**首个出现**（组内单选语义）；
// 其余 marker 族（task-*/people/symbol 等）与无法解析的 id 无对应 → 丢弃并计入
// style 降级（FR-IO-002 登记口径）。emoji 组不从 XMind 导入（XMind 表情 marker 族
// id 与 Gmind 目录无稳定对应）。
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
  for (const id of ids) {
    if (typeof id !== 'string' || id === '') {
      dropped += 1;
      continue;
    }
    const pr = /^priority-([1-9])$/.exec(id);
    if (pr) {
      if (icons.priority === undefined) {
        const n = Number(pr[1]);
        icons.priority = n >= 8 ? '7' : (pr[1] as string);
      }
      continue;
    }
    if (/^flag-/.test(id)) {
      if (icons.icon === undefined) icons.icon = 'flag';
      continue;
    }
    if (/^star-/.test(id)) {
      if (icons.icon === undefined) icons.icon = 'important';
      continue;
    }
    dropped += 1; // 无对应：丢弃并登记
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
