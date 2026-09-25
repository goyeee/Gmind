import { BadRequestException, Injectable } from '@nestjs/common';
import { promises as fsp } from 'node:fs';
import * as path from 'node:path';
import { env } from '../config/env';

/** 存储抽象（spec §5.8：一期本地磁盘，MinIO 二期换实现，接口不变）。 */
export interface StorageProvider {
  put(key: string, data: Buffer, contentType: string): Promise<void>;
  get(key: string): Promise<{ data: Buffer; contentType: string } | null>;
  /** 服务端对象复制（Task 15 FR-EDT-010：跨文件粘贴图片随迁）。源不存在时实现层抛错。 */
  copy(key: string, newKey: string): Promise<void>;
  /** 前缀递归删除（M3a Task 7 回收站彻底删除，FR-FIL-007）：前缀下全部对象移除；
   *  前缀不存在时静默成功（多数文件无图片，purge 不能因此失败）。 */
  deletePrefix(prefix: string): Promise<void>;
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

  /** read+put 语义即本地盘 copyFile；目标父目录先建（与 put 对齐，copyFile 不会自建目录），
   *  源 ENOENT 向上传播，由服务层映射 404。 */
  async copy(key: string, newKey: string): Promise<void> {
    const dst = this.resolve(newKey);
    await fsp.mkdir(path.dirname(dst), { recursive: true });
    await fsp.copyFile(this.resolve(key), dst);
  }

  /** 递归删目录（deletePrefix 的 LocalDisk 实现）：resolve 越界防御与 get 同源；
   *  空前缀会解析到根目录本身（rm 根 = 清空整个存储），显式拒绝；force 使前缀不存在
   *  （ENOENT）静默成功。 */
  async deletePrefix(prefix: string): Promise<void> {
    if (!prefix) throw new BadRequestException('非法的存储键');
    const full = this.resolve(prefix);
    if (full === this.root) throw new BadRequestException('非法的存储键');
    await fsp.rm(full, { recursive: true, force: true });
  }
}
