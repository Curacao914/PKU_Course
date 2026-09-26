#!/usr/bin/env python3
"""
从校验通过的 outline.json 生成节点 checklist（状态机）。

必须在 validate_outline.py 通过之后运行。
生成的 checklist 是 B 步骤主循环的依据，也是 assemble.py 的准入凭证。

checklist 结构：
{
  "lesson_num": 3,
  "total_nodes": 8,
  "nodes": [
    {
      "id": "1.1",
      "title": "（一）作品的构成要件",
      "transcript_lines": [15, 168],
      "line_count": 154,
      "status": "pending",        # pending | done
      "needs_subdivision": false, # 行数接近上限时提示考虑 B+
      "verified_at": null,
      "char_count": null,
      "ratio": null
    }
  ]
}

用法：
    python init_checklist.py --dir ./课程目录 --lesson 3
    python init_checklist.py --dir ./课程目录 --lesson 3 --force  # 覆盖重建
"""

import argparse
import os
import sys

import note_common as nc


def init(course_dir: str, lesson: int, force: bool = False):
    cl_path = nc.checklist_path(course_dir, lesson)
    if os.path.exists(cl_path) and not force:
        existing = nc.load_json(cl_path)
        done = sum(1 for n in existing.get("nodes", [])
                   if n.get("status") == "done")
        nc.warn(f"checklist 已存在（{done}/{existing.get('total_nodes')} 完成）。"
                f"如需重建用 --force（会丢失进度）。")
        sys.exit(0)

    outline = nc.load_json(nc.outline_path(course_dir, lesson))
    if outline is None:
        nc.die("找不到 outline，请先完成 A 步骤并通过 validate_outline.py")

    nodes = []
    for n in nc.level2_nodes(outline):
        tl = n.get("transcript_lines", [0, 0])
        span = tl[1] - tl[0] + 1 if len(tl) == 2 else 0
        nodes.append({
            "id": n["id"],
            "title": n.get("title", ""),
            "parent_id": n.get("parent_id"),
            "transcript_lines": tl,
            "line_count": span,
            "ppt_pages": n.get("ppt_pages", []),
            "status": "pending",
            # 行数 ≥ 上限的 80% 时提示在 B 步骤考虑 level-3 细分
            "needs_subdivision": span >= int(nc.NODE_MAX_LINES * 0.8),
            "verified_at": None,
            "char_count": None,
            "ratio": None,
        })

    checklist = {
        "lesson_num": lesson,
        "course_name": outline.get("course_name", ""),
        "total_nodes": len(nodes),
        "nodes": nodes,
    }
    nc.dump_json(cl_path, checklist)

    sub = sum(1 for n in nodes if n["needs_subdivision"])
    nc.ok(f"checklist 已建立：{len(nodes)} 个节点待撰写"
          + (f"，其中 {sub} 个接近行数上限（建议 B+ 细分）" if sub else ""))
    print(f"   → {cl_path}")
    print("\n   B 步骤主循环：按 nodes[] 顺序逐个撰写，每个节点写完后跑")
    print("   verify_node.py + mark_node_done.py，全部 done 才能 assemble。")


def main():
    ap = argparse.ArgumentParser(description="从 outline 建节点 checklist")
    ap.add_argument("--dir", required=True)
    ap.add_argument("--lesson", type=int, required=True)
    ap.add_argument("--force", action="store_true", help="覆盖重建（丢进度）")
    args = ap.parse_args()
    init(args.dir, args.lesson, args.force)
    sys.exit(0)


if __name__ == "__main__":
    main()
