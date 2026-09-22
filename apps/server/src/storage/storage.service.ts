import {
  BadRequestException,
  Inject,
  Injectable,
  NotFoundException,
  PayloadTooLargeException,
  UnsupportedMediaTypeException,
} from '@nestjs/common';
import { ulid } from 'ulid';
import { IMAGE_EXT_CONTENT_TYPES, LocalDiskProvider, type StorageProvider } from './local-disk.provider';

/** 单图大小上限 10MB（spec：超限 413）。同时作为 multer 内存缓冲的硬顶（FileInterceptor limits），防超限请求整包进内存。 */
export const MAX_IMAGE_BYTES = 10 * 1024 * 1024;
/** 413 统一文案：StorageService 校验与 multer 限制（经 MulterExceptionFilter 映射）共用。 */
export const IMAGE_TOO_LARGE_MESSAGE = '图片大小超出 10MB 限制';

/** 按魔数识别图片扩展名（显式字节校验，白名单外返回 null）：png \x89PNG / jpg \xFF\xD8\xFF / gif GIF8 / webp RIFF....WEBP。 */
function detectImageExt(buf: Buffer): string | null {
  if (buf.length >= 4 && buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) return 'png';
  if (buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'jpg';
  if (buf.length >= 4 && buf[0] === 0x47 && buf[1] === 0x49 && buf[2] === 0x46 && buf[3] === 0x38) return 'gif';
  if (
    buf.length >= 12 &&
    buf[0] === 0x52 && buf[1] === 0x49 && buf[2] === 0x46 && buf[3] === 0x46 && // 'RIFF'
    buf[8] === 0x57 && buf[9] === 0x45 && buf[10] === 0x42 && buf[11] === 0x50 // 偏移 8 起 'WEBP'
  ) {
    return 'webp';
  }
  return null;
}

@Injectable()
export class StorageService {
  constructor(
    // tsx 不发射装饰器元数据，类 token 注入必须显式 @Inject（约定见任务说明）
    @Inject(LocalDiskProvider) private readonly provider: StorageProvider,
  ) {}

  /** 校验大小与魔数 → 生成键 files/{fileId}/{ulid}.{ext} → 落盘。尺寸 w/h 由前端读取，服务端不解析像素。 */
  async saveImage(fileId: string, data: Buffer): Promise<{ key: string }> {
    if (data.length > MAX_IMAGE_BYTES) {
      throw new PayloadTooLargeException(IMAGE_TOO_LARGE_MESSAGE);
    }
    const ext = detectImageExt(data);
    if (!ext) {
      throw new UnsupportedMediaTypeException('不支持的图片格式');
    }
    // fileId 直接拼进磁盘键，拒绝路径成分（路由参数已被 URL 解码，须防 '..%2F' 穿越）
    if (!fileId || fileId.includes('/') || fileId.includes('\\') || fileId.includes('..')) {
      throw new BadRequestException('非法的文件标识');
    }
    const key = `files/${fileId}/${ulid()}.${ext}`;
    await this.provider.put(key, data, IMAGE_EXT_CONTENT_TYPES[ext]);
    return { key };
  }

  /** 键安全校验（拒绝 '..'）→ 扩展名白名单 → 读盘；不存在映射 404。 */
  async getImage(key: string): Promise<{ data: Buffer; contentType: string }> {
    if (!key || key.includes('..')) {
      throw new BadRequestException('非法的存储键');
    }
    const contentType = IMAGE_EXT_CONTENT_TYPES[key.slice(key.lastIndexOf('.') + 1)];
    if (!contentType) {
      throw new BadRequestException('非法的存储键');
    }
    const image = await this.provider.get(key);
    if (!image) {
      throw new NotFoundException('图片不存在');
    }
    return image;
  }

  /**
   * 对象复制（Task 15 FR-EDT-010：跨文件粘贴图片随迁重传）。key 校验与 getImage
   * 同口径（宽松：格式合法〔扩展名白名单〕+ 无 '..'）；新键 = files/{fileId}/{ulid}.{ext}
   * （fileId 校验同 saveImage，拒绝路径成分）。源不存在映射 404。
   */
  async copyImage(fileId: string, sourceKey: string): Promise<{ key: string }> {
    if (!fileId || fileId.includes('/') || fileId.includes('\\') || fileId.includes('..')) {
      throw new BadRequestException('非法的文件标识');
    }
    if (!sourceKey || sourceKey.includes('..')) {
      throw new BadRequestException('非法的存储键');
    }
    const ext = sourceKey.slice(sourceKey.lastIndexOf('.') + 1);
    if (!IMAGE_EXT_CONTENT_TYPES[ext]) {
      throw new BadRequestException('非法的存储键');
    }
    const source = await this.provider.get(sourceKey);
    if (!source) {
      throw new NotFoundException('图片不存在');
    }
    const newKey = `files/${fileId}/${ulid()}.${ext}`;
    await this.provider.copy(sourceKey, newKey);
    return { key: newKey };
  }
}
