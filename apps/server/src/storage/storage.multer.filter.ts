import { ArgumentsHost, Catch, ExceptionFilter, PayloadTooLargeException } from '@nestjs/common';
import type { Response } from 'express';
import { MulterError } from 'multer';
import { IMAGE_TOO_LARGE_MESSAGE } from './storage.service';

/**
 * FileInterceptor 的 multer 大小拒收统一映射为 413 契约文案。
 * Nest 10 platform-express 已在拦截器内把 MulterError(LIMIT_FILE_SIZE) 转成
 * PayloadTooLargeException（消息为 multer 默认的英文 'File too large'），故须同时捕获两种形态：
 * - PayloadTooLargeException：改写为统一文案（应用内该异常唯一来源即图片超限，含 StorageService 兜底路径，改写幂等）；
 * - MulterError：防御性兜底（无转换的版本/路径），按错误码映射。
 */
@Catch(MulterError, PayloadTooLargeException)
export class MulterExceptionFilter implements ExceptionFilter {
  catch(exception: MulterError | PayloadTooLargeException, host: ArgumentsHost): void {
    const fileSizeReject =
      exception instanceof MulterError ? exception.code === 'LIMIT_FILE_SIZE' : true;
    const res = host.switchToHttp().getResponse<Response>();
    if (fileSizeReject) {
      res.status(413).json({ message: IMAGE_TOO_LARGE_MESSAGE });
      return;
    }
    // 其余 multer 错误（字段名不符、超字段数等）均属请求方问题
    res.status(400).json({ message: exception.message });
  }
}
