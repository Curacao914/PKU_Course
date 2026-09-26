#!/usr/bin/env python3
"""
硬门 2：校验单个节点笔记 working/notes_第N课_node_{id}.md。

每写完一个节点必须运行。通过（exit 0）后才能跑 mark_node_done.py。
不通过（exit 1）必须修改节点笔记后重跑，不得跳到下一个节点。

校验项（error 拦截 / warn 提示）：
[error] 1. 节点文件存在且非空
[error] 2. 字数 / 转录字数 ≥ NODE_RATIO_MIN（核心：防缩水）
[warn]  3. 字数 / 转录字数 ≤ NODE_RATIO_MAX（疑似生成内容）
[error] 4. 含 META_FOR_NODE 块
[error] 5. outline 里该节点 cases 非空 → 正文必须含「论证意义」
[warn]  6. outline 里该节点 concepts，正文出现率 < 80%
[error] 7. 节点标题带星级（★/★★/★★★）
[warn]  8. 跨节点重复概念未标「参见 / 前述」

用法：
    python verify_node.py --dir ./课程目录 --lesson 3 --node-id 1.1
"""

import argparse
import re
import sys

import note_common as nc


def find_node(outline: dict, node_id: str):
    for n in nc.level2_nodes(outline):
        if n["id"] == node_id:
            return n
    return None


def verify(course_dir: str, lesson: int, node_id: str) -> bool:
    outline = nc.load_json(nc.outline_path(course_dir, lesson))
    if outline is None:
        nc.die("找不到 outline")
    node = find_node(outline, node_id)
    if node is None:
        nc.die(f"outline 中没有节点 {node_id}")

    note_path = nc.node_note_path(course_dir, lesson, node_id)
    errors = []
    warnings = []

    # ---- 1. 文件存在非空 ----
    try:
        with open(note_path, "r", encoding="utf-8") as f:
            text = f.read()
    except FileNotFoundError:
        nc.die(f"节点笔记不存在：{note_path}（请先撰写该节点）")
    if not text.strip():
        nc.die(f"节点笔记为空：{note_path}")

    # ---- 2~3. 字数比率 ----
    tl = node.get("transcript_lines")
    trans_chars = nc.transcript_char_count(course_dir, lesson, tuple(tl)) \
        if tl and len(tl) == 2 else 0
    note_chars = nc.note_char_count(text)
    ratio = (note_chars / trans_chars) if trans_chars else 0

    if trans_chars == 0:
        warnings.append("无法计算转录字数（缺 transcript），跳过比率检查")
    else:
        if ratio < nc.NODE_RATIO_MIN:
            errors.append(
                f"笔记 {note_chars} 字 / 转录 {trans_chars} 字 = {ratio:.2f}，"
                f"低于下限 {nc.NODE_RATIO_MIN} → 内容缩水，需补全该节点细节"
                f"（老师讲到的概念、法条、案例、论证过程是否遗漏？）")
        elif ratio > nc.NODE_RATIO_MAX:
            warnings.append(
                f"笔记 {note_chars} 字 / 转录 {trans_chars} 字 = {ratio:.2f}，"
                f"高于上限 {nc.NODE_RATIO_MAX} → 是否有生成性添加？"
                f"（如确为大量法条原文引用则正常）")

    # ---- 4. META_FOR_NODE 块 ----
    if "META_FOR_NODE" not in text:
        errors.append("缺少 META_FOR_NODE 块（节点末尾应列本节概念/法条/案例/易混点）")

    # ---- 5. 案例论证意义 ----
    cases = node.get("cases", [])
    if cases and "论证意义" not in text:
        errors.append(
            f"该节点 outline 标注了案例 {cases}，但正文缺少「论证意义」"
            f"（每个案例必须说明老师为什么讲它、对主线的论证作用）")

    # ---- 6. 概念覆盖率 ----
    concepts = node.get("concepts", [])
    if concepts:
        present = [c for c in concepts if c in text]
        cov = len(present) / len(concepts)
        if cov < nc.CONCEPT_COVERAGE_MIN:
            missing = [c for c in concepts if c not in text]
            warnings.append(
                f"outline 规划的概念出现率 {cov:.0%}，未在正文出现："
                f"{missing}（确认是否遗漏）")

    # ---- 7. 星级 ----
    if not re.search(r'★', text):
        errors.append("节点标题缺少重要性星级（★ / ★★ / ★★★）")

    # ---- 8. 跨节点重复概念交叉引用 ----
    earlier_concepts = set()
    for n in nc.level2_nodes(outline):
        if n["id"] == node_id:
            break
        earlier_concepts.update(n.get("concepts", []))
    repeated = [c for c in concepts if c in earlier_concepts and c in text]
    if repeated and not re.search(r'参见|前述|前文|上节', text):
        warnings.append(
            f"概念 {repeated} 在更早节点已出现，但本节未见「参见/前述」交叉引用"
            f"（避免重复展开，首次系统讲解的节点展开、其余处交叉引用）")

    # ---- 输出 ----
    for w in warnings:
        nc.warn(w)
    if errors:
        for e in errors:
            nc.fail(e)
        nc.die(f"节点 {node_id} 校验未通过（{len(errors)} 个错误）")

    nc.ok(f"节点 {node_id} 校验通过："
          f"{note_chars} 字 / {trans_chars} 转录字 = {ratio:.2f}"
          + (f"，{len(warnings)} 项建议" if warnings else ""))
    # 把字数信息回传给调用方（mark_node_done 会写进 checklist）
    print(f"STATS char_count={note_chars} ratio={ratio:.3f}")
    return True


def main():
    ap = argparse.ArgumentParser(description="硬门2：单节点笔记校验")
    ap.add_argument("--dir", required=True)
    ap.add_argument("--lesson", type=int, required=True)
    ap.add_argument("--node-id", required=True)
    args = ap.parse_args()
    verify(args.dir, args.lesson, args.node_id)
    sys.exit(0)


if __name__ == "__main__":
    main()
