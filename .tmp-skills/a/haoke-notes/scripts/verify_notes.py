#!/usr/bin/env python3
"""
笔记自检：检查单课笔记是否符合 note-writing.md 规范的可程序化项目。

检查项：
1. 课程概览块是否存在（# 标题 + ## 课程概览）
2. 每个一级标题（### 一、）后是否有总结段
3. 每个一级标题末尾是否有自测块（> **自测**）
4. 二级标题（（一） / （二））是否标注重要性等级（★/★★/★★★）
5. 末尾 META 折叠框是否存在（<details><summary>📑 笔记元数据）
6. META 折叠框格式是否正确（HTML 闭合 + 内含 META: 行）
7. 折叠框 <details> + <summary> 是否同行
8. 「为后续铺垫什么」是否填写
9. 附录术语汇总表是否存在
10. PROVISION 值是否符合规范（无书名号）

用法：
    python verify_notes.py --note ./output/notes/第1课.md
    python verify_notes.py --notes-dir ./output/notes  # 批量检查
"""

import argparse
import os
import re
import sys


# ---- 检查项实现 ----

class CheckResult:
    def __init__(self):
        self.errors = []   # 必须修复
        self.warnings = []  # 建议关注
        self.passed = []   # 通过项

    def err(self, msg):
        self.errors.append(msg)

    def warn(self, msg):
        self.warnings.append(msg)

    def ok(self, msg):
        self.passed.append(msg)


def check_course_overview(text: str, r: CheckResult):
    if re.search(r'^#\s+.+', text, re.MULTILINE) and \
       re.search(r'^##\s+课程概览', text, re.MULTILINE):
        r.ok('课程概览块存在')
    else:
        r.err('缺少 # 标题或 ## 课程概览')


def check_h1_summary_and_quiz(text: str, r: CheckResult):
    """每个一级标题（### 一、）后应该有一段总结，末尾应该有自测块"""
    h1_pattern = re.compile(r'^###\s+([一二三四五六七八九十]+、\s*.+)$', re.MULTILINE)
    h1_matches = list(h1_pattern.finditer(text))

    if not h1_matches:
        r.warn('未找到一级标题（###）')
        return

    sep_pattern = re.compile(r'^\*\*\*\s*$', re.MULTILINE)

    for i, m in enumerate(h1_matches):
        h1_title = m.group(1)
        start = m.end()
        # 下一个一级标题或文末
        end = h1_matches[i + 1].start() if i + 1 < len(h1_matches) else len(text)
        section = text[start:end]

        # 检查总结段：标题后第一个非空段落，且不是子标题
        first_paragraphs = section.lstrip().split('\n\n', 1)
        if first_paragraphs and first_paragraphs[0].strip() and \
           not first_paragraphs[0].lstrip().startswith(('（', '#', '>', '-', '*', '|')):
            r.ok(f'一级标题「{h1_title[:20]}…」有总结段')
        else:
            r.warn(f'一级标题「{h1_title[:20]}…」可能缺少总结段')

        # 检查自测块
        if re.search(r'>\s*\*\*自测\*\*', section):
            r.ok(f'一级标题「{h1_title[:20]}…」有自测块')
        else:
            r.warn(f'一级标题「{h1_title[:20]}…」缺少自测块')


def check_h2_stars(text: str, r: CheckResult):
    """二级标题应标注 ★ / ★★ / ★★★"""
    h2_pattern = re.compile(
        r'^[（(]([一二三四五六七八九十]+)[)）]\s*(.+)$',
        re.MULTILINE
    )
    h2_matches = list(h2_pattern.finditer(text))

    if not h2_matches:
        return

    missing = []
    for m in h2_matches:
        title = m.group(2)
        if not re.search(r'★+', title):
            missing.append(title[:20])

    if missing:
        r.warn(f'{len(missing)} 个二级标题未标注重要性等级（前几个：'
               f'{", ".join(missing[:3])}）')
    else:
        r.ok(f'全部 {len(h2_matches)} 个二级标题已标注重要性等级')


def check_meta_block(text: str, r: CheckResult):
    """末尾 META 折叠框检查"""
    # 找出最后一个 details 块
    details_pattern = re.compile(
        r'<details><summary>📑 笔记元数据.*?</summary>(.*?)</details>',
        re.DOTALL
    )
    m = details_pattern.search(text)
    if not m:
        r.err('缺少末尾 META 折叠框（<details><summary>📑 笔记元数据...）')
        return

    inner = m.group(1)

    # 检查 details + summary 同行
    if re.search(r'<details>\s*\n\s*<summary>', text):
        r.err('<details> 与 <summary> 不在同一行')
    else:
        r.ok('<details><summary> 同行')

    # 检查 META: 行
    meta_lines = re.findall(r'META:\s*(\w+):\s*(.+)', inner)
    if not meta_lines:
        r.warn('META 折叠框内未找到 META: 行')
        return
    r.ok(f'META 折叠框含 {len(meta_lines)} 条标签')

    # 检查 PROVISION 格式（无书名号）
    bad_provisions = []
    for tag_type, tag_value in meta_lines:
        if tag_type.upper() == 'PROVISION':
            if any(ch in tag_value for ch in '《》〈〉'):
                bad_provisions.append(tag_value)
    if bad_provisions:
        r.err(f'PROVISION 值含书名号（应去除）：{bad_provisions[:3]}')
    else:
        provision_count = sum(1 for t, _ in meta_lines if t.upper() == 'PROVISION')
        if provision_count:
            r.ok(f'{provision_count} 条 PROVISION 格式正确')


def check_knowledge_link(text: str, r: CheckResult):
    """检查「为后续铺垫什么」"""
    if '## 知识连接' in text:
        # 找出"为后续铺垫什么"段
        m = re.search(r'\*\*为后续铺垫什么\*\*[：:]\s*\n([\s\S]+?)(?=\*\*|\n##|\n\*\*\*)', text)
        if m and m.group(1).strip() and '待补充' not in m.group(1):
            r.ok('「为后续铺垫什么」已填写')
        else:
            r.err('「为后续铺垫什么」未填写或仅标"待补充"')
    else:
        r.err('缺少 ## 知识连接 段')


def check_appendix_glossary(text: str, r: CheckResult):
    """附录术语表检查"""
    if re.search(r'##\s+附录', text):
        if re.search(r'###\s+术语汇总', text):
            r.ok('附录术语汇总表存在')
        else:
            r.warn('附录存在但缺少「术语汇总」小节')
    else:
        r.warn('缺少 ## 附录段（如本课无发散内容可忽略）')


# ---- 主流程 ----

def verify_one(note_path: str) -> CheckResult:
    r = CheckResult()

    if not os.path.isfile(note_path):
        r.err(f'文件不存在: {note_path}')
        return r

    with open(note_path, 'r', encoding='utf-8') as f:
        text = f.read()

    check_course_overview(text, r)
    check_h1_summary_and_quiz(text, r)
    check_h2_stars(text, r)
    check_meta_block(text, r)
    check_knowledge_link(text, r)
    check_appendix_glossary(text, r)

    return r


def print_result(note_path: str, r: CheckResult):
    print(f"\n=== {note_path} ===")
    if r.errors:
        print(f"\n❌ 错误 ({len(r.errors)})：")
        for e in r.errors:
            print(f"  - {e}")
    if r.warnings:
        print(f"\n⚠️  建议 ({len(r.warnings)})：")
        for w in r.warnings:
            print(f"  - {w}")
    if r.passed:
        print(f"\n✓ 通过 ({len(r.passed)})")

    if not r.errors:
        print(f"\n[结果] 通过（含 {len(r.warnings)} 项建议）")
    else:
        print(f"\n[结果] 未通过（{len(r.errors)} 个错误需修复）")


def main():
    parser = argparse.ArgumentParser(description='单课笔记自检')
    parser.add_argument('--note', help='单个笔记文件')
    parser.add_argument('--notes-dir', help='笔记目录（批量检查）')
    args = parser.parse_args()

    if not args.note and not args.notes_dir:
        parser.print_help()
        sys.exit(1)

    has_error = False

    if args.note:
        r = verify_one(args.note)
        print_result(args.note, r)
        if r.errors:
            has_error = True

    if args.notes_dir:
        notes = sorted([f for f in os.listdir(args.notes_dir)
                        if f.endswith('.md') and not f.startswith('.')])
        for nf in notes:
            path = os.path.join(args.notes_dir, nf)
            r = verify_one(path)
            print_result(path, r)
            if r.errors:
                has_error = True

    sys.exit(1 if has_error else 0)


if __name__ == '__main__':
    main()
