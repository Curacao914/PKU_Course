#!/usr/bin/env bash
#
# 从本机把当前代码推成一个新 release（在服务器上执行 deploy/release.sh）。
#
# 用法：
#   deploy/push-release.sh                 # 同步 + 发布（默认 ubuntu@124.222.111.108）
#   deploy/push-release.sh --sync-only     # 只同步到 ~/course-staging，不发布
#   deploy/push-release.sh user@host       # 换主机
#
# 正常发布会先从 staging 安装/更新 systemd 单元（只 daemon-reload，不提前重启），
# 再跑 release.sh。这样首次新增服务也不会出现“release 要求单元已存在、但单元又在新 release 里”
# 的鸡生蛋问题。--sync-only 仍保留给人工检查。
#
# 只推代码（apps/packages/tools/docs/deploy + 根目录的 package.json / package-lock.json），
# 不含 node_modules 与 .git；真正的切换、测试、回滚都在服务器侧的 deploy/release.sh 里做。
set -euo pipefail

SYNC_ONLY=0
ARGS=()
for arg in "$@"; do
  case "$arg" in
    --sync-only) SYNC_ONLY=1 ;;
    -h|--help) sed -n '2,18p' "$0"; exit 0 ;;
    *) ARGS+=("$arg") ;;
  esac
done
HOST="${ARGS[0]:-ubuntu@124.222.111.108}"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
STAGING="/home/ubuntu/course-staging"

echo "① 同步到 $HOST:$STAGING"
# 一个目录一条 rsync：多来源 + 目标结尾带斜杠会把各自的内容**摊平**到目标根目录，
# apps/ 与 packages/ 的顶层于是混在一起（这个坑踩过两次，别再合并成一条）。
for dir in apps packages tools docs deploy; do
  ssh "$HOST" "mkdir -p '$STAGING/$dir'"
  rsync -az --delete --exclude node_modules --exclude .git "$ROOT/$dir/" "$HOST:$STAGING/$dir/"
done
# package-lock.json 必须一起推：发布脚本按它的哈希选依赖仓，**没有它就拒绝发布**
# （依赖必须与锁文件一致）。以前只推 package.json，第一次跑 A2 的发布时就会卡在这里。
for file in package.json package-lock.json; do
  [ -f "$ROOT/$file" ] || { echo "缺 $ROOT/$file，无法发布" >&2; exit 1; }
  rsync -az "$ROOT/$file" "$HOST:$STAGING/$file"
done

if [ "$SYNC_ONLY" = 1 ]; then
  echo "② 只同步，不发布（--sync-only）。"
  echo "   要装单元：ssh $HOST 'bash $STAGING/deploy/install-units.sh --restart'"
  echo "   要发布：  ssh $HOST 'bash $STAGING/deploy/release.sh $STAGING'"
  exit 0
fi

echo "② 先从 staging 安装/更新 systemd 单元（只 daemon-reload，不提前重启）"
ssh "$HOST" "cd ~ && bash \"$STAGING/deploy/install-units.sh\""

echo "③ 在服务器上发布（测试不过就不切换；切换后统一重启三个服务）"
ssh "$HOST" "cd ~ && bash \"$STAGING/deploy/release.sh\" \"$STAGING\""

echo "④ 完成。"
echo "   回滚：ssh $HOST 'bash ~/course-staging/deploy/release.sh --rollback'"
