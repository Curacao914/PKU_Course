#!/usr/bin/env python3
"""
概念定位脚本：基于预索引 index.json，生成概念-课次-章节的交叉引用映射。

输出 concept_map.json，为概念追踪和模块提取提供定位信息。

用法：
    python locate_concepts.py <index.json> --output <concept_map.json>

输出 concept_map.json 结构：
{
  "concepts": {
    "概念名": {
      "occurrences": [{"note": "第1课.md", "lesson_num": 1, "section": "一、XXX"}]
    }
  },
  "provisions": { "XX法第N条": {"occurrences": [...]} },
  "cases": { "XX案": {"occurrences": [...]} },
  "modules": {
    "一、模块名": {
      "notes": ["第1课.md", "第3课.md"],
      "sections": [{"note": "第1课.md", "section": "一、XXX", "line_start": 15, "line_end": 80}]
    }
  }
}
"""

import os
import re
import json
import argparse


def build_concept_map(index_path, output_path=None):
    """从预索引构建概念定位图。"""
    with open(index_path, 'r', encoding='utf-8') as f:
        index_data = json.load(f)

    notes = index_data.get('notes', [])
    if not notes:
        print('错误：index.json 中没有笔记数据')
        return

    concept_map = {
        'concepts': {},
        'provisions': {},
        'cases': {},
        'modules': {},
    }

    for note in notes:
        note_file = note['file']
        lesson_num = note['lesson_num']

        # ---- 概念（优先从 index 的 keywords 字段提取；若为空则 fallback 到一级标题） ----
        if note.get('keywords'):
            # keywords 中包含 META CONCEPT 和 PITFALL 标签的精确概念名
            for kw in note['keywords']:
                if kw not in concept_map['concepts']:
                    concept_map['concepts'][kw] = {'occurrences': []}
                concept_map['concepts'][kw]['occurrences'].append({
                    'note': note_file,
                    'lesson_num': lesson_num,
                    'section': '',  # META 标签不绑定特定 section
                })
        else:
            # fallback：从一级标题提取作为模块关键词（用于无 META 标签的旧笔记）
            for h1 in note['headings']['level1']:
                clean_title = re.sub(r'^[一二三四五六七八九十]+、\s*', '', h1)
                if clean_title not in concept_map['concepts']:
                    concept_map['concepts'][clean_title] = {'occurrences': []}
                concept_map['concepts'][clean_title]['occurrences'].append({
                    'note': note_file,
                    'lesson_num': lesson_num,
                    'section': h1,
                })

        # ---- 法条 ----
        for prov in note['provisions']:
            if prov not in concept_map['provisions']:
                concept_map['provisions'][prov] = {'occurrences': []}
            concept_map['provisions'][prov]['occurrences'].append({
                'note': note_file,
                'lesson_num': lesson_num,
            })

        # ---- 案例 ----
        for case in note['cases']:
            if case not in concept_map['cases']:
                concept_map['cases'][case] = {'occurrences': []}
            concept_map['cases'][case]['occurrences'].append({
                'note': note_file,
                'lesson_num': lesson_num,
            })

        # ---- 模块映射（每个一级标题 = 一个模块） ----
        for h1 in note['headings']['level1']:
            if h1 not in concept_map['modules']:
                concept_map['modules'][h1] = {'notes': [], 'sections': []}
            if note_file not in concept_map['modules'][h1]['notes']:
                concept_map['modules'][h1]['notes'].append(note_file)

            # 从 sections 中找到对应的一级标题的行号范围
            sec_info = next(
                (s for s in note.get('sections', []) if s['heading'] == h1),
                None
            )
            concept_map['modules'][h1]['sections'].append({
                'note': note_file,
                'section': h1,
                'line_start': sec_info['start_line'] if sec_info else 0,
                'line_end': sec_info['end_line'] if sec_info else 0,
            })

    # 按出现次数排序：跨课次的排前面
    def sort_by_occurrences(d):
        multi = {k: v for k, v in d.items() if len(v['occurrences']) > 1}
        single = {k: v for k, v in d.items() if len(v['occurrences']) == 1}
        return {**multi, **single}

    concept_map['concepts'] = sort_by_occurrences(concept_map['concepts'])
    concept_map['provisions'] = sort_by_occurrences(concept_map['provisions'])
    concept_map['cases'] = sort_by_occurrences(concept_map['cases'])

    # 统计
    multi_concepts = sum(1 for v in concept_map['concepts'].values() if len(v['occurrences']) > 1)
    multi_provisions = sum(1 for v in concept_map['provisions'].values() if len(v['occurrences']) > 1)
    multi_cases = sum(1 for v in concept_map['cases'].values() if len(v['occurrences']) > 1)

    if output_path is None:
        output_path = os.path.join(os.path.dirname(index_path), 'concept_map.json')

    with open(output_path, 'w', encoding='utf-8') as f:
        json.dump(concept_map, f, ensure_ascii=False, indent=2)

    print(f'概念定位图完成：')
    print(f'  {len(concept_map["concepts"])} 个概念（{multi_concepts} 个跨课次）')
    print(f'  {len(concept_map["provisions"])} 个法条（{multi_provisions} 个跨课次）')
    print(f'  {len(concept_map["cases"])} 个案例（{multi_cases} 个跨课次）')
    print(f'  {len(concept_map["modules"])} 个知识模块')
    print(f'输出：{output_path}')


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description='构建概念定位图')
    parser.add_argument('index_path', help='index.json 路径')
    parser.add_argument('--output', '-o', default=None, help='输出概念图路径')
    args = parser.parse_args()

    build_concept_map(args.index_path, args.output)
