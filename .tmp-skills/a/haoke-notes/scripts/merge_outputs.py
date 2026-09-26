#!/usr/bin/env python3
"""
合并脚本：将各模块的输出文件合并为一份完整的整合版笔记。

用法：
    python merge_outputs.py <模块输出目录> --output <整合版笔记.md> --course <课程名>

输入：模块输出目录下按顺序排列的 module_XX_*.md 文件
输出：合并后的完整整合版笔记
"""

import os
import glob
import argparse


def merge_module_outputs(module_dir: str, output_path: str, course_name: str):
    """合并模块输出为整合版笔记。"""
    module_files = sorted(glob.glob(os.path.join(module_dir, 'module_*.md')))

    if not module_files:
        print(f'[错误] 在 {module_dir} 中未找到 module_*.md 文件')
        return

    lines = [
        f'# {course_name} — 整合版复习笔记',
        '',
        '## 使用说明',
        '',
        '> 本笔记按知识体系（而非课次顺序）重新组织，',
        '> 合并了跨课次的重复内容，去除了发散讨论，',
        '> 适合作为复习资料。',
        '',
        '***',
        '',
    ]

    for mf in module_files:
        with open(mf, 'r', encoding='utf-8') as f:
            content = f.read().strip()

        content_lines = content.split('\n')
        # 跳过模块文件中的顶层标题
        if content_lines and content_lines[0].startswith('# '):
            content_lines = content_lines[1:]
            # 跳过紧跟的空行、分隔线、引用块（使用说明）
            while content_lines and (
                content_lines[0].strip() in ('', '---', '***') or
                content_lines[0].startswith('>')
            ):
                content_lines = content_lines[1:]

        lines.extend(content_lines)
        lines.append('')
        lines.append('***')
        lines.append('')

    with open(output_path, 'w', encoding='utf-8') as f:
        f.write('\n'.join(lines))

    print(f'合并完成：{len(module_files)} 个模块')
    print(f'输出：{output_path}')


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description='合并模块输出为整合版笔记')
    parser.add_argument('module_dir', help='模块输出目录（含 module_XX_*.md 文件）')
    parser.add_argument('--output', '-o', required=True, help='输出整合版笔记路径')
    parser.add_argument('--course', '-c', default='课程', help='课程名称')
    args = parser.parse_args()

    merge_module_outputs(args.module_dir, args.output, args.course)
