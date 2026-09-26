/**
 * 单价与成本估算。
 *
 * 为什么要有这个文件：用户会直接问"转文字和写笔记各花多少钱"。这个数字不该靠翻账单
 * 反推，也不该散落在各个模块里各写一份常量——**单价是同一份事实**，集中在这里，
 * 界面上显示的成本才和预算检查用的是同一套数。
 *
 * 两笔钱的口径完全不同：
 *   - 转写（阿里云百炼 Paraformer-v2 录音文件识别）：按**音频时长**计费，与字数无关。
 *     实测账单反推：¥0.0000791/秒 ≈ ¥0.285/小时（2026-09 对账，与默认值一致）。
 *     注意计费口径是"语音时长"——静音不算。9 月 26 日那节课：语音 8,880 秒、账单 ¥0.70。
 *   - 写笔记（DeepSeek deepseek-flash，即 deepseek-v4-flash）：
 *     按 token 计费，**输出 token 是大头**（思考模式的推理 token 也算输出）。
 *     官方价（美元/百万 token，2026-09）：缓存命中输入 $0.003、未命中输入 $0.15、输出 $0.6；
 *     低峰时段是高峰的一半——本项目的 economy 模式就是把自己排到低峰。
 *     折算成人民币（约 7.2）后取整为：¥0.02 / ¥1 / ¥4 每百万 token。
 *
 * 这些数字会随官方调价变化，所以全部可用环境变量覆盖，界面上显示的是"按当前单价估算"。
 */
export const DEFAULT_PRICING = {
  /** 语音识别：元/小时（按语音时长）。 */
  asrPerHourCny: 0.288,
  /** 笔记写作：元/百万 token。 */
  noteInputPerMillionCny: 1,
  noteCacheHitPerMillionCny: 0.02,
  noteOutputPerMillionCny: 4
}

function positiveNumber(value, fallback) {
  const parsed = Number(value)
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback
}

export function resolvePricing(env = {}) {
  return {
    asrPerHourCny: positiveNumber(env.COURSE_ASR_PRICE_PER_HOUR_CNY, DEFAULT_PRICING.asrPerHourCny),
    noteInputPerMillionCny: positiveNumber(env.COURSE_NOTE_PRICE_INPUT_PER_M_CNY, DEFAULT_PRICING.noteInputPerMillionCny),
    noteCacheHitPerMillionCny: positiveNumber(env.COURSE_NOTE_PRICE_CACHE_HIT_PER_M_CNY, DEFAULT_PRICING.noteCacheHitPerMillionCny),
    noteOutputPerMillionCny: positiveNumber(env.COURSE_NOTE_PRICE_OUTPUT_PER_M_CNY, DEFAULT_PRICING.noteOutputPerMillionCny)
  }
}

/** 语音识别费用：按秒数。 */
export function asrCostCny({ seconds = 0, pricing = DEFAULT_PRICING } = {}) {
  const value = Number(seconds || 0)
  if (!Number.isFinite(value) || value <= 0) return 0
  return value / 3600 * Number(pricing.asrPerHourCny || DEFAULT_PRICING.asrPerHourCny)
}

/**
 * 笔记写作费用：分开算"缓存命中的输入"与"未命中的输入"。
 *
 * 缓存命中价差两个数量级（¥0.02 对 ¥1），所以不能把输入揉成一个数——
 * 那会把成本算高好几成。
 */
export function noteCostCny({ inputTokens = 0, cachedTokens = 0, outputTokens = 0, pricing = DEFAULT_PRICING } = {}) {
  const input = Math.max(0, Number(inputTokens || 0))
  const cached = Math.min(input, Math.max(0, Number(cachedTokens || 0)))
  const fresh = Math.max(0, input - cached)
  const output = Math.max(0, Number(outputTokens || 0))
  const p = {
    input: Number(pricing.noteInputPerMillionCny ?? DEFAULT_PRICING.noteInputPerMillionCny),
    cache: Number(pricing.noteCacheHitPerMillionCny ?? DEFAULT_PRICING.noteCacheHitPerMillionCny),
    output: Number(pricing.noteOutputPerMillionCny ?? DEFAULT_PRICING.noteOutputPerMillionCny)
  }
  return (fresh * p.input + cached * p.cache + output * p.output) / 1e6
}

/** 把两笔钱合成一条可以显示、也可以汇总的记录。 */
export function lessonCost({ asrSeconds = 0, inputTokens = 0, cachedTokens = 0, outputTokens = 0, pricing = DEFAULT_PRICING } = {}) {
  const asr = asrCostCny({ seconds: asrSeconds, pricing })
  const notes = noteCostCny({ inputTokens, cachedTokens, outputTokens, pricing })
  return {
    asrCny: Number(asr.toFixed(4)),
    notesCny: Number(notes.toFixed(4)),
    totalCny: Number((asr + notes).toFixed(4))
  }
}

/** 金额显示：不到 1 元给三位小数，超过给两位——省得满屏 ￥0.00。 */
export function formatCny(value) {
  const amount = Number(value || 0)
  if (!Number.isFinite(amount)) return '—'
  if (amount === 0) return '¥0'
  return amount < 1 ? `¥${amount.toFixed(3)}` : `¥${amount.toFixed(2)}`
}
