export {
  COMMON_RULES,
  ROLE_MODEL_ENV,
  ROLE_SYSTEM,
  buildPrompt,
  callCourseModel,
  extractCourseModelContent,
  parseJsonResponse,
  requireCourseModelConfig
} from './ai-adapter.mjs'

export {
  COURSE_LLM_COST_MODES,
  CourseLlmWindowClosedError,
  DEFAULT_COURSE_LLM_SCHEDULE,
  assertCourseLlmWindowOpen,
  cleanTimezone,
  getCourseLlmWindowDecision,
  isCourseModelTask,
  normalizeCourseLlmSchedule
} from './llm-schedule.mjs'

export {
  getNextCourseWorkerTask,
  getNextCourseWorkerTasks,
  workerStatusPatch
} from './worker-tasks.mjs'

export {
  BRIEF_SCHEMA,
  buildBriefSource,
  generateBrief,
  renderBriefMessage,
  validateBrief
} from './brief.mjs'

export {
  DEFAULT_NOTES_MAX_STEPS,
  applyTaskAction,
  createInitialLesson,
  runLessonNotes
} from './pipeline.mjs'

export {
  assembleFinalNote,
  buildFinalNoteMarkdown,
  META_COMMENTARY_PHRASES,
  demoteBodyHeadings,
  findMetaCommentary,
  renderCoreQuestions,
  renderIndexTables,
  renderKnowledgeMap,
  renderLearningObjectives,
  renderMethods,
  renderPitfalls,
  renderPositionInCourse,
  renderQuizOverview,
  renderThreads,
  renderTimeline,
  chineseIndex,
  extractNodeMetadata,
  normalizedSpliceData,
  outlineTopic,
  renderAppendix,
  renderCourseOverview,
  renderKnowledgeLink,
  renderMetaBlock,
  renderQuiz,
  spliceString,
  stripMetaBlock
} from './assembly.mjs'

export {
  executeCourseTask,
  findOutlineCoverageGaps,
  mergeAndCoverOutline,
  numberTranscript,
  splicePlaceholderContext,
  summarizeDecks,
  transcriptLines,
  validateMarkdown,
  validateOutline,
  validateReview,
  validateSpliceData
} from './task-runner.mjs'

export {
  DEFAULT_COURSE_SPEC,
  applyFinalReview,
  applyNodeReview,
  approveNode,
  approveNodeHuman,
  assertOutlineCoverage,
  createNodeFromOutline,
  deriveLessonStatus,
  issueNodeIds,
  normalizeIssue,
  normalizeReviewReport,
  normalizedReviewDecision,
  planNodes,
  pptForRange,
  recordNodeTaskFailure,
  requestNodeRevision,
  saveFinalNoteRevision,
  saveNodeDraft
} from './node-lifecycle.mjs'
