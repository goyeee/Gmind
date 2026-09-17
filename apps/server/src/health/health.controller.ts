import { Controller, Get, Inject } from '@nestjs/common';
import { DataSource } from 'typeorm';

@Controller('api/health')
export class HealthController {
  // 显式 token 注入：tsx/esbuild 无法生成 design:paramtypes 元数据
  constructor(@Inject(DataSource) private readonly dataSource: DataSource) {}

  @Get()
  async check(): Promise<{ ok: boolean; db: boolean }> {
    await this.dataSource.query('SELECT 1');
    return { ok: true, db: true };
  }
}
