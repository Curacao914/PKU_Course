#!/usr/bin/env python3
"""
硬门 3 + 纯机械拼装。

准入检查：checklist 全部节点 status == done，否则 exit 1。
（模型无法在节点未写完时跳到拼装，因为这一步是脚本，不是模型自觉。）

拼装动作（全部机械执行，模型不写一个字正文）：
1. 按 outline 顺序拼接所有 working/notes_第N课_node_*.md
2. 在每个 level-1 标题处插入标题行 + {{H1_SUMMARY:id}} 占位
3. 每个 level-1 区段末尾插 {{H1_QUIZ:id}} 占位
4. 抽取所有节点的 META_FOR_NODE 块，去重，合并成末尾 <details> 折叠框
5. 顶部插 {{COURSE_OVERVIEW}} 占位，尾部插 {{KNOWLEDGE_LINK}} / {{APPENDIX}} 占位
6. 输出 working/第N课_assembled.md（含占位符，待 splice 填充）

占位符由 C 步骤模型产出的 splice_inputs.json 通过 splice.py 替换，
模型只产出结构化数据，不重写正文 → 物理上无法压缩节点内容。

用法：
    python assemble.py --dir ./课程目录 --lesson 3
"""

import argparse
import os
import re
import sys

import note_common as nc


# 中文数字（一级标题编号）
_CN_NUM = "一二三四五六七八九十"


def cn_index(i: int) -> str:
    """0-based → 一、二、三…"""
    return _CN_NUM[i] if i < len(_CN_NUM) else str(i + 1)


def gate_all_done(checklist: dict):
    pending = [n["id"] for n in checklist["nodes"] if n["status"] != "done"]
    if pending:
        nc.die(f"以下节点尚未完成（status != done），不能拼装：{pending}\n"
               f"   请逐个完成 verify_node + mark_node_done 后再 assemble。")


def extract_meta(node_text: str) -> list:
    """从节点笔记抽取 META_FOR_NODE 块里的 TYPE: VALUE 行。"""
    out = []
    m = re.search(r'META_FOR_NODE:\s*\n(.*?)(?:\n\s*\n|$)', node_text, re.DOTALL)
    if not m:
        return out
    for line in m.group(1).splitlines():
        mm = re.match(r'\s*-?\s*(CONCEPT|PROVISION|CASE|PITFALL):\s*(.+?)\s*$',
                      line)
        if mm:
            out.append((mm.group(1), mm.group(2).strip()))
    return out


def strip_meta_block(node_text: str) -> str:
    """拼装进正文时去掉节点末尾的 META_FOR_NODE 块（会统一汇总到文末）。"""
    # 去掉可能的 HTML 注释引导行 + META_FOR_NODE 块
    text = re.sub(r'<!--\s*META 收纳.*?-->\s*', '', node_text, flags=re.DOTALL)
    text = re.sub(r'META_FOR_NODE:\s*\n(.*?)(?:\n\s*\n|$)', '',
                  text, flags=re.DOTALL)
    return text.rstrip()


def build_meta_block(metas: list) -> str:
    """去重并按类型排序，生成末尾折叠框。"""
    seen = set()
    ordered = []
    type_order = {"CONCEPT": 0, "PROVISION": 1, "CASE": 2, "PITFALL": 3}
    for t, v in metas:
        key = (t, v)
        if key not in seen:
            seen.add(key)
            ordered.append((t, v))
    ordered.sort(key=lambda x: (type_order.get(x[0], 9), x[1]))
    lines = "\n".join(f"META: {t}: {v}" for t, v in ordered)
    return ("<details><summary>📑 笔记元数据（用于跨课整合）</summary>\n"
            "<pre><code>\n"
            f"{lines}\n"
            "</code></pre>\n"
            "</details>")


def assemble(course_dir: str, lesson: int):
    checklist = nc.load_json(nc.checklist_path(course_dir, lesson))
    if checklist is None:
        nc.die("找不到 checklist，请先跑 init_checklist.py")
    gate_all_done(checklist)

    outline = nc.load_json(nc.outline_path(course_dir, lesson))
    course_name = outline.get("course_name", checklist.get("course_name", ""))

    # level-1 → 其下 level-2 节点（按 outline 顺序）
    l1_list = nc.level1_nodes(outline)
    l1_by_id = {n["id"]: n for n in l1_list}
    children = {n["id"]: [] for n in l1_list}
    orphan = []
    for n in nc.level2_nodes(outline):
        pid = n.get("parent_id")
        if pid in children:
            children[pid].append(n)
        else:
            orphan.append(n)

    parts = []
    parts.append(f"# {course_name} — 第{lesson}课\n")
    parts.append("{{COURSE_OVERVIEW}}\n")
    parts.append("***\n")

    all_metas = []

    def append_node_body(node):
        path = nc.node_note_path(course_dir, lesson, node["id"])
        with open(path, "r", encoding="utf-8") as f:
            raw = f.read()
        all_metas.extend(extract_meta(raw))
        parts.append(strip_meta_block(raw) + "\n")

    # 按 level-1 顺序输出
    for idx, l1 in enumerate(l1_list):
        # outline 里的 title 可能已含「一、」也可能没有，统一规整
        raw_title = re.sub(r'^[一二三四五六七八九十]+、\s*', '',
                           l1.get("title", "")).strip()
        parts.append(f"### {cn_index(idx)}、{raw_title}\n")
        parts.append(f"{{{{H1_SUMMARY:{l1['id']}}}}}\n")
        for node in children[l1["id"]]:
            append_node_body(node)
        parts.append(f"{{{{H1_QUIZ:{l1['id']}}}}}\n")
        parts.append("***\n")

    # 孤儿节点（没有合法父节点的）兜底输出
    if orphan:
        parts.append("### 其他\n")
        for node in orphan:
            append_node_body(node)
        parts.append("***\n")

    # 附录 + 知识连接占位
    parts.append("{{APPENDIX}}\n")
    parts.append("{{KNOWLEDGE_LINK}}\n")
    parts.append("***\n")

    # META 折叠框
    parts.append(build_meta_block(all_metas))

    assembled = "\n".join(parts)
    out_path = nc.assembled_path(course_dir, lesson)
    os.makedirs(os.path.dirname(out_path), exist_ok=True)
    with open(out_path, "w", encoding="utf-8") as f:
        f.write(assembled)

    placeholders = re.findall(r'\{\{[^}]+\}\}', assembled)
    nc.ok(f"拼装完成：{len(nc.level2_nodes(outline))} 个节点正文已就位，"
          f"META 折叠框 {len(set(all_metas))} 条")
    print(f"   → {out_path}")
    print(f"   待 C 步骤填充的占位符（{len(placeholders)} 处）：")
    print(f"     {sorted(set(placeholders))}")
    print("\n   下一步：C 步骤产出 splice_inputs.json，然后跑 splice.py。")
    print("   注意：C 步骤只读 outline.json 和占位符上下文，不重写节点正文。")


def main():
    ap = argparse.ArgumentParser(description="硬门3 + 纯机械拼装")
    ap.add_argument("--dir", required=True)
    ap.add_argument("--lesson", type=int, required=True)
    args = ap.parse_args()
    assemble(args.dir, args.lesson)
    sys.exit(0)


if __name__ == "__main__":
    main()
