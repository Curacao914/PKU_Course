#!/usr/bin/env bash
#
# 发布式部署：新代码进独立的 release 目录，**测过再切换**，切换是原子的。
#
# 为什么要有它：以前是 rsync 直接覆盖 ~/course-runtime —— 推到一半断了、或者新代码
# 起不来，手上就没有能回退的版本；而且覆盖式同步意味着"正在跑的东西"和"磁盘上的代码"
# 可能不一致（服务已经加载了旧模块，文件却换成了新的）。
#
# 现在的形状：
#   ~/releases/course/<时间戳>/    每次发布一个完整目录（未改动的文件用硬链接，几乎不占盘）
#   ~/course-runtime -> 上面某个    符号链接指向"当前版本"；systemd 单元里的路径不用改
# 切换只有一条命令（ln -sfn，原子）；出问题就 --rollback 指回上一个 release。
#
# 用法（在服务器上）：
#   deploy/release.sh [来源目录]        默认 ~/course-staging
#   deploy/release.sh --rollback        回到上一个 release
#   KEEP=5 deploy/release.sh            保留最近 5 个 release（默认 3）
set -euo pipefail

HOME_DIR="${HOME}"
RELEASES="${HOME_DIR}/releases/course"
CURRENT="${HOME_DIR}/course-runtime"
KEEP="${KEEP:-3}"
SERVICE="course-site.service"
HEALTH_URL="http://127.0.0.1:3100/healthz"

log() { printf '%s\n' "$*"; }
fail() { printf '发布失败：%s\n' "$*" >&2; exit 1; }

if [ "${1:-}" = "--rollback" ]; then
  [ -L "$CURRENT" ] || fail "~/course-runtime 还不是符号链接，无法回滚（先做一次正常发布）"
  # 按**发布顺序**取上一个，而不是按目录名排序：目录名里既有时间戳又有 legacy-*，
  # 名字排序会把 legacy-* 排到最后，"上一个"于是可能指向当前版本（实测踩到过）。
  HISTORY="${RELEASES}/.history"
  mapfile -t deployed < <(grep -v '^$' "$HISTORY" 2>/dev/null | tail -2 || true)
  [ "${#deployed[@]}" -ge 2 ] || fail "发布历史里只有一个 release，没有可回滚的目标"
  target="${RELEASES}/${deployed[0]}"
  [ -d "$target" ] || fail "回滚目标不存在：$target"
  log "回滚到 $target"
  ln -sfn "$target" "$CURRENT"
  systemctl --user restart "$SERVICE"
  sleep 2
  curl -fsS --max-time 10 "$HEALTH_URL" >/dev/null || fail "回滚后健康检查没过，请人工看一眼"
  log "回滚完成：$(readlink "$CURRENT")"
  exit 0
fi

SRC="${1:-${HOME_DIR}/course-staging}"
[ -d "$SRC" ] || fail "找不到来源目录：$SRC（先 rsync 一份到 ~/course-staging）"
[ -f "$SRC/package.json" ] || fail "$SRC 看起来不是仓库根目录（缺 package.json）"

mkdir -p "$RELEASES"
STAMP="$(date +%Y%m%d-%H%M%S)"
TARGET="${RELEASES}/${STAMP}"

# 上一次发布（用于硬链接，未改动的文件不重复占盘）
LINK_DEST=""
if [ -L "$CURRENT" ]; then LINK_DEST="$(readlink -f "$CURRENT")"; fi

log "① 拷贝到 $TARGET${LINK_DEST:+（以 $LINK_DEST 做硬链接）}"
mkdir -p "$TARGET"
# node_modules **必须排除**：--delete 会把"源里没有、目标里有"的东西删掉，
# 而 node_modules 正是那种东西（源里永远没有它）。第一次跑这个脚本就是这么把
# 新 release 的依赖删光、测试全红的——脚本拒绝切换，所以线上没受影响。
rsync -a --delete --exclude '.git' --exclude 'node_modules' \
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

# 依赖：从上一个 release 硬链接过来（同一块盘、几乎不占空间），没有就借现有的。
if [ ! -e "$TARGET/node_modules" ]; then
  if [ -n "$LINK_DEST" ] && [ -d "$LINK_DEST/node_modules" ]; then
    log "   · 从上一个 release 硬链接 node_modules"
    cp -al "$LINK_DEST/node_modules" "$TARGET/node_modules"
  elif [ -d "$CURRENT/node_modules" ]; then
    log "   · 复用现有 node_modules"
    cp -al "$CURRENT/node_modules" "$TARGET/node_modules"
  fi
fi

log "② 在 $TARGET 里跑测试（不通过就不切换）"
if ! (cd "$TARGET" && node --test "packages/*/src/*.test.mjs" "apps/*/src/*.test.mjs" > "/tmp/release-test-${STAMP}.log" 2>&1); then
  tail -20 "/tmp/release-test-${STAMP}.log" >&2
  # 没通过的 release 不能留在目录里：--rollback 是按名字取"上一个"的，
  # 留一个坏的在那儿，下次回滚就可能滚进一个根本起不来的版本。
  rm -rf "$TARGET"
  fail "新版本测试没过（日志：/tmp/release-test-${STAMP}.log），当前版本继续服务，未通过的目录已删除"
fi
# Node 24 的汇总行是 "ℹ pass N / fail N"（旧版是 "# pass N"），两种都认
grep -E "^(ℹ|#) (pass|fail)" "/tmp/release-test-${STAMP}.log" | tail -2 | sed 's/^/   /' || true

log "③ 切换符号链接（原子）"
if [ -e "$CURRENT" ] && [ ! -L "$CURRENT" ]; then
  # 一次性迁移：把现在的真目录留成第一个 release，再让符号链接指过去
  FIRST="${RELEASES}/legacy-$(date +%Y%m%d-%H%M%S)"
  mv "$CURRENT" "$FIRST"
  ln -sfn "$FIRST" "$CURRENT"
  log "   · 旧目录已保留为 $FIRST"
fi
ln -sfn "$TARGET" "$CURRENT"
# 记一笔发布顺序：回滚要的是"上一次发布的是谁"，这个信息只有这里知道
printf '%s\n' "$STAMP" >> "${RELEASES}/.history"

log "④ 重启服务并做健康检查"
systemctl --user restart "$SERVICE"
sleep 2
if ! curl -fsS --max-time 10 "$HEALTH_URL" >/dev/null; then
  log "健康检查没过，自动回滚"
  "$0" --rollback || true
  fail "新版本起不来，已回滚"
fi

log "⑤ 清理旧 release（保留最近 $KEEP 个）"
mapfile -t all < <(ls -1 "$RELEASES" | sort)
count="${#all[@]}"
if [ "$count" -gt "$KEEP" ]; then
  # 注意：release 数还没到 KEEP 时，${all[@]:0:负数} 会报 substring expression < 0
  for old in "${all[@]:0:$(( count - KEEP ))}"; do
    # 正在被使用的那个绝不删（符号链接指着的就是它）
    if [ "$(readlink -f "$CURRENT")" = "$(readlink -f "$RELEASES/$old")" ]; then continue; fi
    rm -rf "${RELEASES}/${old}"
    # 发布历史里也要划掉，否则回滚可能指到一个已经不存在的目录
    if [ -f "${RELEASES}/.history" ]; then
      grep -v "^${old}$" "${RELEASES}/.history" > "${RELEASES}/.history.tmp" || true
      mv "${RELEASES}/.history.tmp" "${RELEASES}/.history"
    fi
    log "   · 删除 $old"
  done
fi

log "发布完成：$(readlink "$CURRENT")"
