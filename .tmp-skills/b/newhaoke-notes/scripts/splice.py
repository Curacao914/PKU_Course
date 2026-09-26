#!/usr/bin/env python3
"""
把 C 步骤模型产出的 splice_inputs.json 填入 assembled.md 的占位符，
输出最终笔记 output/notes/第N课.md。

模型在 C 步骤只产出结构化数据（不是 Markdown 正文），本脚本负责
把它们渲染成 Markdown 并替换占位符。模型因此无法重写节点正文。

splice_inputs.json 结构见 references/note-writing.md 步骤 C。
本脚本对每段接缝做最小长度校验，过短 → fail（防止 C 步骤敷衍）。

用法：
    python splice.py --dir ./课程目录 --lesson 3
"""

import argparse
import re
import sys

import note_common as nc


def render_overview(ov: dict, errors: list) -> str:
    if not ov:
        errors.append("splice_inputs 缺少 course_overview")
        return ""
    q = ov.get("core_questions", [])
    able = ov.get("should_be_able_to", [])
    thread = ov.get("lecture_thread", "")
    if len(thread) < nc.SPLICE_MIN["lecture_thread"]:
        errors.append(f"course_overview.lecture_thread 过短"
                      f"（{len(thread)} 字 < {nc.SPLICE_MIN['lecture_thread']}）")
    lines = ["## 课程概览\n", "### 本课要回答的核心问题"]
    for i, item in enumerate(q, 1):
        lines.append(f"{i}. {item}")
    lines.append("\n### 本课你应当能够")
    for item in able:
        lines.append(f"- [ ] {item}")
    lines.append("\n### 课程脉络")
    # 脉络支持一段话 + 列表
    for para in thread.split("\n"):
        lines.append(f"> {para}" if para.strip() else ">")
    return "\n".join(lines)


def render_h1_summary(summaries: dict, h1_id: str, errors: list) -> str:
    s = (summaries or {}).get(h1_id, "")
    if not s:
        errors.append(f"缺少一级标题 {h1_id} 的总结段（h1_summaries['{h1_id}']）")
        return ""
    if len(s) < nc.SPLICE_MIN["h1_summary"]:
        errors.append(f"一级标题 {h1_id} 总结段过短"
                      f"（{len(s)} 字 < {nc.SPLICE_MIN['h1_summary']}）")
    return s


def render_h1_quiz(quizzes: dict, h1_id: str) -> str:
    items = (quizzes or {}).get(h1_id, [])
    if not items:
        return ""  # 自测块可选（无显著难点时允许缺）
    lines = ["> **自测**（合上笔记，能回答吗？）"]
    for i, q in enumerate(items, 1):
        lines.append(f"> {i}. {q}")
    return "\n".join(lines)


def render_knowledge_link(kl: dict, errors: list) -> str:
    if not kl:
        errors.append("splice_inputs 缺少 knowledge_link")
        return ""
    groundwork = kl.get("lays_groundwork_for", [])
    if not groundwork:
        errors.append("knowledge_link.lays_groundwork_for 为空（必填）")
    lines = ["## 知识连接\n"]
    inh = kl.get("inherits_from", "")
    if inh:
        lines.append(f"**承接什么**：{inh}\n")
    lines.append("**为后续铺垫什么**：")
    total = 0
    for item in groundwork:
        if isinstance(item, dict):
            lines.append(f"- {item.get('concept', '')} → {item.get('use', '')}")
            total += len(item.get("use", ""))
        else:
            lines.append(f"- {item}")
            total += len(str(item))
    if total < nc.SPLICE_MIN["knowledge_lays_groundwork"]:
        errors.append("knowledge_link.lays_groundwork_for 内容过于单薄")
    preview = kl.get("next_lesson_preview", "")
    if preview:
        lines.append(f"\n**下节预告**：{preview}")
    return "\n".join(lines)


def render_appendix(ap: dict) -> str:
    if not ap:
        return ""  # 无发散内容时整段省略
    terms = ap.get("terms", [])
    topics = ap.get("topics", [])
    if not terms and not topics:
        return ""
    lines = ["## 附录：补充与发散\n",
             "> 以下内容为课堂补充材料和发散性讨论，不影响课程主线\n"]
    if terms:
        lines.append("### 术语汇总\n")
        lines.append("| 术语 | 英文/原文 | 定义或说明 |")
        lines.append("|------|----------|-----------|")
        for t in terms:
            lines.append(f"| {t.get('term', '')} | {t.get('original', '')} "
                         f"| {t.get('definition', '')} |")
    for tp in topics:
        lines.append(f"\n### {tp.get('title', '发散话题')}\n")
        lines.append(tp.get("content", ""))
    return "\n".join(lines)


def splice(course_dir: str, lesson: int):
    assembled = None
    ap = nc.assembled_path(course_dir, lesson)
    try:
        with open(ap, "r", encoding="utf-8") as f:
            assembled = f.read()
    except FileNotFoundError:
        nc.die(f"找不到 assembled.md（请先跑 assemble.py）：{ap}")

    inputs = nc.load_json(nc.splice_inputs_path(course_dir, lesson))
    if inputs is None:
        nc.die("找不到 splice_inputs.json（请先完成 C 步骤产出接缝数据）")

    errors = []

    # 替换占位符
    assembled = assembled.replace(
        "{{COURSE_OVERVIEW}}",
        render_overview(inputs.get("course_overview"), errors))

    assembled = assembled.replace(
        "{{KNOWLEDGE_LINK}}",
        render_knowledge_link(inputs.get("knowledge_link"), errors))

    assembled = assembled.replace(
        "{{APPENDIX}}",
        render_appendix(inputs.get("appendix")))

    # H1 总结和自测（按 id）
    for m in re.findall(r'\{\{H1_SUMMARY:([^}]+)\}\}', assembled):
        assembled = assembled.replace(
            f"{{{{H1_SUMMARY:{m}}}}}",
            render_h1_summary(inputs.get("h1_summaries"), m, errors))
    for m in re.findall(r'\{\{H1_QUIZ:([^}]+)\}\}', assembled):
        assembled = assembled.replace(
            f"{{{{H1_QUIZ:{m}}}}}",
            render_h1_quiz(inputs.get("h1_quizzes"), m))

    # 残留占位符检查
    leftover = re.findall(r'\{\{[^}]+\}\}', assembled)
    if leftover:
        errors.append(f"仍有未填充的占位符：{sorted(set(leftover))}")

    if errors:
        for e in errors:
            nc.fail(e)
        nc.die(f"splice 未通过（{len(errors)} 个问题），请补全 splice_inputs.json")

    # 清理多余空行
    assembled = re.sub(r'\n{4,}', '\n\n\n', assembled)

    out_path = nc.final_note_path(course_dir, lesson)
    import os
    os.makedirs(os.path.dirname(out_path), exist_ok=True)
    with open(out_path, "w", encoding="utf-8") as f:
        f.write(assembled)

    nc.ok(f"最终笔记已生成：{out_path}")
    print("   下一步：跑 verify_notes.py 做定稿前自检。")


def main():
    ap = argparse.ArgumentParser(description="填充接缝段，输出最终笔记")
    ap.add_argument("--dir", required=True)
    ap.add_argument("--lesson", type=int, required=True)
    args = ap.parse_args()
    splice(args.dir, args.lesson)
    sys.exit(0)


if __name__ == "__main__":
    main()
