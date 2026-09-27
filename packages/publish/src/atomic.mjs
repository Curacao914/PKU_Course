import fs from 'node:fs'

/**
 * JSON 落盘的原子替换：写 .tmp → fsync → rename。
 *
 * library.json 是发布库（全部笔记的正文与派生字段）。原先 fs.writeFileSync 直写：
 * 写到一半断电、被 kill、或者磁盘满，读者的站点索引就是半截 JSON——
 * 下一次发布读它直接 JSON.parse 失败，整个发布链路停住。
 *
 * rename 在同一文件系统内是原子的：读到的要么是旧的完整内容，要么是新的完整内容，
 * 不存在"半截"。fsync 保证 rename 之前数据真的落到了盘上，否则断电后可能拿到一个
 * 空的新文件。写法与 lesson-state.json 的保存保持一致（commands.mjs 的 saveState）。
 *
 * fsImpl 可注入：测试要模拟"写到一半失败"，真实文件系统上没法稳定复现。
 */
export function writeJsonAtomic(file, value, { fsImpl = fs, indent = 2 } = {}) {
  // 先序列化再动磁盘：JSON.stringify 抛错（循环引用）时一个字节都还没写
  const text = `${JSON.stringify(value, null, indent)}\n`
  const tempPath = `${file}.tmp`
  let handle = null
  try {
    handle = fsImpl.openSync(tempPath, 'w')
    fsImpl.writeSync(handle, text)
    fsImpl.fsyncSync(handle)
    fsImpl.closeSync(handle)
    handle = null
    fsImpl.renameSync(tempPath, file)
  } catch (error) {
    if (handle !== null) {
      try { fsImpl.closeSync(handle) } catch {}
    }
    // 失败时不留 .tmp 残骸：否则下一次写入会撞上它，目录里也永远有一份可疑文件
    try { fsImpl.unlinkSync(tempPath) } catch {}
    throw error
  }
  return file
}
