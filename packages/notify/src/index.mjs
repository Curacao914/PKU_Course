export {
  DEFAULT_PUBLIC_URL,
  absoluteObjectUrl,
  buildDeliveryMessage,
  chooseChannel,
  createFallbackSender,
  createResilientSender,
  createWechatSender,
  deliveryLinkLabel,
  plainTextForChannel,
  runDeliveryCycle
} from './sender.mjs'

// 主通道（微信机器人）的会话状态：出站要带用户来信时拿到的 context_token，
// 没有它接口也会返回成功，但消息到不了微信。这条判断站点与管理台共用。
export { WECHAT_SESSION_MAX_AGE_MINUTES, wechatSessionState } from './session.mjs'
