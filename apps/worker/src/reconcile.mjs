/**
 * 无人值守下的"只报异常"对账（Phase 5.2 C2）。
 *
 * 定时任务最容易犯的错不是漏报，而是**天天报一堆正常状态**：日报里 90% 的篇幅在说
 * "今天一切正常"，人第三天就不看了，第四天真出事时没人注意。所以这里的规则是：
 * 只输出**需要人做的事**；没有异常时一个字都不说（`quiet: true`）。
 *
 * 异常来自已经存在、但散在几个地方的事实：
 *   · 账本里卡住/停下的任务（needs_attention、卡在某个阶段太久）
 *   · 投递失败、投递租约过期（通知静默消失）
 *   · 派生产物与正文不同源（C1 的 artifact-inventory：旧简报/一页纸/整合）
 *   · 缺课件的课次（不补课件就不会自动跑）
 *   · 余额偏低
 * 这个模块把它们收敛成一张清单，**不新增任何采集逻辑**——采集在各自的命令里，
 * 这里只做"哪些是异常"的判断，因此可以纯函数单测。
 */

const str = value => String(value ?? '')

/**
 * 一条异常的形状：{ level, code, message, count, detail }
 * level 只有两档：
 *   blocking —— 需要人处理，否则这件事不会自己好（卡住的任务、失败的通知、缺课件）
 *   warning  —— 建议看一眼，但不影响今天的产出（产物过期、余额偏低）
 */
export function collectExceptions ({
  stuckTasks = [],
  failedDeliveries = [],
  stuckDeliveries = 0,
  artifacts = null,
  missingMaterials = [],
  lowBalance = null
} = {}) {
  const exceptions = []

  if (stuckTasks.length) {
    exceptions.push({
      level: 'blocking',
      code: 'task-stuck',
      count: stuckTasks.length,
      message: `${stuckTasks.length} 个课次停在需要处理的状态`,
      detail: stuckTasks.slice(0, 5).map(task => `${task.courseName || ''}·${task.lessonTitle || task.replayKey || ''}（${task.stage}）`).join('；')
    })
  }

  if (failedDeliveries.length) {
    exceptions.push({
      level: 'blocking',
      code: 'delivery-failed',
      count: failedDeliveries.length,
      message: `${failedDeliveries.length} 条通知发送失败（已达重试上限）`,
      detail: failedDeliveries.slice(0, 3).map(item => `${item.dedupe_key}：${str(item.last_error).slice(0, 60)}`).join('；')
    })
  }

  if (Number(stuckDeliveries) > 0) {
    exceptions.push({
      level: 'blocking',
      code: 'delivery-stuck',
      count: Number(stuckDeliveries),
      message: `${stuckDeliveries} 条通知被领走但租约已过期（可能静默消失）`,
      detail: '发送进程可能崩了；下次 notify 会自动重新领取，若反复出现要查发送通道'
    })
  }

  const staleArtifacts = artifacts?.items?.filter(item => item.status === 'stale') || []
  if (staleArtifacts.length) {
    exceptions.push({
      level: 'warning',
      code: 'artifact-stale',
      count: staleArtifacts.length,
      message: `${staleArtifacts.length} 件派生产物与正文不同源（下次发布可能被"不同源"拦住）`,
      detail: staleArtifacts.slice(0, 5).map(item => `${item.kind} ${item.courseName}·${item.lessonTitle}`).join('；')
    })
  }

  const missingArtifacts = artifacts?.items?.filter(item => item.status === 'missing') || []
  if (missingArtifacts.length) {
    exceptions.push({
      level: 'warning',
      code: 'artifact-missing',
      count: missingArtifacts.length,
      message: `${missingArtifacts.length} 件长期配置的派生产物缺失`,
      detail: missingArtifacts.slice(0, 5).map(item => `${item.integrationId || item.kind} ${item.courseName}·${item.lessonTitle}`).join('；')
    })
  }

  if (missingMaterials.length) {
    exceptions.push({
      level: 'blocking',
      code: 'materials-missing',
      count: missingMaterials.length,
      message: `${missingMaterials.length} 个课次缺课件（不补就不会自动跑）`,
      detail: missingMaterials.slice(0, 5).map(item => `${item.courseName || ''}·${item.lessonTitle || ''}`).join('；')
    })
  }

  if (lowBalance) {
    exceptions.push({
      level: 'warning',
      code: 'balance-low',
      count: 1,
      message: `${lowBalance.provider || '某个付费接口'}余额偏低${lowBalance.amount === undefined ? '' : `（¥${lowBalance.amount}）`}`,
      detail: lowBalance.detail || ''
    })
  }

  const counts = {
    blocking: exceptions.filter(item => item.level === 'blocking').length,
    warning: exceptions.filter(item => item.level === 'warning').length
  }
  return {
    exceptions,
    counts,
    // 没有异常时**一个字都不说**：定时任务的价值在于"安静"，天天报正常就没人看了
    quiet: exceptions.length === 0,
    blocking: counts.blocking > 0
  }
}

/** 给人看的一段话（没有异常时返回空串，让调用方自己决定要不要输出）。 */
export function formatExceptions (report = { exceptions: [], counts: {} }) {
  if (!report.exceptions?.length) return ''
  const lines = [`需要处理：${report.counts.blocking} 项阻塞 / ${report.counts.warning} 项提醒`]
  for (const item of report.exceptions) {
    lines.push(`  [${item.level}] ${item.code}：${item.message}`)
    if (item.detail) lines.push(`      ${item.detail}`)
  }
  return lines.join('\n')
}
