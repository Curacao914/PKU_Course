#!/usr/bin/env bash
# 切片粒度对比实验：同一节课，分别在「不切 / 切两段 / 切三段」下生成笔记，然后并排比较。
#
#   在服务器上运行（需要 ~/.course-worker/env 里的模型与凭据）：
#     bash deploy/experiment-slices.sh <replay-key> [输出根目录]
#
# 产物：
#   <输出根目录>/E1-whole/    不切（目标 1 个节点，整节课一次写完）
#   <输出根目录>/E2-two/      切两段
#   <输出根目录>/E3-three/    切三段
# 每个目录里有 note.md、lesson-state.json，最后打印 tools/compare-notes.mjs 的对照表。
#
# 说明：三种配置共用同一份转录稿与同一套提示词，只有"目标节点数"不同；
# 指定目标节点数时程序会关闭按体量再切分，否则大纲给一个节点又会被切成十几个。
set -euo pipefail

REPLAY_KEY="${1:?用法: experiment-slices.sh <replay-key> [输出根目录]}"
OUT_ROOT="${2:-$HOME/.course-worker/experiments/${REPLAY_KEY}-slices}"
RUNTIME_DIR="${COURSE_RUNTIME_DIR:-$HOME/course-runtime}"
REPLAY_DIR="$HOME/.course-worker/replays/${REPLAY_KEY}"
TRANSCRIPT="$REPLAY_DIR/transcript/raw-transcript.md"

[ -f "$TRANSCRIPT" ] || { echo "找不到转录稿：$TRANSCRIPT" >&2; exit 2; }
cd "$RUNTIME_DIR"

COURSE=$(node -e "const s=require('$REPLAY_DIR/transcript/run-summary.json');process.stdout.write(s.courseName)")
LESSON=$(node -e "const s=require('$REPLAY_DIR/transcript/run-summary.json');process.stdout.write(s.lessonName)")
echo "课程：$COURSE / 课次：$LESSON"
echo "转录：$TRANSCRIPT"
echo "输出：$OUT_ROOT"
echo

run_variant() {
  local label="$1" nodes="$2"
  local dir="$OUT_ROOT/$label"
  mkdir -p "$dir"
  echo "=== ${label}（目标 $nodes 个节点）$(date +%H:%M:%S) ==="
  node apps/worker/bin/course.mjs notes \
    --transcript "$TRANSCRIPT" \
    --course "$COURSE" --lesson "$LESSON" \
    --outline-nodes "$nodes" \
    --output-dir "$dir" > "$dir/run.log" 2>&1 || echo "（该变体以非零退出，见 $dir/run.log）"
  tail -2 "$dir/run.log" || true
  echo
}

run_variant "E1-whole" 1
run_variant "E2-two" 2
run_variant "E3-three" 3

echo "=== 对照表 ==="
node tools/compare-notes.mjs \
  "$OUT_ROOT/E1-whole" "$OUT_ROOT/E2-two" "$OUT_ROOT/E3-three" \
  ${COURSE_PRICE_IN:+--price-in "$COURSE_PRICE_IN"} \
  ${COURSE_PRICE_OUT:+--price-out "$COURSE_PRICE_OUT"} || true

echo
echo "成品：$OUT_ROOT/E{1-whole,2-two,3-three}/2026-*.md"
