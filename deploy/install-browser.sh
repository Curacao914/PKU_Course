#!/usr/bin/env bash
# 在服务器上安装 Playwright 自带的 Chromium。
#
#   ./deploy/install-browser.sh
#
# 为什么不用官方的 `npx playwright install`：
#   服务器在国内，cdn.playwright.dev 会 307 跳转到被墙的 Google CDN，
#   实际下载速度 0 B/s，表现为无限期卡在 0%。必须换 npmmirror 镜像。
#
# 另注：不要把 npx 版和本地安装版同时跑，两者会抢 ~/.cache/ms-playwright/__dirlock，
# 表现为互相等待而毫无进展。安装前先清干净残留进程与锁。
set -euo pipefail

SSH_KEY="${COURSE_SSH_KEY:-$HOME/.ssh/lawtech-tencent}"
SSH_HOST="${COURSE_SSH_HOST:-ubuntu@124.222.111.108}"
PW_VERSION="${PLAYWRIGHT_VERSION:-1.63.0}"
MIRROR="${PLAYWRIGHT_DOWNLOAD_HOST:-https://cdn.npmmirror.com/binaries/playwright}"

ssh -i "${SSH_KEY}" -o BatchMode=yes "${SSH_HOST}" bash -s <<REMOTE
set -e
pkill -f playwright 2>/dev/null || true
pkill -f oopBrowserDownload 2>/dev/null || true
sleep 2
rm -rf ~/.cache/ms-playwright/__dirlock

mkdir -p ~/pw-tools && cd ~/pw-tools
npm install playwright@${PW_VERSION} --no-audit --no-fund --silent

echo "== 从镜像下载 Chromium =="
PLAYWRIGHT_DOWNLOAD_HOST=${MIRROR} ./node_modules/.bin/playwright install chromium

echo "== 结果 =="
find ~/.cache/ms-playwright -maxdepth 3 -type f -name chrome
du -sh ~/.cache/ms-playwright
REMOTE

cat <<'NOTE'

把上面输出的 chrome 路径写入 ~/.course-worker/env：

    COURSE_CHROME_PATH=<chrome 绝对路径>

然后验证：

    node ~/course-runtime/apps/worker/bin/course.mjs doctor

doctor 的 binaries.chrome 与 ready.chrome 都应为实际路径与 true。
NOTE
