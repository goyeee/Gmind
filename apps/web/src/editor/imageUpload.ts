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
