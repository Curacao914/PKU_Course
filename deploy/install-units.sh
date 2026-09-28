#!/usr/bin/env bash
#
# 把仓库里的 systemd 单元装到 ~/.config/systemd/user/（幂等，可反复执行）。
#
# 为什么要有它：这两个服务的真实配置以前**只存在于服务器上**——重装、换机、或别人接手时
# 只能靠记忆复原，而"公开进程里有没有机密"恰恰取决于单元里的角色与环境文件。
# 现在仓库是唯一来源：改单元 → 跑这个脚本 → 重启。
#
# 用法（在服务器上的仓库目录或 release 目录里）：
#   deploy/install-units.sh                 # 安装/更新单元 + daemon-reload（不重启服务）
#   deploy/install-units.sh --restart       # 顺带 enable --now 并做健康检查
#   deploy/install-units.sh --dry-run       # 只打印将要做什么
set -euo pipefail

UNITS_DIR="${HOME}/.config/systemd/user"
ENV_DIR="${HOME}/.course-worker"
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
UNITS=(course-site.service course-admin.service)
NODE_BIN="${COURSE_NODE_BIN:-$(command -v node || true)}"
DRY_RUN=0
RESTART=0

for arg in "$@"; do
  case "$arg" in
    --dry-run) DRY_RUN=1 ;;
    --restart) RESTART=1 ;;
    -h|--help) sed -n '2,14p' "$0"; exit 0 ;;
    *) printf '未知参数：%s\n' "$arg" >&2; exit 2 ;;
  esac
done

[ -n "$NODE_BIN" ] || { echo "找不到 node（可用 COURSE_NODE_BIN 显式指定）" >&2; exit 1; }
# 早失败：这个脚本是给服务器（带 systemd）用的，本机跑不出正确结果，
# 与其在最后一步静默失败，不如现在就报清楚。
if [ "$DRY_RUN" = 0 ] && ! command -v systemctl >/dev/null 2>&1; then
  printf '找不到 systemctl：本脚本要在装了 systemd 的服务器上执行（user 单元装在 ~/.config/systemd/user）\n' >&2
  exit 1
fi
run() { if [ "$DRY_RUN" = 1 ]; then printf '   [dry-run] %s\n' "$*"; else "$@"; fi }

mkdir -p "$UNITS_DIR"
# 注意：不要写成 "${UNITS_DIR}（...）"——bash 会把紧跟其后的全角括号当成变量名的一部分
# （实测报 unbound variable）。凡变量后面紧接中文，一律用 printf 的 %s。
printf '单元目录：%s（node=%s）\n' "$UNITS_DIR" "$NODE_BIN"

for unit in "${UNITS[@]}"; do
  src="$ROOT/deploy/$unit"
  dst="$UNITS_DIR/$unit"
  [ -f "$src" ] || { echo "缺单元文件：$src" >&2; exit 1; }
  # 角色必须显式写在单元里：静默退回 all 会把管理台挂到公开进程上、并加载全部机密
  if ! grep -q '^Environment=COURSE_SITE_ROLE=' "$src"; then
    printf '单元 %s 没有显式声明 COURSE_SITE_ROLE（不允许静默退回 all）\n' "$unit" >&2
    exit 1
  fi
  role="$(grep -o 'COURSE_SITE_ROLE=[a-z]*' "$src" | head -1 | cut -d= -f2)"
  tmp="$(mktemp)"
  sed "s|__NODE__|$NODE_BIN|g" "$src" > "$tmp"
  if [ -f "$dst" ] && cmp -s "$tmp" "$dst"; then
    printf '· %s 已是最新（role=%s）\n' "$unit" "$role"
    rm -f "$tmp"
    continue
  fi
  if [ -f "$dst" ]; then
    backup="$dst.bak-$(date +%Y%m%d-%H%M%S)"
    printf '· %s 有变化，旧文件留一份：%s\n' "$unit" "$(basename "$backup")"
    run cp -p "$dst" "$backup"
  fi
  run install -m 0644 "$tmp" "$dst"
  rm -f "$tmp"
  printf '· 安装 %s（role=%s）\n' "$unit" "$role"
done

# 公开环境文件：只在缺失时从模板复制，**绝不覆盖**已有配置
# （目录可能还不存在——新机器上 ~/.course-worker 还没建）
[ -d "$ENV_DIR" ] || run mkdir -p "$ENV_DIR"
if [ ! -f "$ENV_DIR/env.public" ]; then
  printf '· 生成 %s（来自 deploy/env.public.example，装完请核对里面的路径）\n' "$ENV_DIR/env.public"
  run install -m 0644 "$ROOT/deploy/env.public.example" "$ENV_DIR/env.public"
else
  printf '· %s 已存在，不动它\n' "$ENV_DIR/env.public"
fi

run systemctl --user daemon-reload

if [ "$RESTART" = 1 ]; then
  run systemctl --user enable --now "${UNITS[@]}"
  sleep 2
  for port in 3100 3101; do
    if curl -fsS --max-time 5 "http://127.0.0.1:$port/healthz" >/dev/null 2>&1; then
      printf '· :%s 健康\n' "$port"
    else
      printf '· :%s 健康检查没过（journalctl --user -u course-site.service 看日志）\n' "$port" >&2
    fi
  done
fi

echo "完成。nginx 配置见 deploy/nginx-course.conf.example（不要直接覆盖 /etc 里的文件，先 diff）。"
