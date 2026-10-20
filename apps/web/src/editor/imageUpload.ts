import { getToken } from '../api/client';

/**
 * 图片上传共享助手 — M1 验收修复轮从 RichPanel 提取（FR-EDT-020）。
 *
 * 上传与尺寸读取原为 RichPanel 私有实现；编辑态画布粘贴截图（FR-EDT-020 第三种
 * 插入方式之一）复用同一条链路，故提取为模块级纯函数。页面侧（两个调用方）统一
 * 负责 ≤200px 等比钳制与 10MB 前置拦截，服务端不解析像素。
 */

export const MAX_IMAGE_BYTES = 10 * 1024 * 1024;
export const IMAGE_MAX_EDGE = 200;

/** 读取图片自然尺寸（调用方负责 ≤200px 等比钳制，服务端不解析像素）。 */
export function readImageSize(file: File): Promise<{ w: number; h: number; url: string }> {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => resolve({ w: img.naturalWidth, h: img.naturalHeight, url });
    img.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error('图片解析失败'));
    };
    img.src = url;
  });
}

/** multipart 上传（api client 只发 JSON，这里单独用原生 fetch + Bearer）。 */
export async function uploadImage(fileId: string, file: File): Promise<{ key: string }> {
  const form = new FormData();
  form.append('file', file);
  const res = await fetch(`/api/files/${fileId}/images`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${getToken() ?? ''}` },
    body: form,
  });
  if (!res.ok) {
    const data = (await res.json().catch(() => ({}))) as { message?: string };
    throw new Error(data.message ?? `上传失败（${res.status}）`);
  }
  return (await res.json()) as { key: string };
}

/**
 * 从粘贴事件的剪贴板数据取第一张图片文件（FR-EDT-020 截图粘贴入口）。
 *
 * 优先 `clipboardData.files`；再并集扫一遍 `items`（kind==='file'）——部分 Windows
 * 应用只把位图挂在 items 上、files 为空，此时旧实现（只读 files）会静默吞掉粘贴。
 * 防御性兜底（根因在 keydown 层抑制了原生 paste 事件，见 keyboardMap 注释）。
 */
export function imageFileFromClipboard(data: DataTransfer | null): File | null {
  if (!data) return null;
  const fromFiles = Array.from(data.files ?? []).find((f) => f.type.startsWith('image/'));
  if (fromFiles) return fromFiles;
  for (const item of Array.from(data.items ?? [])) {
    if (item.kind === 'file' && item.type.startsWith('image/')) {
      const file = item.getAsFile();
      if (file) return file;
    }
  }
  return null;
}

/** ≤200px 等比钳制（FR-EDT-020）：至少 1px（0 尺寸图片不可见）。 */
export function clampImageSize(
  naturalW: number,
  naturalH: number,
): { w: number; h: number } {
  const ratio = Math.min(1, IMAGE_MAX_EDGE / Math.max(naturalW, naturalH));
  return {
    w: Math.max(1, Math.round(naturalW * ratio)),
    h: Math.max(1, Math.round(naturalH * ratio)),
  };
}

/**
 * 转 PNG（2026-10-20 图片右键复制）：系统剪贴板图片 MIME 只保证 PNG 可写
 * （Chrome 的 ClipboardItem 对 image/jpeg、image/webp 支持不一致）；服务端允许
 * png/jpeg/gif/webp，故非 PNG 一律经 canvas 转码，保证复制动作在三大浏览器一致。
 * 浏览器无 createImageBitmap / canvas 时抛错，由调用方 toast 两段式文案。
 */
export async function toPngBlob(blob: Blob): Promise<Blob> {
  if (blob.type === 'image/png') return blob;
  if (typeof createImageBitmap !== 'function') {
    throw new Error('当前浏览器不支持图片转码');
  }
  const bitmap = await createImageBitmap(blob);
  try {
    const canvas = document.createElement('canvas');
    canvas.width = bitmap.width;
    canvas.height = bitmap.height;
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('当前浏览器不支持 Canvas');
    ctx.drawImage(bitmap, 0, 0);
    return await new Promise<Blob>((resolve, reject) => {
      canvas.toBlob(
        (out) => (out ? resolve(out) : reject(new Error('图片转码失败'))),
        'image/png',
      );
    });
  } finally {
    bitmap.close?.();
  }
}
