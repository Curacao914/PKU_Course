#!/usr/bin/env python3
"""
预索引脚本：读取所有单课笔记，提取结构信息（标题层级 + 概览 + META 折叠框中的清单），
生成 index.json 预索引文件。

后续渐进披露操作都基于此索引，避免加载全文。

新版本说明：
- META 标签从原来的内嵌 HTML 注释（<!-- META: -->）改为笔记末尾折叠框中的纯文本格式：
    META: CONCEPT: 概念名
    META: PROVISION: 法条简称
    META: CASE: 案例名
    META: PITFALL: 概念A vs 概念B
- 同时兼容旧格式（HTML 注释 META 标签），便于过渡
- 新增 ppt_summary 字段：从 data/ppt_md/第N课_ppt.md 自动提取一段 ~200 字摘要

用法：
    python build_index.py <笔记目录> --output <index.json>
    python build_index.py <笔记目录> --output <index.json> --ppt-md-dir <data/ppt_md>
"""

import os
import re
import json
import argparse


# ---- 标题层级正则 ----
RE_H1_NUM = re.compile(r'^###\s+([一二三四五六七八九十]+、\s*.+)$')   # ### 一、XXX
RE_H2_NUM = re.compile(r'^[（(]([一二三四五六七八九十]+)[)）]\s*(.+)$')  # （一）XXX

# ---- META 标签：新格式（折叠框纯文本）+ 旧格式（HTML 注释） ----
RE_META_PLAIN = re.compile(r'META:\s*(\w+):\s*(.+?)\s*$', re.MULTILINE)
RE_META_TAG = re.compile(r'<!--\s*META:\s*(\w+):\s*(.+?)\s*-->')

# ---- fallback 正则（无 META 时使用） ----
RE_CASE_BOLD = re.compile(r'\*\*(.+?案)\*\*')
RE_PROV_BOLD = re.compile(r'\*\*(.+?法.+?第?\d+条)\*\*')
RE_PROV_PAREN = re.compile(r'（(.+?法.+?第?\d+条)）')
RE_CASE_PAREN = re.compile(r'（(.+?案)）')


def normalize_provision(raw: str) -> str:
    """标准化法条名称：去书名号、统一前缀。"""
    prov = raw.strip()
    for ch in '《》〈〉':
        prov = prov.replace(ch, '')
    prov = re.sub(r'^.*?民法典\s*第', '民法典第', prov)
    return prov


def extract_meta_from_text(text: str) -> dict:
    """从笔记全文中提取 META 标签（同时支持新旧格式）"""
    meta = {'concepts': [], 'provisions': [], 'cases': [], 'pitfalls': []}

    # 优先扫新格式（折叠框纯文本）
    for tag_type, tag_value in RE_META_PLAIN.findall(text):
        _add_meta(meta, tag_type, tag_value)

    # 兼容旧格式（HTML 注释）
    for tag_type, tag_value in RE_META_TAG.findall(text):
        _add_meta(meta, tag_type, tag_value)

    return meta


def _add_meta(meta: dict, tag_type: str, tag_value: str):
    tag_type = tag_type.upper()
    val = tag_value.strip()
    if not val:
        return
    if tag_type == 'CONCEPT' and val not in meta['concepts']:
        meta['concepts'].append(val)
    elif tag_type == 'PROVISION':
        prov = normalize_provision(val)
        if prov not in meta['provisions']:
            meta['provisions'].append(prov)
    elif tag_type == 'CASE' and val not in meta['cases']:
        meta['cases'].append(val)
    elif tag_type == 'PITFALL' and val not in meta['pitfalls']:
        meta['pitfalls'].append(val)


def extract_overview(lines: list) -> str:
    """提取笔记开头的"课程概览"段（取前 500 字）"""
    in_overview = False
    overview_lines = []

    for i, line in enumerate(lines):
        stripped = line.strip()

        if '课程概览' in stripped and stripped.startswith('## '):
            in_overview = True
            continue

        if in_overview:
            if stripped.startswith('---') or stripped.startswith('***') or \
               (stripped.startswith('### ') and '课程概览' not in stripped) or \
               stripped.startswith('## '):
                break

            if stripped.startswith('>'):
                content = stripped.lstrip('>').strip()
                if content:
                    overview_lines.append(content)
            elif stripped and not stripped.startswith('#'):
                overview_lines.append(stripped)

    return '\n'.join(overview_lines)[:500]


def extract_headings_and_sections(lines: list) -> tuple:
    """提取一级、二级标题及每个一级标题的行号区间"""
    headings_l1 = []
    headings_l2 = {}
    sections = []

    current_h1 = None
    current_section_start = None

    for i, line in enumerate(lines):
        stripped = line.strip()

        h1 = RE_H1_NUM.match(stripped)
        if h1:
            title = h1.group(1)
            headings_l1.append(title)
            headings_l2[title] = []

            if current_h1:
                sections.append({
                    'heading': current_h1,
                    'start_line': current_section_start,
                    'end_line': i,
                })
            current_h1 = title
            current_section_start = i

        h2 = RE_H2_NUM.match(stripped)
        if h2 and current_h1:
            h2_title = f'（{h2.group(1)}）{h2.group(2)}'
            if h2_title not in headings_l2[current_h1]:
                headings_l2[current_h1].append(h2_title)

    if current_h1:
        sections.append({
            'heading': current_h1,
            'start_line': current_section_start,
            'end_line': len(lines),
        })

    return headings_l1, headings_l2, sections


def extract_ppt_summary(ppt_md_path: str, max_chars: int = 200) -> str:
    """从 PPT 文字 md 提取一段简短摘要（取前若干非空文字行）"""
    if not os.path.isfile(ppt_md_path):
        return ''

    with open(ppt_md_path, 'r', encoding='utf-8') as f:
        text = f.read()

    # 去掉 "## 幻灯片 N" 这类标题
    lines = []
    for line in text.split('\n'):
        stripped = line.strip()
        if not stripped or stripped.startswith('#') or stripped.startswith('（此页'):
            continue
        lines.append(stripped)

    summary = ' '.join(lines)
    if len(summary) > max_chars:
        summary = summary[:max_chars] + '...'
    return summary


def fallback_provisions_cases(text: str) -> tuple:
    """无 META 标签时用正则提取法条和案例（保底）"""
    provisions = []
    cases = []

    for m in RE_PROV_BOLD.finditer(text):
        prov = m.group(1)
        if prov not in provisions:
            provisions.append(prov)
    for m in RE_PROV_PAREN.finditer(text):
        prov = m.group(1)
        if prov not in provisions:
            provisions.append(prov)
    for m in RE_CASE_BOLD.finditer(text):
        case = m.group(1)
        if case not in cases:
            cases.append(case)
    for m in RE_CASE_PAREN.finditer(text):
        case = m.group(1)
        if case not in cases:
            cases.append(case)

    return provisions, cases


def extract_note_info(filepath: str, ppt_md_dir: str = None) -> dict:
    """从单个笔记 md 文件提取结构信息"""
    with open(filepath, 'r', encoding='utf-8') as f:
        text = f.read()
    lines = text.splitlines(keepends=True)

    info = {
        'file': os.path.basename(filepath),
        'lesson_num': 0,
        'overview': '',
        'ppt_summary': '',
        'headings': {'level1': [], 'level2': {}},
        'keywords': [],
        'provisions': [],
        'cases': [],
        'pitfalls': [],
        'sections': [],
        'total_lines': len(lines),
    }

    # 课次编号
    base = os.path.splitext(os.path.basename(filepath))[0]
    num_match = re.search(r'第(\d+)', base)
    if num_match:
        info['lesson_num'] = int(num_match.group(1))

    # 概览
    info['overview'] = extract_overview(lines)

    # 标题与 sections
    h1, h2, sections = extract_headings_and_sections(lines)
    info['headings']['level1'] = h1
    info['headings']['level2'] = h2
    info['sections'] = sections

    # META 提取
    meta = extract_meta_from_text(text)
    if meta['concepts'] or meta['provisions'] or meta['cases'] or meta['pitfalls']:
        info['keywords'] = meta['concepts']
        info['provisions'] = meta['provisions']
        info['cases'] = meta['cases']
        info['pitfalls'] = meta['pitfalls']
    else:
        # fallback
        provs, cases = fallback_provisions_cases(text)
        info['provisions'] = provs
        info['cases'] = cases

    # PPT 摘要
    if ppt_md_dir and info['lesson_num']:
        ppt_md_path = os.path.join(ppt_md_dir, f'第{info["lesson_num"]}课_ppt.md')
        info['ppt_summary'] = extract_ppt_summary(ppt_md_path)

    return info


def build_index(notes_dir: str, output_path: str, ppt_md_dir: str = None):
    """从笔记目录构建预索引"""
    note_files = sorted([
        f for f in os.listdir(notes_dir)
        if f.endswith('.md') and not f.startswith('.')
    ])

    if not note_files:
        print(f'[错误] 在 {notes_dir} 中未找到 .md 文件')
        return

    notes_info = []
    for nf in note_files:
        filepath = os.path.join(notes_dir, nf)
        try:
            info = extract_note_info(filepath, ppt_md_dir)
            notes_info.append(info)
            print(f'  已索引: {info["file"]} ({info["lesson_num"]}课, '
                  f'{info["total_lines"]}行, {len(info["headings"]["level1"])}个一级标题, '
                  f'{len(info["provisions"])}个法条, {len(info["cases"])}个案例)')
        except Exception as e:
            print(f'  跳过 {nf}: {e}')

    course_name = os.path.basename(os.path.abspath(os.path.dirname(notes_dir)))

    index = {
        'course_name': course_name,
        'notes_dir': os.path.abspath(notes_dir),
        'total_notes': len(notes_info),
        'notes': notes_info,
    }

    with open(output_path, 'w', encoding='utf-8') as f:
        json.dump(index, f, ensure_ascii=False, indent=2)

    # 汇总统计
    all_h1 = set()
    all_provisions = set()
    all_cases = set()
    all_pitfalls = set()
    for n in notes_info:
        all_h1.update(n['headings']['level1'])
        all_provisions.update(n['provisions'])
        all_cases.update(n['cases'])
        all_pitfalls.update(n.get('pitfalls', []))

    print(f'\n预索引完成：{len(notes_info)} 篇笔记')
    print(f'  {len(all_h1)} 个知识模块, {len(all_provisions)} 个法条, '
          f'{len(all_cases)} 个案例, {len(all_pitfalls)} 个易混对')
    print(f'输出：{output_path}')


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description='构建笔记预索引')
    parser.add_argument('notes_dir', help='单课笔记存放目录')
    parser.add_argument('--output', '-o', default=None, help='输出 index.json 路径')
    parser.add_argument('--ppt-md-dir', default=None,
                        help='PPT md 目录（用于生成 ppt_summary 字段，如 data/ppt_md）')
    args = parser.parse_args()

    output = args.output or os.path.join(args.notes_dir, 'index.json')
    build_index(args.notes_dir, output, args.ppt_md_dir)
