import { ArgumentsHost, Catch, ExceptionFilter } from '@nestjs/common';
import type { Response } from 'express';
import { QuotaError } from '../files/files.service';

@Catch(QuotaError)
export class QuotaExceptionFilter implements ExceptionFilter {
  catch(exception: QuotaError, host: ArgumentsHost): void {
    host.switchToHttp().getResponse<Response>().status(403).json({ message: exception.message });
  }
}
