#!/usr/bin/env bash
#
# 发布式部署：新代码进独立的 release 目录，**测过再切换**，切换是原子的。
#
# 为什么要有它：以前是 rsync 直接覆盖 ~/course-runtime —— 推到一半断了、或者新代码
# 起不来，手上就没有能回退的版本；而且覆盖式同步意味着"正在跑的东西"和"磁盘上的代码"
# 可能不一致（服务已经加载了旧模块，文件却换成了新的）。
#
# 现在的形状：
#   ~/releases/course/<时间戳>/        每次发布一个完整目录（未改动的文件用硬链接，几乎不占盘）
#   ~/course-runtime -> 上面某个       符号链接指向"当前版本"；systemd 单元里的路径不用改
#   ~/deps/course/<lock 哈希>/node_modules   依赖仓：按 package-lock.json 的哈希缓存，只增不改
#   ~/releases/course/.history         发布成功的历史（回滚按它取"上一个"）
#   ~/releases/course/.history-failed  失败记录（只给人看；回滚绝不采用）
#
# **三个服务一起发布**：course-site.service（public，3100）、course-admin.service（admin，3101）
# 与 course-control.service（control，3102）。只重启一部分会留下跨版本接口。
#
# 用法（在服务器上）：
#   deploy/release.sh [来源目录]        默认 ~/course-staging
#   deploy/release.sh --rollback        回到上一个**成功发布**的 release
#   KEEP=5 deploy/release.sh            保留最近 5 个 release（默认 3）
set -euo pipefail

HOME_DIR="${HOME}"
RELEASES="${HOME_DIR}/releases/course"
CURRENT="${HOME_DIR}/course-runtime"
DEPS="${HOME_DIR}/deps/course"
KEEP="${KEEP:-3}"
# 服务清单：名字:期望角色:健康端口:健康路径。
# site/admin 的角色写在这里是有意的：单元里漏写 COURSE_SITE_ROLE 时，serve.mjs 会拒绝启动。
# control 是独立进程，不使用 COURSE_SITE_ROLE，但同样跟随 release 原子切换并做健康检查。
SERVICES=(
  "course-site.service:public:3100:/healthz"
  "course-admin.service:admin:3101:/healthz"
  "course-control.service:control:3102:/health"
)
UNIT_DIRS=("${HOME_DIR}/.config/systemd/user" "/etc/systemd/system")

log() { printf '%s\n' "$*"; }
fail() { printf '发布失败：%s\n' "$*" >&2; exit 1; }

service_name() { printf '%s' "${1%%:*}"; }
service_role() { printf '%s' "$(printf '%s' "$1" | cut -d: -f2)"; }
service_port() { printf '%s' "$(printf '%s' "$1" | cut -d: -f3)"; }
service_health() { printf '%s' "$(printf '%s' "$1" | cut -d: -f4)"; }

# sha256sum 是 GNU 的；BSD/macOS 上是 shasum -a 256。发布脚本只跑在 Linux 上，
# 但"能在本地跑一遍"对测试很有用（deploy 的仿真测试就是这么做的）。
hash_stdin() {
  if command -v sha256sum >/dev/null 2>&1; then sha256sum; else shasum -a 256; fi
}

# 目录内容指纹：用于在 .release-meta 里记下"这次发布的是哪份代码"。
# 不含 node_modules（那是依赖仓的事）与 .git（staging 里根本没有）。
tree_digest() {
  ( cd "$1" && find . -path ./node_modules -prune -o -path ./.git -prune -o -type f -print0 \
      | sort -z | xargs -0 cat | hash_stdin | cut -c1-16 )
}

# 锁文件哈希：依赖仓的键。**换依赖必然换哈希**，所以依赖仓里的内容一旦写完就不再变。
lock_hash() {
  ( cd "$1" && hash_stdin < package-lock.json | cut -c1-16 )
}

# 原子换链接：先建临时链接，再 rename 到目标名——rename 是原子的，
# 中间不存在"链接指向不存在的东西"的瞬间。（ln -sfn 直接覆盖会先 unlink 再 symlink，
# 那一刻 systemd 若正好在重启，WorkingDirectory=%h/course-runtime 会解析失败。）
atomic_link() {
  ln -sfn "$1" "$2.new"
  # GNU 的 mv 需要 -T 才肯替换"链接本身"（不加 -T 会把新链接挪进旧链接指向的目录里）。
  # BSD/macOS 的 mv 没有 -T：退回 ln -sfn 覆盖（正确但不再是原子的，本机仿真会走到这条）。
  # 这条分支被仿真测试抓到过一次"发布成功但 course-runtime 还指着旧版本"。
  if mv -T "$2.new" "$2" 2>/dev/null; then return 0; fi
  [ -e "$2.new" ] || return 0
  ln -sfn "$1" "$2"
  rm -f "$2.new"
  return 0
}

record_failure() {
  mkdir -p "$RELEASES"
  printf '%s stage=%s reason=%s\n' "$(date +%Y-%m-%dT%H:%M:%S)" "$1" "$2" >> "${RELEASES}/.history-failed"
}

# 全部服务的健康检查：全部通过才算成功，返回空串；否则返回第一个失败的 URL。
health_check() {
  local entry url
  for entry in "${SERVICES[@]}"; do
    url="http://127.0.0.1:$(service_port "$entry")$(service_health "$entry")"
    if ! curl -fsS --max-time 10 "$url" >/dev/null; then printf '%s' "$url"; return 1; fi
  done
  printf '%s' ""
  return 0
}

restart_all() {
  local entry
  for entry in "${SERVICES[@]}"; do systemctl --user restart "$(service_name "$entry")"; done
}

# 一次没切换成的 release 目录不该留在 ~/releases 里：它不在成功历史中，
# 除了占地方没有任何作用（回滚只认历史）。删掉它，日志留在 /tmp 里足够排查。
discard_target() {
  if [ -n "${TARGET:-}" ] && [ -d "${TARGET}" ]; then rm -rf "${TARGET}"; fi
  return 0
}

# 角色检查：单元文件里必须**显式**声明与这里期望一致的角色。
check_roles() {
  local entry name expected unit found dir
  for entry in "${SERVICES[@]}"; do
    name="$(service_name "$entry")"
    expected="$(service_role "$entry")"
    unit=""
    for dir in "${UNIT_DIRS[@]}"; do
      if [ -f "$dir/$name" ]; then unit="$dir/$name"; break; fi
    done
    if [ -z "$unit" ]; then
      if [ "${COURSE_ROLE_CHECK:-strict}" = "warn" ]; then
        log "   · 找不到单元 ${name}，按 COURSE_ROLE_CHECK=warn 跳过检查"
        continue
      fi
      discard_target
      record_failure roles "$name 找不到单元文件"
      fail "找不到单元 ${name}（~/.config/systemd/user 与 /etc/systemd/system 里都没有它）。请先跑 deploy/install-units.sh；确实要跳过就设 COURSE_ROLE_CHECK=warn"
    fi
    if [ "$expected" = "control" ]; then
      grep -q '^Environment=COURSE_CONTROL_HOST=127.0.0.1$' "$unit" ||
        fail "$name 必须显式绑定 COURSE_CONTROL_HOST=127.0.0.1"
      grep -q '^KillMode=control-group$' "$unit" ||
        fail "$name 必须使用 KillMode=control-group"
      grep -q '^CPUQuota=' "$unit" ||
        fail "$name 缺少 CPUQuota cgroup 限额"
      grep -q '^MemoryMax=' "$unit" ||
        fail "$name 缺少 MemoryMax cgroup 限额"
      log "   · $name role=control loopback+cgroup=ok 健康端口=$(service_port "$entry")"
      continue
    fi
    found="$(grep -o 'COURSE_SITE_ROLE=[a-z]*' "$unit" | head -1 | cut -d= -f2 || true)"
    if [ "$found" != "$expected" ]; then
      discard_target
      record_failure roles "$name 的角色是 ${found}，期望 $expected"
    fi
    [ "$found" = "$expected" ] || fail \
      "$name 的 COURSE_SITE_ROLE 是 '${found:-未声明}'，期望 ${expected}（角色错了会把管理台挂到公开端口上）"
    log "   · $name role=$found 健康端口=$(service_port "$entry")"
  done
}

if [ "${1:-}" = "--rollback" ]; then
  [ -L "$CURRENT" ] || fail "~/course-runtime 还不是符号链接，无法回滚（先做一次正常发布）"
  # 按**发布顺序**取上一个，而不是按目录名排序：目录名里既有时间戳又有 legacy-*，
  # 名字排序会把 legacy-* 排到最后，"上一个"于是可能指向当前版本（实测踩到过）。
  HISTORY="${RELEASES}/.history"
  current_stamp="$(basename "$(readlink -f "$CURRENT")")"
  # 历史里的最后一个**不等于当前**的条目就是回滚目标。这样两种情形都对：
  #   · 手动回滚（当前是最后一次成功发布）→ 取它前面那一条；
  #   · 自动回滚（当前这次健康检查没过、压根没进历史）→ 取历史里的最后一条。
  # 只数"倒数第二条"会把自动回滚判成"没有可回滚的目标"，那正是最需要回滚的时刻。
  target_stamp=""
  while IFS= read -r line; do
    [ "$line" = "$current_stamp" ] && continue
    target_stamp="$line"
  done < <(grep -v '^$' "$HISTORY" 2>/dev/null | tail -2 || true)
  [ -n "$target_stamp" ] || fail "发布历史里没有可回滚的目标（当前 $(basename "$(readlink -f "$CURRENT")")）"
  target="${RELEASES}/${target_stamp}"
  [ -d "$target" ] || fail "回滚目标不存在：$target"
  log "回滚到 $target"
  atomic_link "$target" "$CURRENT"
  restart_all
  sleep 2
  if bad="$(health_check)"; then
    # 回滚成功后把失败的那个从成功历史里划掉：否则下一次 --rollback 会又指向它，
    # 形成"回滚→失败→回滚"的乒乓。
    grep -v "^${current_stamp}\$" "$HISTORY" > "${HISTORY}.tmp" 2>/dev/null || true
    mv "${HISTORY}.tmp" "$HISTORY"
    log "回滚完成：$(readlink "$CURRENT")"
  else
    record_failure rollback "回滚后健康检查没过：$bad"
    fail "回滚后健康检查没过（${bad}），请人工看一眼"
  fi
  exit 0
fi

SRC="${1:-${HOME_DIR}/course-staging}"
[ -d "$SRC" ] || fail "找不到来源目录：${SRC}（先 rsync 一份到 ~/course-staging）"
[ -f "$SRC/package.json" ] || fail "$SRC 看起来不是仓库根目录（缺 package.json）"
[ -f "$SRC/package-lock.json" ] || fail "$SRC 里没有 package-lock.json（依赖必须与锁文件一致）"

mkdir -p "$RELEASES"
STAMP="$(date +%Y%m%d-%H%M%S)"
TARGET="${RELEASES}/${STAMP}"
# 同一秒里发两次（脚本化发布、或发布被并行触发）会撞名，而 rsync 进一个**正在被使用**的
# release 目录等于把线上版本改坏。撞了先换个名字；还撞就停手——宁可失败，也别写坏正在跑的那份。
if [ -e "$TARGET" ]; then
  log "   · 同一秒内已有同名 release，本次改用 ${STAMP}-$$"
  STAMP="${STAMP}-$$"
  TARGET="${RELEASES}/${STAMP}"
fi
if [ -e "$TARGET" ]; then fail "release 目录已存在：${TARGET}"; fi

# 上一次发布（用于硬链接，未改动的文件不重复占盘）
LINK_DEST=""
if [ -L "$CURRENT" ]; then LINK_DEST="$(readlink -f "$CURRENT")"; fi

log "① 拷贝到 $TARGET${LINK_DEST:+（以 $LINK_DEST 做硬链接）}"
mkdir -p "$TARGET"
# node_modules **必须排除**：--delete 会把"源里没有、目标里有"的东西删掉，
# 而 node_modules 正是那种东西（源里永远没有它）。第一次跑这个脚本就是这么把
# 新 release 的依赖删光、测试全红的——脚本拒绝切换，所以线上没受影响。
# --checksum 不是可有可无的：rsync 默认的"快检"只看**大小 + 秒级 mtime**。同一秒里
# 改了一个**同样大小**的文件（改一个版本号、翻一个布尔值），或者源与目标 mtime 落在同一秒，
# 它就会判定"没变"，于是把上一个 release 的文件用 --link-dest 直接硬链接过来——
# 发布出去的就不是 staging 里那份代码了。这个坑是 CI 上跑 deploy 仿真测试抓到的
# （锁文件内容变了但大小不变，第二次发布复用了同一个依赖仓）。
rsync -a --checksum --delete --exclude '.git' --exclude 'node_modules' \
  ${LINK_DEST:+--link-dest="$LINK_DEST"} "$SRC/" "$TARGET/"

# Python 虚拟环境不在 release 里：它装在 ~/venvs/course（稳定路径），
# 每个 release 里放一个符号链接指过去。**踩过这个坑**：第一次改造发布式部署时，
# .venv 跟着旧目录变成了 legacy-*，新 release 里没有它，doctor 立刻报 python missing——
# ASR 会在下一轮 cycle 直接失败。凡是"跨 release 共享的东西"都要放在 release 之外。
VENV="${HOME_DIR}/venvs/course"
if [ -d "$VENV" ] && [ ! -e "$TARGET/.venv" ]; then
  ln -s "$VENV" "$TARGET/.venv"
  log "   · 链接 Python 环境：$TARGET/.venv → $VENV"
fi

log "② 依赖：按 package-lock.json 的哈希取（依赖仓只增不改）"
LOCK_HASH="$(lock_hash "$TARGET")"
STORE="${DEPS}/${LOCK_HASH}"
if [ -d "$STORE/node_modules" ]; then
  log "   · 依赖仓命中 $LOCK_HASH"
else
  log "   · 依赖仓没有 ${LOCK_HASH}：在 release 里跑一次 npm ci（这一步需要网络）"
  ( cd "$TARGET" && npm ci --no-audit --no-fund ) || {
    rm -rf "$TARGET"
    record_failure deps "npm ci 失败（lock=${LOCK_HASH}）"
    fail "npm ci 失败，当前版本继续服务"
  }
  mkdir -p "$STORE"
  mv "$TARGET/node_modules" "$STORE/node_modules" || fail "把 node_modules 移进依赖仓失败"
fi
# 从依赖仓**硬链接**回来：workspace 的 node_modules/@course/* 是指向 ../../packages/* 的
# 相对符号链接，只有在 release 目录里才解析得对（直接把仓库目录软链给 release 会让这些
# 相对链接指到依赖仓里去）。硬链接不复制数据，只多一个目录项。
rm -rf "$TARGET/node_modules"
cp -al "$STORE/node_modules" "$TARGET/node_modules" || fail "从依赖仓硬链接 node_modules 失败"

log "③ 在 $TARGET 里跑测试（不通过就不切换）"
TEST_LOG="/tmp/release-test-${STAMP}.log"
if ! ( cd "$TARGET" && node --test "packages/*/src/*.test.mjs" "apps/*/src/*.test.mjs" "tools/*.test.mjs" > "$TEST_LOG" 2>&1 ); then
  tail -20 "$TEST_LOG" >&2
  # 没通过的 release 不能留在目录里：回滚是按历史取"上一个"的，
  # 留一个坏的在那儿，下次回滚就可能滚进一个根本起不来的版本。
  rm -rf "$TARGET"
  record_failure test "新版本测试没过（日志：${TEST_LOG}）"
  fail "新版本测试没过（日志：${TEST_LOG}），当前版本继续服务，未通过的目录已删除"
fi
# Node 24 的汇总行是 "ℹ pass N / fail N"（旧版是 "# pass N"），两种都认
grep -E "^(ℹ|#) (pass|fail)" "$TEST_LOG" | tail -2 | sed 's/^/   /' || true

log "④ 切换前检查三个服务单元"
check_roles

log "⑤ 切换符号链接（先建临时链接再 rename，原子）"
if [ -e "$CURRENT" ] && [ ! -L "$CURRENT" ]; then
  # 一次性迁移：把现在的真目录留成第一个 release，再让符号链接指过去
  FIRST="${RELEASES}/legacy-$(date +%Y%m%d-%H%M%S)"
  mv "$CURRENT" "$FIRST"
  ln -sfn "$FIRST" "$CURRENT"
  log "   · 旧目录已保留为 $FIRST"
fi
atomic_link "$TARGET" "$CURRENT"

log "⑥ 重启三个服务并做健康检查（三个都过才算发布成功）"
restart_all
sleep 2
if bad="$(health_check)"; then
  DIGEST="$(tree_digest "$TARGET")"
  {
    printf 'stamp=%s\n' "$STAMP"
    printf 'digest=%s\n' "$DIGEST"
    printf 'lockHash=%s\n' "$LOCK_HASH"
    printf 'source=%s\n' "$SRC"
    for entry in "${SERVICES[@]}"; do
      printf 'service=%s role=%s port=%s health=ok\n' "$(service_name "$entry")" "$(service_role "$entry")" "$(service_port "$entry")"
    done
  } > "${TARGET}/.release-meta"
  # 只有**健康检查通过**才写进成功历史：回滚读的就是这个文件
  printf '%s\n' "$STAMP" >> "${RELEASES}/.history"
  log "   · $(printf '%s' "$DIGEST") lock=$(printf '%s' "$LOCK_HASH")"
else
  log "健康检查没过（${bad}），自动回滚"
  log "   · 这次没切换成的目录留在 ${TARGET}（不在成功历史里，下次清理会带走它），供排查"
  record_failure health "新版本健康检查没过：$bad"
  "$0" --rollback || true
  fail "新版本起不来，已回滚"
fi

log "⑦ 清理旧 release（保留最近 $KEEP 个）与无人使用的依赖仓"
all=()
while IFS= read -r line; do all+=("$line"); done < <(ls -1 "$RELEASES" | sort)
count="${#all[@]}"
if [ "$count" -gt "$KEEP" ]; then
  # 注意：release 数还没到 KEEP 时，${all[@]:0:负数} 会报 substring expression < 0
  for old in "${all[@]:0:$(( count - KEEP ))}"; do
    case "$old" in .history*|.*) continue ;; esac
    # 正在被使用的那个绝不删（符号链接指着的就是它）
    if [ "$(readlink -f "$CURRENT")" = "$(readlink -f "${RELEASES}/${old}")" ]; then continue; fi
    rm -rf "${RELEASES}/${old}"
    # 发布历史里也要划掉，否则回滚可能指到一个已经不存在的目录
    if [ -f "${RELEASES}/.history" ]; then
      grep -v "^${old}\$" "${RELEASES}/.history" > "${RELEASES}/.history.tmp" || true
      mv "${RELEASES}/.history.tmp" "${RELEASES}/.history"
    fi
    log "   · 删除 $old"
  done
fi

if [ -d "$DEPS" ]; then
  used=""
  for meta in "$RELEASES"/*/.release-meta; do
    [ -f "$meta" ] || continue
    used="$used $(grep '^lockHash=' "$meta" | cut -d= -f2)"
  done
  for dir in "$DEPS"/*; do
    [ -d "$dir" ] || continue
    base="$(basename "$dir")"
    case " $used " in *" $base "*) continue ;; esac
    log "   · 删除无人引用的依赖仓 $base"
    rm -rf "$dir"
  done
fi

log "发布完成：$(readlink "$CURRENT")"
