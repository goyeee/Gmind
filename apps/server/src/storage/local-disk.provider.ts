import { BadRequestException, Injectable } from '@nestjs/common';
import { promises as fsp } from 'node:fs';
import * as path from 'node:path';
import { env } from '../config/env';

/** 存储抽象（spec §5.8：一期本地磁盘，MinIO 二期换实现，接口不变）。 */
export interface StorageProvider {
  put(key: string, data: Buffer, contentType: string): Promise<void>;
  get(key: string): Promise<{ data: Buffer; contentType: string } | null>;
}

/** 扩展名 → Content-Type 白名单（键由 StorageService 生成，扩展名必属白名单；读回据此回填）。 */
export const IMAGE_EXT_CONTENT_TYPES: Record<string, string> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
};

/** 一期实现：STORAGE_DIR 下的普通文件，键即相对路径。 */
@Injectable()
export class LocalDiskProvider implements StorageProvider {
  private readonly root = path.resolve(env.STORAGE_DIR);

  /** key → 磁盘绝对路径，并确保结果不越出根目录（纵深防御；服务层已先行拒绝含 '..' 的 key）。 */
  private resolve(key: string): string {
    const full = path.resolve(this.root, key);
    if (full !== this.root && !full.startsWith(this.root + path.sep)) {
      throw new BadRequestException('非法的存储键');
    }
    return full;
  }

  async put(key: string, data: Buffer, _contentType: string): Promise<void> {
    // 本地盘不持久化 contentType，读回时按扩展名白名单回填（键为服务端生成，扩展名恒在白名单内）
    void _contentType;
    const full = this.resolve(key);
    await fsp.mkdir(path.dirname(full), { recursive: true });
    await fsp.writeFile(full, data);
  }

  async get(key: string): Promise<{ data: Buffer; contentType: string } | null> {
    const full = this.resolve(key);
    const ext = key.slice(key.lastIndexOf('.') + 1);
    const contentType = IMAGE_EXT_CONTENT_TYPES[ext] ?? 'application/octet-stream';
    try {
      const data = await fsp.readFile(full);
      return { data, contentType };
    } catch {
      return null; // ENOENT 等一律按不存在处理，由服务层映射 404
    }
  }
}
