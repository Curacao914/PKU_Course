#!/usr/bin/env bash
# 给 openclaw-weixin 插件打一个补丁：**主动推送时回退使用已存的 context_token**。
#
# 为什么需要它：这个微信机器人通道要求出站消息带上"用户最近一次来信时平台发的
# context_token"。插件的回复路径会去取它，但 CLI / 定时任务这种**主动推送**路径不会，
# 结果是接口照常返回 messageId（看起来发送成功），微信端却收不到。
# 实测日志：sendWeixinOutbound: contextToken missing for to=…, sending without context
#
# 补丁只影响"本来就没带 context 的那些发送"，因此是严格改进。
# 插件升级或重装会覆盖掉它，重跑本脚本即可（幂等）。
#
#   ./deploy/patch-weixin-context.sh [插件目录]
set -euo pipefail

ROOT="${1:-$HOME/.openclaw-candidate/npm/projects}"
TARGET="$(find "$ROOT" -path '*@tencent-weixin/openclaw-weixin/dist/src/channel.js' 2>/dev/null | head -1 || true)"
if [ -z "$TARGET" ]; then
  echo "没找到插件文件（在 $ROOT 下找 @tencent-weixin/openclaw-weixin/dist/src/channel.js）" >&2
  exit 1
fi

if grep -q 'PATCH(course.law-tech.dev)' "$TARGET"; then
  echo "已经打过补丁：$TARGET"
  exit 0
fi

cp "$TARGET" "$TARGET.orig-before-context-fallback"
python3 - "$TARGET" <<'PY'
import sys
path = sys.argv[1]
text = open(path, encoding='utf-8').read()
old = """    if (!params.contextToken) {
        aLog.warn(`sendWeixinOutbound: contextToken missing for to=${params.to}, sending without context`);
    }
"""
new = """    if (!params.contextToken) {
        // PATCH(course.law-tech.dev)：主动推送（CLI / 定时任务）走不到「回复」那条路径，
        // 插件不会去取已存的 context_token —— 结果 API 返回了 messageId、微信端却收不到。
        // 回退到该用户最近一次来信时拿到的 token。
        params.contextToken = getContextToken(account.accountId, params.to);
        if (!params.contextToken) {
            aLog.warn(`sendWeixinOutbound: contextToken missing for to=${params.to}, sending without context`);
        }
    }
"""
if old not in text:
    print('未找到待替换片段：插件版本可能变了，请人工检查', file=sys.stderr)
    sys.exit(1)
open(path, 'w', encoding='utf-8').write(text.replace(old, new, 1))
print('已打补丁')
PY
echo "改完重启网关：systemctl --user restart openclaw-gateway"
