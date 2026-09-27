/**
 * 站点上 Markdown 的唯一路径规则。
 *
 * 以前三处各拼一遍：writeSite 写 `md/${slug 最后一段}.md`、阅读页下载链接照抄这个名字、
 * MCP 再用 noteFileName(slug) 拼一次。slug 的最后一段只有课次（没有课程），于是
 * 两门课同一天同名课次（"2026-10-12第1-2节"）会互相覆盖——后发布的把先发布的正文顶掉。
 *
 * 现在的唯一形状：
 *   /md/<课程>/<课次>.md           例如 /md/商法概论/2026-10-12第1-2节.md
 *   /md/<课程>/<课次>-一页纸.md
 *
 * 记录里的 slug 是 notes/<课程>/<课次>（见 noteSlug），这里只是把 notes 前缀换成 md，
 * 并把两条路径都收敛到 markdownSegments 这一个函数上——写文件、下载链接、llms.txt、
 * MCP 远程取正文，全都从这里出发，不再各自拼字符串。
 */

/** slug → 路径分段：notes/商法概论/2026-10-12第1-2节 → ['商法概论', '2026-10-12第1-2节']。 */
export function markdownSegments(record = '') {
  const slug = typeof record === 'string' ? record : String(record?.slug ?? '')
  const parts = slug.split('/').map(part => part.trim()).filter(Boolean)
  const rest = parts[0] === 'notes' ? parts.slice(1) : parts
  // 目录穿越（'.' / '..'）不可能由 slugify 产出，但这条路径也从外部输入拼出来，挡一道
  const safe = rest.map(part => (part === '.' || part === '..' ? 'note' : part))
  return safe.length ? safe : ['note']
}

/** 落盘用（相对站点根）：md/商法概论/2026-10-12第1-2节.md */
export function markdownPath(record = '') {
  return `md/${markdownSegments(record).join('/')}.md`
}

/** 落盘用的一页纸：md/商法概论/2026-10-12第1-2节-一页纸.md */
export function onePageMarkdownPath(record = '') {
  const segments = markdownSegments(record)
  const last = segments.pop()
  return `md/${[...segments, `${last}-一页纸`].join('/')}.md`
}

const encodePath = segments => segments.map(segment => encodeURIComponent(segment)).join('/')

/** 页面上的下载/复制链接（每段单独编码，中文与空格都安全）。 */
export function markdownUrl(record = '') {
  return `/md/${encodePath(markdownSegments(record))}.md`
}

/** 一页纸的下载链接。 */
export function onePageMarkdownUrl(record = '') {
  const segments = markdownSegments(record)
  const last = segments.pop()
  return `/md/${encodePath([...segments, `${last}-一页纸`])}.md`
}
