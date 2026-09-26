export {
  buildTranscriptTextPack,
  writeTranscriptTextPack
} from './textpack.mjs'

export {
  COURSE_PIPELINE_ADAPTER_METHODS,
  createUnconfiguredCoursePipelineAdapter,
  validateCoursePipelineAdapter
} from './adapter-contract.mjs'

export { cleanText, transcriptLines } from './text.mjs'

// 单价与成本估算：转写按语音时长、笔记按 token，管理台与预算检查共用同一份
export {
  DEFAULT_PRICING,
  asrCostCny,
  formatCny,
  lessonCost,
  noteCostCny,
  resolvePricing
} from './pricing.mjs'

// 管理台登录：站点服务器（校验）与 worker（重设密码）共用同一份实现
export {
  clearPassword,
  hashPassword,
  passwordFile,
  readPasswordRecord,
  validatePassword,
  verifyPassword,
  writePassword
} from './admin-auth.mjs'
