import { WECHAT_SESSION_MAX_AGE_MINUTES, wechatSessionState } from '@course/notify'

/**
 * 微信会话：过期判定，以及**能不能自动激活**的结论。
 *
 * 这条通道的规矩：用户给机器人发一次消息，平台随那条入站消息下发一个 context_token，
 * 出站必须原样带上；不带时接口照样返回 messageId，微信端却收不到（"已发送"是假的）。
 * 所以"最近互动多久了"不是背景信息，而是"现在能不能推"的判据——超过
 * WECHAT_SESSION_MAX_AGE_MINUTES（默认 12 小时）就算过期。
 *
 * ## 自动激活：**做不到**（2026-09 核实，依据如下）
 *
 * 想过在发送前自动把会话"重新激活"一次，结论是没有可靠的非交互式入口：
 *
 *   1. `openclaw channels login --channel openclaw-weixin` 走的是**扫码登录**——
 *      官方文档（openclaw/docs/channels/wechat.md）写得很清楚：
 *      "Scan the QR code with WeChat on your phone and confirm the login"。
 *      也就是说这一步必须有人拿手机扫，定时任务里跑它只会挂在那里等。
 *   2. context_token 由微信侧随**用户的入站消息**下发，存在网关进程里；
 *      CLI 侧没有"刷新/重建会话"的子命令——`message send|read`、`sessions`、
 *      `devices`、`pairing` 都不会产生新的 context_token。
 *   3. 本机部署里 CLI 因设备授权未批准而**回退到本地处理**（见 docs/03-微信推送故障诊断.md），
 *      本地实例根本没有这份凭证；要修得由人在 Control UI 里批准待处理设备（走 SSH 隧道）。
 *
 * 于是这里只做两件事：**判定**（说清楚过期没有）与**记录**（把结论写进运行摘要与
 * stderr，管理台的推送通道卡片也显示同一句话）。真正恢复会话的动作由人完成：
 * 给微信机器人发一条消息即可；若通道整体不可用，则按 deploy/README.md
 * 「会话过期：先显示清楚，再谈自动」一节的步骤重新扫码登录 / 批准设备。
 *
 * 管理台（apps/site/src/admin.mjs 的 describeWechatSession）显示同一句话；
 * 两处字符串保持一致（站点进程与 worker 是两条独立的进程，读不到彼此的模块）。
 */
export const WECHAT_REACTIVATION_HINT =
  '给微信机器人发一条消息即可恢复会话；OpenClaw 没有可自动重建会话的入口（需要人工扫码登录或批准设备，见 deploy/README.md「会话过期」）'

/** 结论的依据：写进日志与文档，别让"做不到"变成一句没根据的话。 */
export const WECHAT_ACTIVATION_EVIDENCE = [
  'openclaw channels login --channel openclaw-weixin 是扫码登录：必须有人拿手机扫，定时任务里跑它会一直挂着',
  'context_token 由微信随用户的入站消息下发（存在网关进程里），CLI 没有重建它的子命令',
  '本机 CLI 因设备授权未批准而回退到本地处理，本地实例没有这份凭证，需人工在 Control UI 批准设备'
]

/**
 * 会话时长说人话。
 *
 * 23 小时就是 23 小时——让用户自己去算"这算不算过期"是把判断推给了人，
 * 而"超过 12 小时就算过期"是代码里已经存在的规则。
 */
export function formatSessionAge(ageMinutes) {
  const minutes = Math.max(0, Math.round(Number(ageMinutes) || 0))
  if (minutes < 60) return `${minutes} 分钟前`
  return `${Math.round(minutes / 60)} 小时前`
}

/**
 * 把会话状态的原始数字翻成人话（过期与否、多久没互动、阈值多少）。
 *
 * @returns {{ok:boolean, fresh:boolean, expired:boolean, ageMinutes:number, ageText:string,
 *           limitHours:number, summary:string, reason?:string}}
 */
export function describeWechatSession({ session = {}, maxAgeMinutes = WECHAT_SESSION_MAX_AGE_MINUTES } = {}) {
  const limitHours = Math.round(Number(maxAgeMinutes || WECHAT_SESSION_MAX_AGE_MINUTES) / 60)
  if (!session.ok) {
    return {
      ok: false,
      fresh: false,
      expired: false,
      ageMinutes: null,
      ageText: '',
      limitHours,
      summary: '不可用',
      reason: session.reason || '没有会话记录'
    }
  }
  const ageMinutes = Math.max(0, Math.round(Number(session.ageMinutes) || 0))
  const fresh = ageMinutes <= maxAgeMinutes
  const ageText = formatSessionAge(ageMinutes)
  return {
    ok: true,
    fresh,
    expired: !fresh,
    ageMinutes,
    ageText,
    limitHours,
    // 过期时把"多久没互动"和"超过多少算过期"放在同一句里，不用用户自己减
    summary: fresh ? `最近互动 ${ageText}` : `已过期（超过 ${limitHours} 小时）：最近互动 ${ageText}`
  }
}

/**
 * 「要不要自动激活、能不能自动激活」的判定结果。
 *
 * 注意 `attempted` 永远是 false：见文件顶部结论——没有可用的非交互式入口。
 * 返回结构里保留这个字段，是为了让调用方（cycle / notify / 管理台）拿到的是
 * 一个**说清楚做了什么的记录**，而不是一句没有来源的话。
 */
export function wechatActivationPlan({ session = {}, maxAgeMinutes = WECHAT_SESSION_MAX_AGE_MINUTES } = {}) {
  const state = describeWechatSession({ session, maxAgeMinutes })
  if (!state.ok) {
    return {
      needed: true, expired: false, attempted: false, ok: false,
      reason: `无法判断会话状态：${state.reason}`, hint: WECHAT_REACTIVATION_HINT,
      evidence: WECHAT_ACTIVATION_EVIDENCE, session: state
    }
  }
  if (!state.expired) {
    return {
      needed: false, expired: false, attempted: false, ok: true,
      reason: '会话仍在有效期内', hint: '', evidence: [], session: state
    }
  }
  return {
    needed: true,
    expired: true,
    // 不假装试过：没有可用的非交互式入口，跑一条只会挂住定时任务
    attempted: false,
    ok: false,
    reason: `会话已过期（${state.summary}），且 OpenClaw 没有可自动重建会话的入口`,
    hint: WECHAT_REACTIVATION_HINT,
    evidence: WECHAT_ACTIVATION_EVIDENCE,
    session: state
  }
}

/**
 * 读一次会话状态并给出判定。
 *
 * 状态目录与 HOME 从配置里来（deploy/*.service 里设的就是这两个），
 * now 可注入——测试要能用固定时钟判定过期。
 */
export function checkWechatActivation({
  stateDir = '', home = '', now = Date.now(), maxAgeMinutes = WECHAT_SESSION_MAX_AGE_MINUTES
} = {}) {
  const session = wechatSessionState({ stateDir, home, now })
  return wechatActivationPlan({ session, maxAgeMinutes })
}
