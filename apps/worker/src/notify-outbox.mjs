/**
 * 通知的 outbox：把"要发一条通知"这件事**写进发布库本身**，再在提交之后真正入队。
 *
 * 为什么不能直接"写完库就入队"：两者之间有一个崩溃窗口——进程在写库之后、入队之前挂掉
 * （OOM、断电、被 kill），这节课就永远不会有通知，而且**没有任何痕迹**（站点上有、微信上没有）。
 * 反过来"先入队再写库"更糟：库没写成，读者收到一条指向不存在页面的消息。
 *
 * 做法：把通知意图（去重键、正文、链接）作为 notifyPending 挂在**即将提交的那条记录**上，
 * 于是"内容"和"要通知"在同一次原子写里落地（library.json 的 tmp+rename 是提交点）。
 * 提交之后再入队、再把 notifyPending 抹掉。中途崩了，下一次任何一次 publish 都会看到
 * notifyPending 并补发——入队按 dedupeKey 去重，重复补发不会多发。
 *
 * 说清楚语义：**至少一次**（at-least-once），靠去重键做到不重复发。
 * 这里不声称 exactly-once：崩溃点不同，要么没发（有痕迹、可补），要么补发被去重吃掉。
 */

export const NOTIFY_POLICY = { CHANGED: 'changed', NONE: 'none' }

/**
 * 这次发布该不该排队通知。
 *
 * --no-notify 会**记进记录里**（notifyPolicy:'none'），之后重发这一篇（不显式 --notify）
 * 仍然不通知：批量换排版时"这次先别推"是人的决定，不该被下一次自动重跑悄悄推翻。
 */
export function resolveNotifyPolicy({ flag, stored } = {}) {
  if (flag === NOTIFY_POLICY.NONE) return { policy: NOTIFY_POLICY.NONE, reason: 'flag' }
  if (flag === NOTIFY_POLICY.CHANGED) return { policy: NOTIFY_POLICY.CHANGED, reason: 'flag' }
  if (stored === NOTIFY_POLICY.NONE) return { policy: NOTIFY_POLICY.NONE, reason: 'stored' }
  return { policy: NOTIFY_POLICY.CHANGED, reason: 'default' }
}

/**
 * 这一篇要不要生成通知意图（纯函数，便于单测与复查）。
 * 三个条件缺一不可：内容变了、策略允许、且这条内容还没有被通知过。
 */
export function planNotification({ changed, policy, slug, checksum, bodyText, objectUrl, alreadyNotified = false } = {}) {
  if (!changed) return null
  if (policy !== NOTIFY_POLICY.CHANGED) return null
  if (alreadyNotified) return null
  const key = `course-note:${slug}:${String(checksum || '').slice(0, 12)}`
  return { dedupeKey: key, purpose: 'course-note', bodyText, objectUrl, slug }
}

/** 库里所有"挂了通知意图但还没发出去"的记录（崩溃恢复用）。 */
export function pendingNotifications(records = []) {
  return (Array.isArray(records) ? records : [])
    .filter(record => record && record.notifyPending && record.notifyPending.dedupeKey)
    .map(record => ({ slug: record.slug, ...record.notifyPending }))
}

/** 入队成功后把记录上的意图抹掉（返回新数组；没有变化时原样返回）。 */
export function clearPending(records = [], slugs = [], { at = new Date().toISOString() } = {}) {
  const wanted = new Set(slugs)
  let changed = false
  const next = (Array.isArray(records) ? records : []).map(record => {
    if (!wanted.has(record.slug) || !record.notifyPending) return record
    changed = true
    const { notifyPending, ...rest } = record
    // 留下"什么时候排进队列的"：以后查"这条到底通知过没有"不用去翻账本
    return { ...rest, notifiedAt: record.notifiedAt || at }
  })
  return { records: next, changed }
}
