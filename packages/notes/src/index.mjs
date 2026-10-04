export {
  coversOutline,
  isMergedWriteUnit,
  outlineIdsOf,
  primaryOutlineIdOf
} from './outline-ids.mjs'

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
  buildBriefSourceFromMarkdown,
  cleanKeywords,
  generateBrief,
  generateBriefFromMarkdown,
  renderBriefMessage,
  validateBrief
} from './brief.mjs'

export {
  COURSE_CONTEXT_BUDGET,
  buildCourseContext,
  lessonDateOfRecord
} from './course-context.mjs'

export {
  SPLICE_EVIDENCE,
  draftsByOutline,
  isVerbatimCopy,
  nodeEvidence,
  sectionBodyIndex,
  spliceEvidence
} from './splice-evidence.mjs'

export {
  BRIEF_SOURCE_BUDGET,
  assertBriefBinding,
  buildBriefSourceFromFinalNote,
  briefSourceChecksum,
  charCount as sourceCharCount,
  checkBriefBinding,
  parseFinalNote
} from './brief-source.mjs'

export {
  ONEPAGE_MAX_CHARS,
  ONEPAGE_SCHEMA,
  ONEPAGE_TARGET_CHARS,
  SOURCE_MAP_SCHEMA,
  buildOnepageSource,
  buildSourceMapSource,
  generateOnepage,
  normalizeSourceMapDraft,
  validateOnepage
} from './onepage.mjs'

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
  buildIntegrationPlan,
  checkIntegrationSources,
  renderIntegrationMarkdown,
  selectLessons
} from './integration.mjs'

export {
  checkTopicSources,
  normalizeSourceRef,
  normalizeSourceRefs,
  normalizeTopicArtifact,
  sourceRefHref,
  topicSourceStats
} from './topic.mjs'

export {
  TOPIC_ARTIFACT_SCHEMA,
  TOPIC_PLAN_SCHEMA,
  buildTopicArtifactSource,
  buildTopicPlanningSource,
  generateTopicArtifact,
  normalizeTopicPlan,
  planCourseTopics
} from './topic-generation.mjs'

export {
  emptyTopicManifest,
  normalizeTopicDefinition,
  normalizeTopicManifest,
  removeTopicDefinition,
  replaceCourseTopics,
  selectConfiguredTopics,
  upsertTopicDefinition
} from './topic-manifest.mjs'

export {
  emptyIntegrationManifest,
  normalizeIntegrationDefinition,
  normalizeIntegrationManifest,
  removeIntegrationDefinition,
  selectConfiguredIntegrations,
  upsertIntegrationDefinition
} from './integration-manifest.mjs'

export {
  checkMarkerPropagation,
  checkMetadata,
  checkNoteQuality,
  checkTables,
  checkTruncation,
  findOpenMarkers,
  formatQualityReport
} from './quality.mjs'

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
  saveNodeDraft,
  splitWriteUnit
} from './node-lifecycle.mjs'
