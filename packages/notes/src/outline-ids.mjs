/**
 * 「这个节点覆盖了哪些大纲模块」——统一入口。
 *
 * 背景：一次模型调用可以写完多个模块（writeUnits=1 时整节课就是一个 write unit）。
 * 这种合并节点的完整覆盖范围在 `outlineNodeIds`，而 `outlineNodeId` 只代表**第一个**模块。
 *
 * 历史 bug：brief、writer 任务、小节类型判定都只读 `outlineNodeId`，于是合并写的时候
 * 系统以为"这个节点只属于第一个大纲模块"——摘要被第一个模块支配、结构表只把第一模块
 * 标成"正在写"、二三四个模块拿不到目标与依据。正文本身是对的（装配读的是 outlineNodeIds），
 * 所以症状很隐蔽：正文没问题，摘要是错的。
 *
 * 因此：**任何"这个节点属于哪些大纲模块"的判断都必须走这里**，不要再直接比较单值。
 * 只关心"这个节点的主模块是谁"（例如日志、排序回退）时才用 primaryOutlineIdOf。
 */

/** 节点覆盖的全部大纲模块 id（去重、去掉空值）。合并节点返回全部，普通节点返回单元素数组。 */
export function outlineIdsOf(node = {}) {
  const ids = Array.isArray(node?.outlineNodeIds) ? node.outlineNodeIds : []
  const cleaned = ids.map(id => String(id || '').trim()).filter(Boolean)
  if (cleaned.length) return [...new Set(cleaned)]
  const primary = String(node?.outlineNodeId || '').trim()
  return primary ? [primary] : []
}

/** 主模块（第一个）：只用于展示/日志这类"需要一个代表"的场景。 */
export function primaryOutlineIdOf(node = {}) {
  return outlineIdsOf(node)[0] || ''
}

/** 这个节点是否覆盖了某个大纲模块——替代 `node.outlineNodeId === id`。 */
export function coversOutline(node = {}, outlineId = '') {
  const wanted = String(outlineId || '').trim()
  if (!wanted) return false
  return outlineIdsOf(node).includes(wanted)
}

/** 一个节点是否是"合并写"的（覆盖多个模块）。 */
export function isMergedWriteUnit(node = {}) {
  return outlineIdsOf(node).length > 1
}
