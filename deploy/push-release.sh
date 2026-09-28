#!/usr/bin/env bash
#
# 从本机把当前代码推成一个新 release（在服务器上执行 deploy/release.sh）。
#
# 用法：deploy/push-release.sh [user@host]     默认 ubuntu@124.222.111.108
# 只推代码（apps/packages/tools/docs/deploy/package*.json），不含 node_modules 与 .git；
# 真正的切换、测试、回滚都在服务器侧的 deploy/release.sh 里做。
set -euo pipefail
HOST="${1:-ubuntu@124.222.111.108}"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
STAGING="/home/ubuntu/course-staging"

echo "① 同步到 $HOST:$STAGING"
# 一个目录一条 rsync：多来源 + 目标结尾带斜杠会把各自的内容**摊平**到目标根目录，
# apps/ 与 packages/ 的顶层于是混在一起（这个坑踩过两次，别再合并成一条）。
for dir in apps packages tools docs deploy; do
  ssh "$HOST" "mkdir -p '$STAGING/$dir'"
  rsync -az --delete --exclude node_modules --exclude .git "$ROOT/$dir/" "$HOST:$STAGING/$dir/"
done
rsync -az "$ROOT/package.json" "$HOST:$STAGING/package.json"

echo "② 在服务器上发布（测试不过就不切换）"
ssh "$HOST" "cd ~ && bash \"$STAGING/deploy/release.sh\" \"$STAGING\""

echo "③ 完成。回滚：ssh $HOST 'bash ~/course-staging/deploy/release.sh --rollback'"
