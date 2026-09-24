import { cleanText, transcriptLines } from '@course/core'

import { buildPrompt, callCourseModel } from './ai-adapter.mjs'
// 审查只回答"要不要重写这一段"，不再有五项评分，因此这里也不需要量纲归一化。

/**
 * 角色执行器：把"该做什么"翻译成一次模型调用，并返回可落库的动作。
 *
 * 从 my-blog-main 的 lib/course/onlineRunner.js 摘出。它只做三件事：
 * 组装该角色的提示词、校验模型输出、返回动作对象。真正改状态的是调用方
 * （node-lifecycle 的迁移函数），因此这里没有任何持久化依赖。
 *
 * 与旧实现的两处差异：
 *   1. 模型调用可注入（options.callModel），测试不需要网络；
 *   2. 大纲覆盖修复的兜底节点保留，但修复失败不再静默——修复轨迹里会留下
 *      modelRepairNodeCount=0 与 fallbackGaps，便于事后判断是谁补的。
 */

// 行定义只有一处实现（@course/core）：给大纲编号、判大纲覆盖、切节点原文必须同源。
export { transcriptLines }

/** 给转录加绝对行号 [Lx]：大纲与节点的 lineRange 都以它为准。 */
export function numberTranscript(text, range = null) {
  const lines = transcriptLines(text)
  const start = Math.max(1, Number(range?.[0] || 1))
  const end = Math.min(lines.length, Math.max(start, Number(range?.[1] || lines.length)))
  return lines.slice(start - 1, end).map((line, index) => `[L${start + index}] ${line}`).join('\n')
}

export function validateOutline(value) {
  if (!value || typeof value.mainLine !== 'string' || !Array.isArray(value.outline) || !value.outline.length) {
    throw new Error('大纲生成结果格式无效')
  }
  value.outline.forEach((node, index) => {
    if (!node?.title || !Array.isArray(node.lineRange) || node.lineRange.length !== 2) {
      throw new Error(`大纲第 ${index + 1} 个节点格式无效`)
    }
  })
  return value
}

export function validateMarkdown(value) {
  if (!value || typeof value.markdown !== 'string' || !value.markdown.trim()) {
    throw new Error('正文生成结果为空')
  }
  return value
}

export function validateReview(value) {
  // human_review 仍被接受：模型有沿用这个词的习惯，而链路是全自动的，
  // 判定看的是 issues 里有没有 blocking，不看它自报的 decision。
  // 直接报错会让一次本来有内容的审查白白作废并重试一次。
  if (!value || !['approve', 'revise', 'human_review'].includes(value.decision)) {
    throw new Error('审查结果无效')
  }
  value.summary = cleanText(value.summary || '')
  value.issues = (Array.isArray(value.issues) ? value.issues : []).map((issue, index) => ({
    id: issue?.id || `issue-${index + 1}`,
    type: cleanText(issue?.type || 'review_note'),
    severity: ['blocking', 'important', 'suggestion'].includes(issue?.severity) ? issue.severity : 'important',
    message: cleanText(issue?.message || issue?.detail || ''),
    nodeId: cleanText(issue?.nodeId || ''),
    sourceRange: cleanText(issue?.sourceRange || '')
  })).filter(issue => issue.message)
  return value
}

/** 接缝数据校验：兼容模型可能给出的 snake_case 与 camelCase 命名。 */
export function validateSpliceData(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('单课接缝数据格式无效')
  const courseOverview = value.courseOverview || value.course_overview || {}
  const sectionSummaries = value.sectionSummaries || value.h1Summaries || value.h1_summaries || {}
  const sectionQuizzes = value.sectionQuizzes || value.h1Quizzes || value.h1_quizzes || {}
  const knowledgeLink = value.knowledgeLink || value.knowledge_link || {}
  return {
    courseOverview: {
      coreQuestions: Array.isArray(courseOverview.coreQuestions)
        ? courseOverview.coreQuestions
        : (courseOverview.core_questions || []),
      shouldBeAbleTo: Array.isArray(courseOverview.shouldBeAbleTo)
        ? courseOverview.shouldBeAbleTo
        : (courseOverview.should_be_able_to || []),
      lectureThread: cleanText(courseOverview.lectureThread || courseOverview.lecture_thread || '')
    },
    sectionSummaries: sectionSummaries && typeof sectionSummaries === 'object' ? sectionSummaries : {},
    sectionQuizzes: sectionQuizzes && typeof sectionQuizzes === 'object' ? sectionQuizzes : {},
    knowledgeLink: {
      inheritsFrom: cleanText(knowledgeLink.inheritsFrom || knowledgeLink.inherits_from || ''),
      laysGroundworkFor: Array.isArray(knowledgeLink.laysGroundworkFor)
        ? knowledgeLink.laysGroundworkFor
        : (knowledgeLink.lays_groundwork_for || []),
      nextLessonPreview: cleanText(knowledgeLink.nextLessonPreview || knowledgeLink.next_lesson_preview || '')
    },
    appendix: value.appendix && typeof value.appendix === 'object' ? value.appendix : {}
  }
}

/**
 * 生成交给接缝模型的占位骨架。
 *
 * 关键点：节点正文**不**提供给接缝模型——正文已逐一审查通过，接缝模型没有机会
 * 改写、压缩或重述它们。它只看到标题与"此处由程序机械拼接"的说明。
 */
export function splicePlaceholderContext(lesson = {}) {
  const outline = lesson.outline || []
  const byOutline = new Map(outline.map(node => [node.id, []]))
  ;(lesson.nodes || []).forEach(node => {
    if (byOutline.has(node.outlineNodeId)) byOutline.get(node.outlineNodeId).push(node)
  })
  const lines = [`# ${lesson.title || '单课笔记'}`, '', '{{COURSE_OVERVIEW}}', '', '***']
  outline.forEach(node => {
    lines.push('', `### ${node.title || node.id}`, `{{H1_SUMMARY:${node.id}}}`)
    ;(byOutline.get(node.id) || []).forEach(child => {
      lines.push(`[已批准节点：${child.title}；正文由程序机械拼接，不提供给接缝模型]`)
    })
    lines.push(`{{H1_QUIZ:${node.id}}}`, '', '***')
  })
  lines.push('', '{{APPENDIX}}', '', '{{KNOWLEDGE_LINK}}', '', '***', '', '[META 由程序从节点正文抽取并合并]')
  return lines.join('\n')
}

function normalizeRange(node, index, lineCount) {
  const raw = Array.isArray(node?.lineRange) ? node.lineRange : [1, 1]
  const start = Math.min(lineCount, Math.max(1, Number(raw[0] || 1)))
  const end = Math.min(lineCount, Math.max(start, Number(raw[1] || start)))
  return {
    ...node,
    id: node.id || `outline-node-${String(index + 1).padStart(2, '0')}`,
    lineRange: [start, end]
  }
}

/** 找出大纲未覆盖的行区间。返回空数组表示覆盖完整。 */
export function findOutlineCoverageGaps(outline = [], lineCount = 0) {
  if (!lineCount) return []
  const ranges = outline
    .map(node => (Array.isArray(node?.lineRange) ? node.lineRange.map(Number) : null))
    .filter(range => range && Number.isFinite(range[0]) && Number.isFinite(range[1]))
    .map(([start, end]) => [Math.max(1, start), Math.min(lineCount, Math.max(start, end))])
    .sort((a, b) => a[0] - b[0])

  const gaps = []
  let coveredUntil = 0
  ranges.forEach(([start, end]) => {
    if (start > coveredUntil + 1) gaps.push([coveredUntil + 1, start - 1])
    coveredUntil = Math.max(coveredUntil, end)
  })
  if (coveredUntil < lineCount) gaps.push([coveredUntil + 1, lineCount])
  return gaps
}

function fallbackGapNode([start, end], index) {
  return {
    id: `outline-coverage-${start}-${end}`,
    title: `待确认内容（第 ${start}—${end} 行）`,
    lineRange: [start, end],
    slideRange: [1, 1],
    rationale: '生成大纲时这一段未被原节点覆盖，系统已保留全部材料，请调整标题或与相邻节点合并。',
    importance: 'normal',
    concepts: [],
    statutes: [],
    cases: [],
    keySignals: ['coverage-repair'],
    writerBrief: '完整梳理这一范围内的课堂内容，避免遗漏。',
    coverageRepairIndex: index + 1
  }
}

/**
 * 合并大纲并保证覆盖：模型修复的节点与原节点一起排序，剩余缺口用占位节点补上。
 * 占位节点不是"假装完成"——它带着明确的标题与说明，让人一眼看出这里需要处理。
 */
export function mergeAndCoverOutline(outline, lineCount) {
  const normalized = (outline || []).map((node, index) => normalizeRange(node, index, lineCount))
  const gaps = findOutlineCoverageGaps(normalized, lineCount)
  const merged = [...normalized, ...gaps.map(fallbackGapNode)]
    .sort((a, b) => a.lineRange[0] - b.lineRange[0] || a.lineRange[1] - b.lineRange[1])
  return { outline: merged, fallbackGaps: gaps }
}

async function repairOutlineGaps({ task, value, lineCount, initialTrace, modelConfig, callModel }) {
  const normalized = value.outline.map((node, index) => normalizeRange(node, index, lineCount))
  const initialGaps = findOutlineCoverageGaps(normalized, lineCount)
  if (!initialGaps.length) {
    return { value: { ...value, outline: normalized }, trace: initialTrace }
  }

  let repairedNodes = []
  let repairTrace = null
  try {
    const gapSource = initialGaps
      .map(([start, end]) => `## 缺口 [L${start}-L${end}]\n${numberTranscript(task.lesson.transcript, [start, end])}`)
      .join('\n\n')
    const repairResult = await callModel({
      config: modelConfig,
      role: 'outlineRepair',
      prompt: buildPrompt({
        role: 'outlineRepair',
        promptVersion: `${task.courseSpec?.promptVersion || 'course-workflow-v3'}-coverage-repair`,
        courseSpec: task.courseSpec,
        lessonBlueprint: {
          title: task.lesson.title,
          transcriptLineCount: lineCount,
          existingOutline: normalized.map(node => ({ title: node.title, lineRange: node.lineRange })),
          coverageGaps: initialGaps,
          instruction: '只为 coverageGaps 生成补充节点。lineRange 必须使用 TranscriptSource 中的绝对 [Lx] 行号，并完整覆盖每个缺口。'
        },
        sourceText: gapSource,
        pptText: '',
        schema: {
          mainLine: 'string',
          outline: [{
            title: 'string',
            lineRange: [1, Math.min(200, lineCount)],
            slideRange: [1, 1],
            rationale: 'string',
            importance: 'high|normal|low',
            concepts: [],
            statutes: [],
            cases: []
          }]
        }
      })
    })
    repairedNodes = validateOutline(repairResult.parsed).outline
      .map((node, index) => normalizeRange(node, normalized.length + index, lineCount))
      .filter(node => initialGaps.some(([start, end]) => node.lineRange[0] <= end && node.lineRange[1] >= start))
    repairTrace = repairResult.trace
  } catch {
    repairedNodes = []
  }

  const { outline, fallbackGaps } = mergeAndCoverOutline([...normalized, ...repairedNodes], lineCount)
  return {
    value: { ...value, outline },
    trace: {
      ...initialTrace,
      coverageRepair: {
        initialGaps,
        modelRepairNodeCount: repairedNodes.length,
        fallbackGaps,
        repairTrace
      }
    }
  }
}

/**
 * 执行一个任务，返回"动作"而不是直接改状态。
 *
 * 动作类型：save-outline / save-node-draft-worker / save-node-review /
 * assemble / save-final-note-revision / complete-final-review / plan-nodes。
 */
export async function executeCourseTask(task, options = {}) {
  if (!task || task.type === 'idle') return null
  const callModel = options.callModel || callCourseModel
  const modelConfig = options.modelConfig

  if (task.type === 'plan-nodes') {
    return { type: 'plan-nodes', lessonKey: task.lessonKey, taskKey: task.taskKey }
  }

  if (task.type === 'reconcile-final-review') {
    return {
      type: 'complete-final-review',
      lessonKey: task.lessonKey,
      qualityReport: task.qualityReport || {},
      taskKey: task.taskKey
    }
  }

  if (task.type === 'assemble') {
    const outline = task.lesson?.outline || []
    const nodes = task.lesson?.nodes || []
    const summarySchema = Object.fromEntries(outline.map(node => [node.id, 'string']))
    const quizSchema = Object.fromEntries(outline.map(node => [node.id, ['string']]))
    const result = await callModel({
      config: modelConfig,
      role: 'splicer',
      prompt: buildPrompt({
        role: 'splicer',
        promptVersion: task.courseSpec?.promptVersion,
        courseSpec: task.courseSpec,
        lessonBlueprint: {
          title: task.lesson?.title,
          mainLine: task.lesson?.blueprint?.mainLine || '',
          outline: outline.map(node => ({
            id: node.id,
            title: node.title,
            rationale: node.rationale || '',
            concepts: node.concepts || [],
            statutes: node.statutes || [],
            cases: node.cases || []
          })),
          instruction: '只生成节点之间的接缝段。不得改写或概括替代任何节点正文；sectionSummaries 与 sectionQuizzes 的键必须使用上述 outline id。'
        },
        writerBrief: {
          approvedNodes: nodes.map(node => ({
            id: node.id,
            outlineNodeId: node.outlineNodeId,
            title: node.title,
            lineRange: node.lineRange,
            draftVersion: node.versions?.length || 0
          }))
        },
        sourceText: splicePlaceholderContext(task.lesson),
        pptText: '',
        schema: {
          courseOverview: { coreQuestions: ['string'], shouldBeAbleTo: ['string'], lectureThread: 'string' },
          sectionSummaries: summarySchema,
          sectionQuizzes: quizSchema,
          knowledgeLink: {
            inheritsFrom: 'string',
            laysGroundworkFor: [{ concept: 'string', use: 'string' }],
            nextLessonPreview: 'string'
          },
          appendix: {
            terms: [{ term: 'string', original: 'string', definition: 'string' }],
            topics: [{ title: 'string', content: 'string' }]
          }
        }
      })
    })
    return {
      type: 'assemble',
      lessonKey: task.lessonKey,
      spliceData: validateSpliceData(result.parsed),
      taskKey: task.taskKey,
      trace: result.trace
    }
  }

  if (task.type === 'revise-final-note') {
    const request = task.lesson?.finalRevisionRequests?.at?.(-1)?.value?.message || ''
    const result = await callModel({
      config: modelConfig,
      role: 'finalRevision',
      prompt: buildPrompt({
        role: 'finalRevision',
        promptVersion: task.courseSpec?.promptVersion,
        courseSpec: task.courseSpec,
        lessonBlueprint: { title: task.lesson?.title, instruction: '只按用户要求修订当前完整笔记，返回完整 Markdown。' },
        writerBrief: { userRequest: request, preserveUnmentionedContent: true },
        sourceText: task.lesson?.finalNote?.markdown || '',
        pptText: '',
        schema: { markdown: 'string' }
      })
    })
    return {
      type: 'save-final-note-revision',
      lessonKey: task.lessonKey,
      markdown: validateMarkdown(result.parsed).markdown,
      taskKey: task.taskKey,
      trace: result.trace
    }
  }

  if (task.type === 'generate-outline') {
    const lineCount = Math.max(1, transcriptLines(task.lesson.transcript).length)
    const result = await callModel({
      config: modelConfig,
      role: 'outline',
      prompt: buildPrompt({
        role: 'outline',
        promptVersion: task.courseSpec?.promptVersion,
        courseSpec: task.courseSpec,
        lessonBlueprint: {
          title: task.lesson.title,
          transcriptLineCount: lineCount,
          lineNumberFormat: '[Lx]',
          coverageRule: `第一节点从第 1 行开始，最后节点覆盖第 ${lineCount} 行；相邻节点之间不得留下行号缺口。`
        },
        sourceText: numberTranscript(task.lesson.transcript),
        pptText: JSON.stringify([...(task.lesson.pptText || []), ...(task.lesson.supplements || [])]),
        schema: {
          mainLine: 'string',
          outline: [{
            title: 'string',
            lineRange: [1, Math.min(200, lineCount)],
            slideRange: [1, 1],
            rationale: 'string',
            importance: 'high|normal|low',
            concepts: [],
            statutes: [],
            cases: []
          }]
        }
      })
    })
    const initialValue = validateOutline(result.parsed)
    const repaired = await repairOutlineGaps({
      task,
      value: initialValue,
      lineCount,
      initialTrace: result.trace,
      modelConfig,
      callModel
    })
    return {
      type: 'save-outline',
      lessonKey: task.lessonKey,
      mainLine: repaired.value.mainLine,
      outline: repaired.value.outline,
      taskKey: task.taskKey,
      trace: repaired.trace
    }
  }

  if (['write-node', 'revise-node'].includes(task.type)) {
    const role = task.type === 'revise-node' ? 'revision' : 'writer'
    const result = await callModel({
      config: modelConfig,
      role,
      prompt: buildPrompt({
        role,
        promptVersion: task.courseSpec?.promptVersion,
        courseSpec: task.courseSpec,
        lessonBlueprint: task.lessonBlueprint,
        writerBrief: {
          ...(task.node.writerBrief || {}),
          revisionRequests: task.node.revisionRequests || [],
          reviewerIssues: task.node.reviewerReports?.at?.(-1)?.value?.issues || []
        },
        sourceText: task.node.sourceText,
        pptText: task.node.pptText,
        previousNodeSummary: task.node.writerBrief?.previousNodeSummary,
        nextNodeTarget: task.node.writerBrief?.nextNodeTarget,
        schema: { markdown: 'string' }
      })
    })
    return {
      type: 'save-node-draft-worker',
      lessonKey: task.lessonKey,
      nodeId: task.node.id,
      markdown: validateMarkdown(result.parsed).markdown,
      source: role,
      // 基于哪一版起草：落库前会校验，防止把过期结果写回覆盖新版本
      basedDraftVersion: Number(task.node.versions?.length || 0),
      taskKey: task.taskKey,
      trace: result.trace
    }
  }

  if (task.type === 'review-node') {
    const result = await callModel({
      config: modelConfig,
      role: 'reviewer',
      prompt: buildPrompt({
        role: 'reviewer',
        promptVersion: task.courseSpec?.promptVersion,
        courseSpec: task.courseSpec,
        lessonBlueprint: task.lessonBlueprint,
        writerBrief: {
          ...(task.node.writerBrief || {}),
          nodeId: task.node.id,
          title: task.node.title,
          currentDraft: task.node.draft,
          consistencyRequests: task.node.consistencyRequests || []
        },
        sourceText: task.node.sourceText,
        pptText: task.node.pptText,
        schema: {
          summary: 'string',
          issues: [{
            type: 'string',
            severity: 'blocking|important|suggestion',
            message: 'string',
            nodeId: task.node.id,
            sourceRange: 'string'
          }],
          decision: 'approve|revise'
        }
      })
    })
    return {
      type: 'save-node-review',
      lessonKey: task.lessonKey,
      nodeId: task.node.id,
      reviewerReport: {
        ...validateReview(result.parsed),
        reviewedDraftVersion: Number(task.node.versions?.length || 0)
      },
      taskKey: task.taskKey,
      trace: result.trace
    }
  }

  if (task.type === 'final-review') {
    const result = await callModel({
      config: modelConfig,
      role: 'finalReview',
      prompt: buildPrompt({
        role: 'finalReview',
        promptVersion: task.courseSpec?.promptVersion,
        courseSpec: task.courseSpec,
        lessonBlueprint: task.lesson?.blueprint,
        writerBrief: {
          lessonTitle: task.lesson?.title,
          integrityChecks: {
            approvedNodeCount: task.lesson?.nodes?.length || 0,
            assemblyAlreadyVerified: true,
            instruction: '程序已经确认所有已批准节点正文均完整进入最终稿。请只检查跨节点矛盾、严重重复和整体结构。'
          },
          nodes: (task.lesson?.nodes || []).map(node => {
            const review = node.reviewerReports?.at?.(-1)?.value || {}
            return {
              id: node.id,
              title: node.title,
              lineRange: node.lineRange,
              draftVersion: node.versions?.length || 0,
              reviewDecision: review.decision || node.reviewDecision || '',
              reviewSummary: review.summary || '',
              unresolvedIssueCount: (review.issues || []).filter(issue => issue.severity === 'blocking').length
            }
          })
        },
        sourceText: (task.lesson?.nodes || []).map(node => {
          const review = node.reviewerReports?.at?.(-1)?.value || {}
          return `[${node.id}] ${node.title} · 转录 ${node.lineRange?.join('–')} 行 · 审查：${review.summary || review.decision || '已通过节点审查'}`
        }).join('\n'),
        pptText: task.lesson?.finalNote?.markdown,
        schema: {
          summary: 'string',
          issues: [{
            type: 'string',
            severity: 'blocking|important|suggestion',
            message: 'string',
            nodeId: 'string',
            sourceRange: 'string'
          }],
          decision: 'approve|revise'
        }
      })
    })
    return {
      type: 'complete-final-review',
      lessonKey: task.lessonKey,
      qualityReport: validateReview(result.parsed),
      taskKey: task.taskKey,
      trace: result.trace
    }
  }

  throw new Error(`不支持的课程处理步骤：${task.type}`)
}
