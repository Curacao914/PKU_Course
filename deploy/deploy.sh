#!/usr/bin/env bash
# 把本仓库同步到服务器并准备依赖。幂等，可反复执行。
#
#   COURSE_SSH_HOST=ubuntu@1.2.3.4 ./deploy/deploy.sh
#
# 只同步代码；~/.course-worker/env 位于仓库之外，不会被覆盖。
set -euo pipefail

SSH_KEY="${COURSE_SSH_KEY:-$HOME/.ssh/lawtech-tencent}"
SSH_HOST="${COURSE_SSH_HOST:-ubuntu@124.222.111.108}"
REMOTE_DIR="${COURSE_REMOTE_DIR:-/home/ubuntu/course-runtime}"
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

echo "== 同步到 ${SSH_HOST}:${REMOTE_DIR} =="
rsync -az --delete \
  --exclude node_modules --exclude .git --exclude .reference \
  --exclude '*.log' --exclude '.venv' --exclude '.DS_Store' \
  -e "ssh -i ${SSH_KEY} -o BatchMode=yes" \
  "${ROOT}/" "${SSH_HOST}:${REMOTE_DIR}/"

echo "== 远端准备依赖 =="
ssh -i "${SSH_KEY}" -o BatchMode=yes "${SSH_HOST}" bash -s <<REMOTE
set -e
cd "${REMOTE_DIR}"
npm install --no-audit --no-fund --silent
[ -d .venv ] || python3 -m venv .venv
.venv/bin/pip install --quiet --upgrade pip
.venv/bin/pip install --quiet -r packages/asr/python/requirements.txt
node apps/worker/bin/course.mjs doctor
REMOTE
