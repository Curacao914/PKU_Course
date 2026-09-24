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

/**
 * 转录稿的"逻辑行"：去掉空行之后的行。全仓库只有这一个行定义。
 *
 * 为什么必须统一：给大纲的行号 [Lx] 是按逻辑行编的（转写稿每句话之间有一行空行，
 * 物理行数是逻辑行的两倍），而节点切片一度按物理行数组切。两者差一倍，于是每个节点
 * 拿到的原文都偏到了别处——模型看到"本节要讲标准化与 Z 值"却拿到定距/定比那一段，
 * 只能如实写"材料里没有本节内容"。这类错位会伪装成"模型不听话"，实际是索引口径不一致。
 * 因此行号、大纲 lineRange、节点切片一律走这个函数。
 */
export function transcriptLines(value) {
  return cleanText(value).split('\n').filter(Boolean)
}
