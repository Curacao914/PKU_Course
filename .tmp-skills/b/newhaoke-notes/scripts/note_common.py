#!/usr/bin/env python3
"""
阶段 2（单课笔记生成）状态机的公共工具。

被 validate_outline / init_checklist / verify_node / mark_node_done /
assemble / splice / verify_notes 共享。

职责：
- 统一路径解析（working/ data/ output/ 下各类文件的命名约定）
- 转录字数 / 笔记字数计算（口径统一，避免各脚本算法不一致）
- outline.json / node_checklist.json 的读写
- 退出码约定：0 = 通过，1 = 失败（硬门拦截）
"""

import json
import os
import re
import sys


# ============================================================
# 阈值常量（集中管理，方便跑两课后统一调参）
# ============================================================

# A 步骤：单个 level-2 节点对应转录行数上限。超过 → validate_outline fail。
NODE_MAX_LINES = 180
# 节点行数下限（低于此值只 warn，不 fail；太碎不利于阅读但不算错）
NODE_MIN_LINES = 30

# B 步骤：节点笔记字数 / 节点转录字数的合理区间
# 注意：转录是口语（含大量语气词、重复、口头禅），笔记是书面提炼，
# 因此正常情况下笔记字数 < 转录字数，比率通常在 0.2~0.6 之间。
# 低于下限 → 缩水（漏掉了实质内容）；高于上限 → 可能在生成性扩写。
# 这两个值是初始经验值，跑两课后用 calibrate 报告的实际分布校准。
NODE_RATIO_MIN = 0.18  # 低于 → 缩水，fail
NODE_RATIO_MAX = 0.85  # 高于 → 疑似添油加醋或大量法条原文，warn

# C / 定稿：全文笔记字数 / 全文转录字数的合理区间
DOC_RATIO_MIN = 0.20   # 低于 → 缩水，fail
DOC_RATIO_MAX = 0.80   # 高于 → warn

# 接缝段最小字数（splice 时校验）
SPLICE_MIN = {
    "lecture_thread": 60,
    "h1_summary": 45,
    "knowledge_lays_groundwork": 40,
}

# outline 概念在最终笔记中的最低出现率（verify_notes 检查）
CONCEPT_COVERAGE_MIN = 0.8


# ============================================================
# 路径解析
# ============================================================

def working_dir(course_dir: str) -> str:
    return os.path.join(course_dir, "working")


def data_dir(course_dir: str) -> str:
    return os.path.join(course_dir, "data")


def outline_path(course_dir: str, lesson: int) -> str:
    return os.path.join(working_dir(course_dir), f"第{lesson}课_outline.json")


def checklist_path(course_dir: str, lesson: int) -> str:
    return os.path.join(working_dir(course_dir), f"第{lesson}课_node_checklist.json")


def node_note_path(course_dir: str, lesson: int, node_id: str) -> str:
    return os.path.join(working_dir(course_dir),
                        f"notes_第{lesson}课_node_{node_id}.md")


def assembled_path(course_dir: str, lesson: int) -> str:
    return os.path.join(working_dir(course_dir), f"第{lesson}课_assembled.md")


def splice_inputs_path(course_dir: str, lesson: int) -> str:
    return os.path.join(working_dir(course_dir),
                        f"第{lesson}课_splice_inputs.json")


def final_note_path(course_dir: str, lesson: int) -> str:
    return os.path.join(course_dir, "output", "notes", f"第{lesson}课.md")


def transcript_path(course_dir: str, lesson: int) -> str:
    return os.path.join(data_dir(course_dir), "transcripts", f"第{lesson}课.txt")


def segments_meta_path(course_dir: str, lesson: int) -> str:
    return os.path.join(data_dir(course_dir), "segments",
                        f"第{lesson}课_segments.json")


def ppt_md_path(course_dir: str, lesson: int) -> str:
    return os.path.join(data_dir(course_dir), "ppt_md", f"第{lesson}课_ppt.md")


# ============================================================
# 字数计算（统一口径）
# ============================================================

# 计字数时剔除的内容：Markdown 结构符号、空白、纯标点
_MD_NOISE = re.compile(r'[#>*`\-\|\[\]()（）【】、，。；：！？…—\s\.,;:!?]')


def count_cjk_and_words(text: str) -> int:
    """
    统一字数口径：中文按字符计，英文按词折算。
    用于转录字数和笔记字数的可比较计量。

    做法：剥离 Markdown 噪声符号和空白后，统计剩余的有效字符数。
    对中文笔记/转录，这个口径足够稳定可比。
    """
    cleaned = _MD_NOISE.sub('', text)
    return len(cleaned)


def transcript_char_count(course_dir: str, lesson: int,
                          line_range=None) -> int:
    """
    转录字数。line_range=(start, end)（1-indexed，含两端）时只算该区间。
    parse_srt.py 已剥离时间戳/序号，这里直接按行读。
    """
    path = transcript_path(course_dir, lesson)
    if not os.path.isfile(path):
        return 0
    with open(path, "r", encoding="utf-8") as f:
        lines = f.readlines()
    if line_range:
        start, end = line_range
        lines = lines[max(0, start - 1):end]
    return count_cjk_and_words("".join(lines))


def note_char_count(text: str) -> int:
    """笔记字数（同口径）。"""
    return count_cjk_and_words(text)


# ============================================================
# JSON 读写
# ============================================================

def load_json(path: str):
    if not os.path.isfile(path):
        return None
    with open(path, "r", encoding="utf-8") as f:
        return json.load(f)


def dump_json(path: str, obj):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, "w", encoding="utf-8") as f:
        json.dump(obj, f, ensure_ascii=False, indent=2)


# ============================================================
# outline 节点遍历
# ============================================================

def level2_nodes(outline: dict) -> list:
    """返回 outline 中所有 level-2 节点（按出现顺序）。"""
    return [n for n in outline.get("outline", []) if n.get("level") == 2]


def level1_nodes(outline: dict) -> list:
    return [n for n in outline.get("outline", []) if n.get("level") == 1]


# ============================================================
# 终端输出（统一风格）
# ============================================================

def fail(msg: str):
    print(f"❌ {msg}")


def ok(msg: str):
    print(f"✓ {msg}")


def warn(msg: str):
    print(f"⚠️  {msg}")


def die(msg: str):
    """打印错误并以 exit 1 退出（硬门拦截）。"""
    print(f"\n❌ [拦截] {msg}")
    print("   修复后重新运行本步骤，未通过不得进入下一步。")
    sys.exit(1)
