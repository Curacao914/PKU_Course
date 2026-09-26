#!/usr/bin/env python3
"""
把节点标记为 done —— 但会先自己重跑一遍 verify_node，
确保模型不能跳过校验直接 mark done。

这是状态机的写入端：只有 verify 通过，才把 checklist 里对应节点
status 改为 done，并记录字数/比率/时间。

用法：
    python mark_node_done.py --dir ./课程目录 --lesson 3 --node-id 1.1
"""

import argparse
import datetime
import io
import sys
from contextlib import redirect_stdout

import note_common as nc
import verify_node


def mark(course_dir: str, lesson: int, node_id: str):
    cl_path = nc.checklist_path(course_dir, lesson)
    checklist = nc.load_json(cl_path)
    if checklist is None:
        nc.die("找不到 checklist，请先跑 init_checklist.py")

    target = None
    for n in checklist["nodes"]:
        if n["id"] == node_id:
            target = n
            break
    if target is None:
        nc.die(f"checklist 中没有节点 {node_id}")

    # 关键：mark 之前强制重跑 verify，杜绝跳过校验。
    # verify_node.verify 内部 fail 会直接 sys.exit(1)，本脚本随之中止。
    buf = io.StringIO()
    try:
        with redirect_stdout(buf):
            verify_node.verify(course_dir, lesson, node_id)
    except SystemExit as e:
        # verify 内部 die 了 → 把它的输出透传出来再退出
        print(buf.getvalue(), end="")
        if e.code and e.code != 0:
            nc.die(f"节点 {node_id} 未通过 verify_node，不能标记 done")
        raise

    # 解析 verify 输出里的 STATS 行
    char_count, ratio = None, None
    for line in buf.getvalue().splitlines():
        if line.startswith("STATS"):
            for kv in line.split()[1:]:
                k, _, v = kv.partition("=")
                if k == "char_count":
                    char_count = int(v)
                elif k == "ratio":
                    ratio = float(v)

    target["status"] = "done"
    target["verified_at"] = datetime.datetime.now().strftime("%Y-%m-%d %H:%M")
    target["char_count"] = char_count
    target["ratio"] = ratio
    nc.dump_json(cl_path, checklist)

    done = sum(1 for n in checklist["nodes"] if n["status"] == "done")
    total = checklist["total_nodes"]
    nc.ok(f"节点 {node_id} 已标记 done（{done}/{total}）")
    if done < total:
        remaining = [n["id"] for n in checklist["nodes"]
                     if n["status"] != "done"]
        print(f"   剩余待写：{remaining}")
    else:
        print("   所有节点完成 ✅ 可以运行 assemble.py 进入拼装。")


def main():
    ap = argparse.ArgumentParser(description="标记节点完成（先强制 verify）")
    ap.add_argument("--dir", required=True)
    ap.add_argument("--lesson", type=int, required=True)
    ap.add_argument("--node-id", required=True)
    args = ap.parse_args()
    mark(args.dir, args.lesson, args.node_id)
    sys.exit(0)


if __name__ == "__main__":
    main()
