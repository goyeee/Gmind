/**
 * auth 域请求 schema（2026-11-12 重做改薄）：形状与邮箱归一（trim+lowercase）单点
 * 在 @gmind/shared（emailSchema），controller parse 后即进 service，服务端不再二次
 * 处理邮箱。旧 method 三分支登录体（phone/email/wechat）与 rememberMe/password
 * 包装层已随三 Provider 删除。
 */
export {
  emailCodeRequestSchema,
  loginSchema,
  passwordResetSchema,
  registerSchema,
} from '@gmind/shared';
