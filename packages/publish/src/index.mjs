export {
  blockIdOf,
  escapeHtml,
  extractHeadings,
  plainBlockText,
  renderInline,
  renderMarkdown,
  sectionIndex,
  sectionTexts,
  slugify,
  summarizeMarkdown
} from './markdown.mjs'

// 一页纸 → 原文的来源映射：块 ID、摘录核对、免费路径构建与发布前验证
export {
  OVERLAP_MIN_CHARS,
  QUOTE_MIN_CHARS,
  SOURCE_MAP_VERSION,
  buildSourceMap,
  onepageBlocks,
  quoteInSection,
  resolveSourceMapEntries,
  sourceMapStats,
  verifySourceMap
} from './sourcemap.mjs'

export {
  DEFAULT_ZONE_ID,
  cdnTokenFrom,
  cacheUrlsFor,
  purgeCloudflareCache
} from './purge.mjs'

// 时间语义：lessonDate（这节课哪天上的）/ firstPublishedAt（第一次进站）/ updatedAt（最近一次改动）
export {
  compareFirstPublishedDescending,
  compareLessonAscending,
  compareLessonDescending,
  dateOnly,
  firstPublishedAtOf,
  lessonDateOf,
  parseDateFromText,
  resolveLessonDate,
  updatedAtOf
} from './lesson-date.mjs'

// Markdown 路径的唯一实现：写文件、下载链接、llms.txt、MCP 取正文都走它
export {
  markdownPath,
  markdownSegments,
  markdownUrl,
  onePageMarkdownPath,
  onePageMarkdownUrl
} from './markdown-path.mjs'

// 派生物（onepage.json）与源正文的绑定：指纹 + 校验（简报那边用 @course/notes 的 checkBriefBinding）
// markdownChecksum = 绑定指纹（规范化，两侧同一口径）；markdownBytesChecksum = 原始字节（发布库的变更判定）
export {
  derivedBinding, markdownBytesChecksum, markdownChecksum, normalizeMarkdown, verifyDerived
} from './derived.mjs'

// JSON 落盘的原子替换（library.json 用）
export { writeJsonAtomic } from './atomic.mjs'

export {
  SITE_CSS,
  SITE_NAME,
  buildNoteRecord,
  deriveKeywords,
  keywordFields,
  extractNoteMetadata,
  migrateRecordTime,
  noteSlug,
  parseStatute,
  readSiteIndex,
  refreshRecord,
  renderIndexPage,
  renderKnowledgeMapPage,
  renderNotePage,
  renderSearchPage,
  renderTermIndexPage,
  renderTopicMarkdown,
  termAnchors,
  toArticleChinese,
  writeSite
} from './site.mjs'
