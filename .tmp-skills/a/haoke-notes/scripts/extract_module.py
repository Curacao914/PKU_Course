#!/usr/bin/env python3
"""
模块提取脚本：根据指定的知识模块名，从笔记中提取相关章节的正文内容。
每次只提取一个模块，控制上下文大小。

用法：
    python extract_module.py <index.json> <concept_map.json> <笔记目录> \
        --module "模块名称" \
        --output <working/module_XX_模块名.md>
"""

import os
import json
import argparse


def extract_module(index_path, concept_map_path, notes_dir, module_name, output_path):
    """提取指定知识模块的笔记内容。"""
    with open(index_path, 'r', encoding='utf-8') as f:
        index_data = json.load(f)
    with open(concept_map_path, 'r', encoding='utf-8') as f:
        concept_map = json.load(f)

    # 在 concept_map 中查找模块（支持模糊匹配）
    mod_data = None
    matched_key = None
    for key in concept_map['modules']:
        if module_name in key or key in module_name:
            mod_data = concept_map['modules'][key]
            matched_key = key
            break

    if mod_data is None:
        # 尝试关键词匹配
        for key in concept_map['modules']:
            if any(w in key for w in module_name.split()):
                mod_data = concept_map['modules'][key]
                matched_key = key
                break

    if mod_data is None:
        print(f'未找到模块：{module_name}')
        print('可用模块：')
        for k in concept_map['modules']:
            print(f'  - {k}')
        return

    # 提取各笔记中该模块的内容
    output_lines = [
        f'# 模块提取：{matched_key}',
        '',
        f'> 涉及 {len(mod_data["notes"])} 篇笔记：{", ".join(mod_data["notes"])}',
        '',
        '---',
        '',
    ]

    total_chars = 0
    for note_file in mod_data['notes']:
        filepath = os.path.join(notes_dir, note_file)
        if not os.path.exists(filepath):
            output_lines.append(f'<!-- 警告：{note_file} 不存在 -->')
            output_lines.append('')
            continue

        with open(filepath, 'r', encoding='utf-8') as f:
            lines = f.readlines()

        # 找到该笔记中与模块相关的 section
        module_sections = [s for s in mod_data['sections'] if s['note'] == note_file]

        for sec in module_sections:
            start = sec['line_start']
            end = sec['line_end']

            output_lines.append(f'## 来源：{note_file} — {sec["section"]}')
            output_lines.append(f'<!-- 行号 {start} ~ {end} -->')
            output_lines.append('')

            if end > 0 and start >= 0 and end <= len(lines):
                section_lines = lines[start:end]
                content = ''.join(section_lines)
                output_lines.extend(section_lines)
                total_chars += len(content)
            else:
                # 回退：搜索标题行
                found = False
                for j, line in enumerate(lines):
                    if sec['section'] in line:
                        # 找到标题，提取到下一个同级标题或文件末尾
                        k = j + 1
                        while k < len(lines):
                            if lines[k].strip().startswith('### ') and k > j:
                                break
                            if lines[k].strip().startswith('## ') and k > j:
                                break
                            k += 1
                        output_lines.extend(lines[j:k])
                        total_chars += sum(len(l) for l in lines[j:k])
                        found = True
                        break
                if not found:
                    output_lines.append('（无法定位章节）')
                    output_lines.append('')

            output_lines.append('')
            output_lines.append('---')
            output_lines.append('')

    with open(output_path, 'w', encoding='utf-8') as f:
        f.write('\n'.join(output_lines))

    est_tokens = total_chars // 3
    print(f'模块提取完成：{matched_key}')
    print(f'  涉及笔记：{", ".join(mod_data["notes"])}')
    print(f'  提取字符：{total_chars}，预估 token：~{est_tokens}')
    print(f'输出：{output_path}')


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description='提取指定知识模块的笔记内容')
    parser.add_argument('index_path', help='index.json 路径')
    parser.add_argument('concept_map_path', help='concept_map.json 路径')
    parser.add_argument('notes_dir', help='单课笔记存放目录')
    parser.add_argument('--module', '-m', required=True, help='模块名称（或部分名称）')
    parser.add_argument('--output', '-o', required=True, help='输出文件路径')
    args = parser.parse_args()

    extract_module(args.index_path, args.concept_map_path, args.notes_dir,
                   args.module, args.output)
