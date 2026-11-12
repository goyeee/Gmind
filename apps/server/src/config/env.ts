import { z } from 'zod';

const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().default(3000),
  DB_HOST: z.string().default('127.0.0.1'),
  DB_PORT: z.coerce.number().default(33061),
  DB_USER: z.string().default('root'),
  DB_PASSWORD: z.string().default('gminddev'),
  DB_DATABASE: z.string().default('gmind'),
  REDIS_URL: z.string().default('redis://127.0.0.1:16379/0'),
  // 本地磁盘图片存储根目录（一期 Provider；根 .gitignore 已忽略 .data/）
  STORAGE_DIR: z.string().default('./.data/storage'),
  DEV_SMS_CODE: z.string().default('123456'),
  // 协同网关（M2 Task 1）：onStoreDocument 防抖窗口与最长强制落库间隔（ms）。
  // 默认与 Hocuspocus 内置一致（2000/10000）；e2e 压低以加速回写断言。
  COLLAB_DEBOUNCE_MS: z.coerce.number().default(2000),
  COLLAB_MAX_DEBOUNCE_MS: z.coerce.number().default(10000),
  // 邮件（M3a Task 7 裁定）：SMTP 缺省不配置 → MailService 仅 log（M0 MailHog 容器未起的
  // 兜底口径，调用方照常落 notifications）；MailHog 就绪后补 env 即接通。
  SMTP_HOST: z.string().optional(),
  SMTP_PORT: z.coerce.number().optional(),
  // SMTP 认证与发件人（2026-11-12 账号体系重做）：USER/PASS 未配 → 匿名连接（本地
  // MailHog 同款）；production 四项必配（下方守卫 fail-closed）。from 默认维持一期占位值。
  SMTP_USER: z.string().optional(),
  SMTP_PASS: z.string().optional(),
  SMTP_FROM: z.string().default('Gmind <noreply@gmind.local>'),
  // 邮箱验证码开发固定码（2026-11-12 账号体系重做）：dev/test 恒用该值（e2e/本地联调可
  // 预判）；production 恒随机 6 位数字——EmailCodeService 的 production 分支不读本值，
  // 即使设置了也忽略。
  DEV_MAIL_CODE: z.string().default('123456'),
  // 邀请邮件（M3b Task 5，FR-SHR-004）注册链接基址：web dev 默认 5173，部署侧覆写。
  APP_URL: z.string().default('http://localhost:5173'),
  // 站内跳转基址（M4 清偿包）：摘要邮件条目的文档深链（${WEB_ORIGIN}/edit/:fileId）与
  // 正文尾部「打开 Gmind」行；缺省跟随本机 web dev 常用端口，部署侧覆写。
  WEB_ORIGIN: z.string().default('http://localhost:5174'),
});

export const env = envSchema.parse(process.env);

// 生产安全门禁（2026-10-28 P0）：DEV_SMS_CODE 是开发环境的固定验证码，生产漏配
// 就是「万能码可登任意手机号」——fail-closed：production 未显式设置直接拒绝启动，
// 强制部署者显式选择（设随机长串过渡 / 接真实短信通道）。与 dev-e2e 的
// devE2eAllowed 同款「缺省不放行」纪律。
if (env.NODE_ENV === 'production' && !process.env.DEV_SMS_CODE) {
  throw new Error(
    '[gmind] NODE_ENV=production 时必须显式配置 DEV_SMS_CODE（随机长串过渡；真实短信通道接好后移除），拒绝以开发固定验证码启动',
  );
}

// 生产安全门禁（2026-11-12 账号体系重做）：邮箱验证码在 production 经真实 SMTP 发信
// （注册/找回密码的唯一通道），缺任一配置 = 该流程全不可用——fail-closed 拒绝启动，
// 与上方 DEV_SMS_CODE 同款「缺省不放行」纪律。
if (
  env.NODE_ENV === 'production' &&
  (!env.SMTP_HOST || !env.SMTP_PORT || !env.SMTP_USER || !env.SMTP_PASS)
) {
  throw new Error(
    '[gmind] NODE_ENV=production 时必须配置 SMTP_HOST/SMTP_PORT/SMTP_USER/SMTP_PASS（邮箱验证码经真实 SMTP 发信），拒绝启动',
  );
}
