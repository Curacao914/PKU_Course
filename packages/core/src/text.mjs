/**
 * 文本规范化。
 *
 * 旧仓库里同一份 cleanText 至少有两处拷贝（lib/course/textpack.js 与
 * scripts/course-worker/runtime/textpack-runtime.mjs）。搬到新仓库时合并为一份：
 * 行尾统一为 \n、去掉 NUL、两端裁剪。不做 NFKC 与字符替换——那些是文件名与
 * 键值场景的需求，混在一起会让"正文被悄悄改写"。
 */
export function cleanText(value) {
  return String(value ?? '')
    .replace(/\r\n/g, '\n')
    .replace(/\r/g, '\n')
    .replace(/\u0000/g, '')
    .trim()
}
