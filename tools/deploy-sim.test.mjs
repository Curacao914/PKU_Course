import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

/**
 * 发布脚本的仿真测试：在一台"假服务器"上把 deploy/release.sh 完整跑一遍。
 *
 * 为什么值得写：发布脚本是**唯一**会在生产上执行删除、切符号链接、重启服务的代码，
 * 而它以前只能靠"推到服务器上试试"来验证——那正是最不该试错的地方。这里用 PATH 上的
 * shim 把它周围的世界换掉：
 *   systemctl / curl / npm / node / sleep  全部是假命令（记录调用 + 可注入失败）
 *   HOME 指向临时目录，真机上什么都没有动
 * 于是这些情形都能在本地反复验证：
 *   · 干净目录首次发布（依赖进独立依赖仓、两个服务都重启、健康检查全过）；
 *   · 同一个锁文件再发一次 → 复用依赖仓，不再装依赖；
 *   · 锁文件变了 → 依赖仓按哈希新增，旧的仍然留着；
 *   · 测试没过 / 单元角色写错 → 切换前就停，不留垃圾目录、不动当前版本；
 *   · 健康检查没过 → 自动回滚到上一个**成功**版本；
 *   · 手动 --rollback → 回到上一个成功版本，并把失败的那条从成功历史里划掉。
 *
 * 它跑在 macOS 与 Linux 上都可以：脚本本身只用 POSIX + bash 3.2 就有的特性。
 */

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const RELEASE = path.join(REPO, 'deploy', 'release.sh')

const shimScript = (name, body) => '#!/bin/sh\n' + body

/** 造一台"假服务器"：独立的 HOME、PATH 上的 shim、两个单元文件、一个 staging 目录。 */
function sandbox({ siteRole = 'public', adminRole = 'admin', venv = true } = {}) {
  // realpath 一下：macOS 上 /var 是指向 /private/var 的符号链接，
  // 不统一的话 realpathSync 的结果与手工拼出来的路径对不上（断言会假失败）
  const home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'course-deploy-')))
  const shims = path.join(home, 'shims')
  fs.mkdirSync(shims, { recursive: true })
  const log = path.join(home, 'shims.log')
  fs.writeFileSync(log, '')
  const record = (prefix) => shimScript('x', 'printf \'%s\\n\' "' + prefix + '" >> "' + log + '"\n')

  fs.writeFileSync(path.join(shims, 'systemctl'), shimScript('systemctl',
    'printf \'systemctl %s\\n\' "$*" >> "' + log + '"\n' +
    'exit 0\n'))
  // 健康检查：默认全通过；只要 $HOME/health-fail 存在，就**消耗掉它**并让这一次失败——
  // 这样"新版本健康检查没过 + 回滚后恢复正常"能在一次运行里被验证。
  fs.writeFileSync(path.join(shims, 'curl'), shimScript('curl',
    'printf \'curl %s\\n\' "$*" >> "' + log + '"\n' +
    'if [ -f "$HOME/health-fail" ]; then rm -f "$HOME/health-fail"; exit 22; fi\n' +
    'exit 0\n'))
  fs.writeFileSync(path.join(shims, 'sleep'), shimScript('sleep', 'exit 0\n'))
  // npm ci：只留一个标记文件（真装依赖不是这个测试要验的东西）
  fs.writeFileSync(path.join(shims, 'npm'), shimScript('npm',
    'printf \'npm %s\\n\' "$*" >> "' + log + '"\n' +
    'mkdir -p node_modules\n' +
    'printf installed > node_modules/MARKER\n' +
    'exit 0\n'))
  // node --test：默认通过；$HOME/test-fail 存在时失败
  fs.writeFileSync(path.join(shims, 'node'), shimScript('node',
    'printf \'node %s\\n\' "$*" >> "' + log + '"\n' +
    'if [ -f "$HOME/test-fail" ]; then printf \'ℹ fail 3\\n\'; exit 1; fi\n' +
    'printf \'ℹ pass 42\\nℹ fail 0\\n\'\n' +
    'exit 0\n'))
  for (const name of fs.readdirSync(shims)) fs.chmodSync(path.join(shims, name), 0o755)

  // 两个单元文件（角色检查读的就是它们）
  const units = path.join(home, '.config', 'systemd', 'user')
  fs.mkdirSync(units, { recursive: true })
  const unit = (role, port) => [
    '[Service]',
    'EnvironmentFile=-%h/.course-worker/env',
    role ? 'Environment=COURSE_SITE_ROLE=' + role : 'Environment=COURSE_SITE_PORT=' + port,
    'ExecStart=__NODE__ apps/site/bin/serve.mjs'
  ].join('\n') + '\n'
  fs.writeFileSync(path.join(units, 'course-site.service'), unit(siteRole, 3100))
  fs.writeFileSync(path.join(units, 'course-admin.service'), unit(adminRole, 3101))

  if (venv) fs.mkdirSync(path.join(home, 'venvs', 'course'), { recursive: true })

  const staging = path.join(home, 'course-staging')
  fs.mkdirSync(path.join(staging, 'deploy'), { recursive: true })
  fs.copyFileSync(RELEASE, path.join(staging, 'deploy', 'release.sh'))
  fs.chmodSync(path.join(staging, 'deploy', 'release.sh'), 0o755)
  fs.mkdirSync(path.join(staging, 'packages', 'sample', 'src'), { recursive: true })
  fs.writeFileSync(path.join(staging, 'package.json'), JSON.stringify({ name: 'fake', private: true }))
  writeLock(staging, 'lock-v1')
  fs.writeFileSync(path.join(staging, 'packages', 'sample', 'src', 'sample.test.mjs'), '// 假测试\n')

  return { home, shims, log, staging, units, record }
}

const writeLock = (staging, marker) => {
  fs.writeFileSync(path.join(staging, 'package-lock.json'), JSON.stringify({ lockfileVersion: 3, marker }))
}

function run(sandbox, args = []) {
  return new Promise((resolve) => {
    execFile('bash', [path.join(sandbox.staging, 'deploy', 'release.sh'), ...args], {
      cwd: sandbox.staging,
      env: {
        ...process.env,
        HOME: sandbox.home,
        PATH: sandbox.shims + ':' + process.env.PATH,
        KEEP: '3'
      },
      maxBuffer: 20 * 1024 * 1024
    }, (error, stdout, stderr) => resolve({ code: error && typeof error.code === 'number' ? error.code : (error ? 1 : 0), stdout, stderr }))
  })
}

const readLog = sandbox => fs.readFileSync(sandbox.log, 'utf8')
const historyLines = (sandbox) => {
  const file = path.join(sandbox.home, 'releases', 'course', '.history')
  return fs.existsSync(file) ? fs.readFileSync(file, 'utf8').split('\n').filter(Boolean) : []
}
const failedLines = (sandbox) => {
  const file = path.join(sandbox.home, 'releases', 'course', '.history-failed')
  return fs.existsSync(file) ? fs.readFileSync(file, 'utf8').split('\n').filter(Boolean) : []
}
const currentOf = (sandbox) => {
  const link = path.join(sandbox.home, 'course-runtime')
  return fs.existsSync(link) ? fs.realpathSync(link) : ''
}
const storeDirs = (sandbox) => {
  const dir = path.join(sandbox.home, 'deps', 'course')
  return fs.existsSync(dir) ? fs.readdirSync(dir).sort() : []
}
const releaseDirs = (sandbox) => {
  const dir = path.join(sandbox.home, 'releases', 'course')
  return fs.existsSync(dir) ? fs.readdirSync(dir).filter(name => !name.startsWith('.')).sort() : []
}

test('干净目录首次发布：依赖进独立依赖仓、两个服务都重启并检查健康、成功历史写一条', async () => {
  const box = sandbox()
  const result = await run(box)
  assert.equal(result.code, 0, result.stdout + result.stderr)

  const current = currentOf(box)
  assert.ok(current.includes(path.join('releases', 'course')), 'course-runtime 必须指向 release 目录')
  // 发布的是"当前目录里那棵完整的树"，不是散装文件
  assert.ok(fs.existsSync(path.join(current, 'package.json')))
  assert.ok(fs.existsSync(path.join(current, 'packages', 'sample', 'src', 'sample.test.mjs')))
  // Python 环境跨 release 共享：release 里只有一个指向 ~/venvs/course 的链接
  assert.equal(fs.realpathSync(path.join(current, '.venv')), path.join(box.home, 'venvs', 'course'))

  // 依赖进依赖仓（目录名就是锁文件哈希），release 里是硬链接而不是再装一份
  const stores = storeDirs(box)
  assert.equal(stores.length, 1)
  const storeModules = path.join(box.home, 'deps', 'course', stores[0], 'node_modules')
  const releaseMarker = path.join(current, 'node_modules', 'MARKER')
  assert.ok(fs.existsSync(path.join(storeModules, 'MARKER')), '依赖仓里应当有装好的依赖')
  assert.ok(fs.existsSync(releaseMarker))
  assert.equal(fs.statSync(releaseMarker).ino, fs.statSync(path.join(storeModules, 'MARKER')).ino,
    'release 里的依赖应当是硬链接（同 inode），不是又复制一份')

  // 成功历史与元数据
  assert.deepEqual(historyLines(box), [path.basename(current)])
  const meta = fs.readFileSync(path.join(current, '.release-meta'), 'utf8')
  assert.match(meta, /^lockHash=/m)
  assert.match(meta, /^digest=[0-9a-f]{16}$/m)
  assert.match(meta, /service=course-site.service role=public port=3100 health=ok/)
  assert.match(meta, /service=course-admin.service role=admin port=3101 health=ok/)

  // 两个服务都被重启、两个端口都被检查
  const log = readLog(box)
  assert.match(log, /systemctl --user restart course-site.service/)
  assert.match(log, /systemctl --user restart course-admin.service/)
  // 用 includes 而不是正则：路径里的斜杠会把正则字面量提前收尾
  assert.ok(log.includes('127.0.0.1:3100/healthz'), '公开服务要检查健康')
  assert.ok(log.includes('127.0.0.1:3101/healthz'), '管理服务要检查健康')
  assert.equal((log.match(/^npm ci/gm) || []).length, 1, '第一次发布要装一次依赖')

  fs.rmSync(box.home, { recursive: true, force: true })
})

test('同一个锁文件再发一次：复用依赖仓（不再 npm ci），成功历史多一条', async () => {
  const box = sandbox()
  assert.equal((await run(box)).code, 0)
  const first = currentOf(box)
  // 改一点代码再发，锁文件不动
  fs.writeFileSync(path.join(box.staging, 'README.md'), 'v2\n')
  const second = await run(box)
  assert.equal(second.code, 0, second.stdout + second.stderr)

  const current = currentOf(box)
  assert.notEqual(current, first)
  assert.equal(storeDirs(box).length, 1, '锁文件没变就不该新建依赖仓')
  assert.equal((readLog(box).match(/^npm ci/gm) || []).length, 1, '第二次不该再装依赖')
  assert.deepEqual(historyLines(box), [path.basename(first), path.basename(current)])

  fs.rmSync(box.home, { recursive: true, force: true })
})

test('锁文件变了：依赖仓按哈希新增一个，旧的仍然留着（还有 release 在用）', async () => {
  const box = sandbox()
  assert.equal((await run(box)).code, 0)
  const first = currentOf(box)
  writeLock(box.staging, 'lock-v2')
  const second = await run(box)
  assert.equal(second.code, 0, second.stdout + second.stderr)

  const stores = storeDirs(box)
  assert.equal(stores.length, 2, '两个不同的锁文件 = 两个依赖仓')
  assert.equal((readLog(box).match(/^npm ci/gm) || []).length, 2)
  const metaFirst = fs.readFileSync(path.join(first, '.release-meta'), 'utf8').match(/^lockHash=(.*)$/m)[1]
  const metaSecond = fs.readFileSync(path.join(currentOf(box), '.release-meta'), 'utf8').match(/^lockHash=(.*)$/m)[1]
  assert.notEqual(metaFirst, metaSecond)
  assert.deepEqual(stores, [metaFirst, metaSecond].sort())

  fs.rmSync(box.home, { recursive: true, force: true })
})

test('测试没过：不切换、不留坏目录、失败历史记一笔', async () => {
  const box = sandbox()
  fs.writeFileSync(path.join(box.home, 'test-fail'), '1')
  const result = await run(box)
  assert.notEqual(result.code, 0)
  assert.match(result.stderr, /新版本测试没过/)
  assert.equal(currentOf(box), '', '没切换就不该有 course-runtime')
  assert.deepEqual(releaseDirs(box), [], '没通过的 release 目录必须删掉（否则回滚会滚进它）')
  assert.deepEqual(historyLines(box), [])
  assert.ok(failedLines(box).some(line => line.includes('stage=test')), '失败要留下记录：' + failedLines(box).join(' | '))

  fs.rmSync(box.home, { recursive: true, force: true })
})

test('健康检查没过：自动回滚到上一个成功版本，成功历史里不留失败的那条', async () => {
  const box = sandbox()
  assert.equal((await run(box)).code, 0)
  const good = currentOf(box)

  fs.writeFileSync(path.join(box.staging, 'README.md'), 'v2\n')
  fs.writeFileSync(path.join(box.home, 'health-fail'), '1')   // 消耗式：只让下一次健康检查失败
  const failed = await run(box)
  assert.notEqual(failed.code, 0, '健康检查没过时发布必须失败')
  assert.match(failed.stderr, /已回滚/)

  assert.equal(currentOf(box), good, 'course-runtime 必须指回上一个成功版本')
  assert.deepEqual(historyLines(box), [path.basename(good)], '失败的那条不能进成功历史')
  assert.ok(failedLines(box).some(line => line.includes('stage=health')), failedLines(box).join(' | '))
  // 没切换成的目录留在盘上供排查（日志里也说明了），但不在任何历史里
  const strays = releaseDirs(box).filter(name => name !== path.basename(good))
  assert.equal(strays.length, 1)

  fs.rmSync(box.home, { recursive: true, force: true })
})

test('手动 --rollback：回到上一个成功版本，并把被回滚掉的那条从成功历史里划掉', async () => {
  const box = sandbox()
  assert.equal((await run(box)).code, 0)
  const first = currentOf(box)
  fs.writeFileSync(path.join(box.staging, 'README.md'), 'v2\n')
  assert.equal((await run(box)).code, 0)
  const second = currentOf(box)
  assert.notEqual(first, second)

  const rolled = await run(box, ['--rollback'])
  assert.equal(rolled.code, 0, rolled.stdout + rolled.stderr)
  assert.equal(currentOf(box), first)
  assert.deepEqual(historyLines(box), [path.basename(first)], '历史里不该留着刚回滚掉的那条（否则会乒乓）')

  // 回滚也重启服务并做健康检查
  const log = readLog(box)
  assert.ok((log.match(/systemctl --user restart course-site\.service/g) || []).length >= 3)

  fs.rmSync(box.home, { recursive: true, force: true })
})

test('单元没有显式声明角色：切换前就拒绝，不留目录、不动当前版本', async () => {
  const box = sandbox({ siteRole: '' })
  const result = await run(box)
  assert.notEqual(result.code, 0)
  assert.match(result.stderr, /COURSE_SITE_ROLE 是 '未声明'，期望 public/)
  assert.equal(currentOf(box), '', '角色不对时绝不能切换')
  assert.deepEqual(releaseDirs(box), [], '没切换成的目录要删掉')
  assert.ok(failedLines(box).some(line => line.includes('stage=roles')), failedLines(box).join(' | '))

  // 换成正确角色后同样的一次发布应当成功（拒绝的是"角色没写"，不是"发布坏了"）
  const units = path.join(box.home, '.config', 'systemd', 'user', 'course-site.service')
  fs.writeFileSync(units, fs.readFileSync(units, 'utf8') + 'Environment=COURSE_SITE_ROLE=public\n')
  const retry = await run(box)
  assert.equal(retry.code, 0, retry.stdout + retry.stderr)
  assert.ok(currentOf(box).includes('releases'))

  fs.rmSync(box.home, { recursive: true, force: true })
})
