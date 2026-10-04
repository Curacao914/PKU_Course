/**
 * 站内检索的唯一一份「闸门 + 执行 + 出错」实现。
 *
 * 为什么单独抽出来：`/api/search` 有两个宿主——
 *   · 公开站点（3100 / 公开模式）：服务对象是发布库里的公开笔记；
 *   · 私有阅读站（3101 / 私有模式）：服务对象是当前账号的私有笔记。
 * 两者的**数据源**不同，但闸门必须完全一样：限流、并发、超时、查询长度这四道预算
 * 和 `/mcp` 共用同一本账。任何一条入口自己绕过预算，这套"账只有一本"的设计就漏了——
 * 一台 1.2G 的机器，绕开 MCP 直接刷站内搜索同样能打满。
 *
 * 所以这里只做与数据源无关的那一段：查长 → 取槽位 → 绑定生命周期 → 跑 → 翻译结果 /
 * 翻译失败。调用方只提供"怎么跑这一次检索"（run）。
 */

/** 两个入口共用的响应体：页面、MCP 与私有阅读站看到的是同一批字段、同一批链接。 */
export function searchPayload(found = {}) {
  return {
    ok: true,
    query: found.query,
    total: found.total,
    // coverage/escalated 分开报：前者说"用没用正文"，后者说"索引答不上来才翻的正文"，
    // 页面上那行提示说的是后者（本地库正文就在内存里，auto 每句都会用到它）
    coverage: found.coverage,
    escalated: found.escalated,
    // 语义回退：字面一条都没命中时才会 used=true。页面上必须把它标出来——
    // "按意思找的"和"字面对上的"可信度不一样，读者有权知道。
    semantic: found.semantic || { used: false, enabled: false },
    lexicalTotal: found.lexicalTotal ?? found.total,
    bodyScanned: found.bodyScanned,
    fuzzy: found.fuzzy,
    terms: found.terms,
    hits: (found.hits || []).map(hit => ({
      slug: hit.slug,
      url: `/${String(hit.slug).replace(/^\/+/, '')}.html`,
      // 小节锚点统一百分号编码：站点链接、MCP canonical URL、fetch 证据指向同一处
      anchor: hit.location?.id
        ? `/${String(hit.slug).replace(/^\/+/, '')}.html#${encodeURIComponent(hit.location.id)}`
        : '',
      courseName: hit.courseName,
      lessonTitle: hit.lessonTitle,
      lessonDate: hit.lessonDate,
      theme: hit.theme || '',
      keywords: (hit.keywords || []).slice(0, 6),
      section: hit.location?.title || '',
      sectionId: hit.location?.id || '',
      // 一篇里命中的多个小节（去重、配额）：页面可以显示"本文命中 2 处"
      sections: (hit.sections || []).map(item => ({ id: item.id, title: item.title, score: item.score })),
      // 语义命中的条目带 similarity，前端据此显示"像到什么程度"
      ...(hit.semantic ? { semantic: true, similarity: hit.similarity } : {}),
      snippets: hit.snippets
    }))
  }
}

/**
 * 跑一次受预算约束的检索。
 *
 * @returns 检索结果（已成功）或 null（响应已经发出去：400/429/503/504）。
 */
export async function runBudgetedSearch({
  req, res, send, query, budget, bindRequestLifecycle, unavailableMessage = '', run
} = {}) {
  if (!budget || !bindRequestLifecycle) {
    send(res, 503, { ok: false, error: 'search_unavailable', message: unavailableMessage || '请求预算不可用' })
    return null
  }
  // 长度预算放在取槽位之前：这种请求不该占用限流额度（它根本不是一次有效检索）
  const tooLong = budget.queryProblem(query)
  if (tooLong) {
    send(res, 400, { ok: false, error: 'query_too_long', message: tooLong })
    return null
  }
  // 与 /mcp 同一本账：绕开 MCP 直接刷搜索一样能把这台 1.2G 的机器打满
  const slot = budget.acquire({ key: budget.addressOf(req), label: 'search' })
  if (!slot.ok) {
    send(res, slot.status, { ok: false, error: slot.code, message: slot.message }, { 'retry-after': String(slot.retryAfter) })
    return null
  }
  const lifecycle = bindRequestLifecycle(req, res, slot)
  try {
    // 超时 / 客户端断开都会中止检索本身（signal 一路传到检索的记录循环）
    // 不写死 includeBody：覆盖策略由检索层统一决定（coverage='auto'），
    // 站内搜索、私有搜索与 MCP 因此拿到**同一批结果**。
    const outcome = await lifecycle.race(run({ signal: slot.signal }))
    if (outcome.kind === 'gone') return null
    if (outcome.kind === 'timeout') {
      if (lifecycle.canWrite()) {
        send(res, 504, {
          ok: false,
          error: 'search_timeout',
          message: `检索超时（超过 ${budget.limits.timeoutMs}ms）：已中止本次检索，请换更具体的词或缩小范围后重试。`
        }, { 'retry-after': '1' })
      }
      return null
    }
    return outcome.result
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    // 取消（客户端走了 / 预算到点）不是"查询写错了"，单独回 504
    if (error?.name === 'CancelledError') {
      if (lifecycle.canWrite()) {
        send(res, 504, { ok: false, error: 'search_timeout', message: '检索已中止（超时或客户端断开）。' }, { 'retry-after': '1' })
      }
      return null
    }
    if (!lifecycle.canWrite()) return null
    // 区分"查询本身没词/不合法"与"发布库读不到"：前者是调用方的问题（400），
    // 后者是站点的问题（503）——都报 400 会让人去改查询，白费功夫。
    const serverSide = /读不到发布库|发布库不是合法 JSON|发布库格式不对/.test(message)
    send(res, serverSide ? 503 : 400, {
      ok: false,
      error: serverSide ? 'library_unavailable' : 'search_failed',
      message
    })
    return null
  }
}
