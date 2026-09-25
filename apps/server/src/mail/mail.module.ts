import { Module } from '@nestjs/common';
import { MailService } from './mail.service';

// 无状态 provider，独立成模块供 jobs（清理提醒）与后续通知中心（M4）复用
@Module({
  providers: [MailService],
  exports: [MailService],
})
export class MailModule {}
