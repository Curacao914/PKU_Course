#!/usr/bin/env python3
"""
硬门 1：校验 A 步骤产出的 outline.json。

在 A 步骤产出 outline.json 之后、init_checklist.py 之前必须运行。
任何一项 fail（exit 1）都不得进入 B 步骤。

校验项：
1. 顶层必填字段（course_name / lesson_num / main_thread / outline）
2. 每个 level-2 节点必填字段（id / title / transcript_lines / writer_brief）
3. transcript_lines 区间合法（start ≤ end，且落在转录总行数内）
4. 单节点行数 ≤ NODE_MAX_LINES（核心约束，防止模型把节点做大后缩水）
5. 节点之间行号不重叠、基本覆盖转录（允许 appendix 留白）
6. level-2 节点挂在合法的 level-1 父节点下

用法：
    python validate_outline.py --dir ./课程目录 --lesson 3
"""

import argparse
import sys

import note_common as nc


def validate(course_dir: str, lesson: int) -> bool:
    outline = nc.load_json(nc.outline_path(course_dir, lesson))
    if outline is None:
        nc.die(f"找不到 outline：{nc.outline_path(course_dir, lesson)}")

    errors = []
    warnings = []

    # ---- 1. 顶层字段 ----
    for field in ("course_name", "lesson_num", "main_thread", "outline"):
        if field not in outline:
            errors.append(f"outline.json 缺少顶层字段：{field}")
    if errors:
        for e in errors:
            nc.fail(e)
        nc.die("顶层字段不完整")

    # ---- 转录总行数（用于区间合法性检查）----
    seg_meta = nc.load_json(nc.segments_meta_path(course_dir, lesson))
    total_lines = None
    if seg_meta:
        total_lines = seg_meta.get("total_lines")

    l1_ids = {n["id"] for n in nc.level1_nodes(outline)}
    nodes = nc.level2_nodes(outline)

    if not nodes:
        nc.die("outline 中没有任何 level-2 节点")

    # ---- 2~4. 逐节点检查 ----
    intervals = []
    for n in nodes:
        nid = n.get("id", "?")
        # 必填字段
        for field in ("id", "title", "transcript_lines", "writer_brief"):
            if field not in n or n[field] in (None, "", []):
                errors.append(f"节点 {nid} 缺少必填字段：{field}")

        # 父节点合法性
        parent = n.get("parent_id")
        if parent and parent not in l1_ids:
            warnings.append(f"节点 {nid} 的 parent_id={parent} 不在 level-1 节点中")

        # transcript_lines 合法性
        tl = n.get("transcript_lines")
        if isinstance(tl, list) and len(tl) == 2:
            start, end = tl
            if not (isinstance(start, int) and isinstance(end, int)):
                errors.append(f"节点 {nid} 的 transcript_lines 必须是两个整数")
                continue
            if start > end:
                errors.append(f"节点 {nid} 的 transcript_lines 起点 > 终点：{tl}")
                continue
            if total_lines and end > total_lines:
                errors.append(
                    f"节点 {nid} 的 transcript_lines 终点 {end} "
                    f"超过转录总行数 {total_lines}")
            span = end - start + 1
            # 核心约束
            if span > nc.NODE_MAX_LINES:
                errors.append(
                    f"节点 {nid}「{n.get('title', '')[:20]}」对应 {span} 行转录，"
                    f"超过上限 {nc.NODE_MAX_LINES} 行 → 必须拆成更细的 level-2 节点，"
                    f"或在 B+ 流程中按 level-3 子节点细分")
            elif span < nc.NODE_MIN_LINES:
                warnings.append(
                    f"节点 {nid}「{n.get('title', '')[:20]}」仅 {span} 行，"
                    f"偏碎，考虑与相邻节点合并")
            intervals.append((start, end, nid))
        else:
            errors.append(f"节点 {nid} 的 transcript_lines 格式错误（应为 [start, end]）")

    # ---- 5. 区间重叠检查 ----
    intervals.sort()
    for i in range(1, len(intervals)):
        prev_end = intervals[i - 1][1]
        cur_start = intervals[i][0]
        if cur_start <= prev_end:
            warnings.append(
                f"节点 {intervals[i-1][2]} 与 {intervals[i][2]} 行号重叠："
                f"{intervals[i-1][2]} 止于 {prev_end}，{intervals[i][2]} 始于 {cur_start}")

    # ---- 覆盖率检查（仅 warn）----
    if total_lines and intervals:
        covered = sum(e - s + 1 for s, e, _ in intervals)
        appendix_lines = 0
        for ap in outline.get("appendix_topics", []):
            tl = ap.get("transcript_lines")
            if isinstance(tl, list) and len(tl) == 2:
                appendix_lines += tl[1] - tl[0] + 1
        coverage = (covered + appendix_lines) / total_lines
        if coverage < 0.85:
            warnings.append(
                f"节点 + 附录仅覆盖 {coverage:.0%} 的转录（{covered + appendix_lines}"
                f"/{total_lines} 行），可能有内容未纳入任何节点")

    # ---- 输出 ----
    for w in warnings:
        nc.warn(w)
    if errors:
        for e in errors:
            nc.fail(e)
        nc.die(f"outline 校验未通过（{len(errors)} 个错误）")

    nc.ok(f"outline 校验通过：{len(nodes)} 个 level-2 节点，"
          f"均 ≤ {nc.NODE_MAX_LINES} 行"
          + (f"，{len(warnings)} 项建议" if warnings else ""))
    return True


def main():
    ap = argparse.ArgumentParser(description="硬门1：校验 outline.json")
    ap.add_argument("--dir", required=True, help="课程目录")
    ap.add_argument("--lesson", type=int, required=True, help="课次号")
    args = ap.parse_args()
    validate(args.dir, args.lesson)
    sys.exit(0)


if __name__ == "__main__":
    main()
