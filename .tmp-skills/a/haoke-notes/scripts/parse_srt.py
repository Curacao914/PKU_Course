#!/usr/bin/env python3
"""
SRT 字幕文件 → 纯文本
解析标准 SRT 格式，剥离时间戳、序号、HTML 标签和样式标记，输出纯文本转录稿。

用法：
    python parse_srt.py --input raw/xxx_原文.srt --output data/transcripts/第1课.txt
"""

import argparse
import os
import re
import sys


# 清理标签：HTML 标签（<i>...</i> 等）和 ASS/SSA 样式标记（{\an8} 等）
TAG_PATTERN = re.compile(r'<[^>]+>|\{\\[^}]+\}')


def parse_srt(srt_path: str) -> list[str]:
    """
    解析 SRT 文件，返回字幕文本行列表。

    SRT 格式：
        序号
        HH:MM:SS,mmm --> HH:MM:SS,mmm
        文本内容（可能多行）
        空行
    """
    with open(srt_path, 'r', encoding='utf-8') as f:
        content = f.read()

    blocks = re.split(r'\n\s*\n', content.strip())

    texts = []
    for block in blocks:
        lines = block.strip().split('\n')
        if len(lines) < 3:
            # 可能是纯文本行
            if len(lines) == 1 and not re.match(r'^\d+$', lines[0].strip()):
                cleaned = TAG_PATTERN.sub('', lines[0].strip()).strip()
                if cleaned:
                    texts.append(cleaned)
            continue

        # 第一行：序号；第二行：时间戳；第三行起：文本
        text_lines = lines[2:]
        text = ' '.join(line.strip() for line in text_lines if line.strip())
        # 清理 HTML / ASS 样式标签
        text = TAG_PATTERN.sub('', text).strip()
        if text:
            texts.append(text)

    return texts


def srt_to_text(srt_path: str) -> str:
    """SRT 文件 → 纯文本字符串"""
    return '\n'.join(parse_srt(srt_path))


def main():
    parser = argparse.ArgumentParser(description='SRT 字幕 → 纯文本')
    parser.add_argument('--input', required=True, help='输入 SRT 文件')
    parser.add_argument('--output', required=True, help='输出文本文件')
    args = parser.parse_args()

    if not os.path.isfile(args.input):
        print(f"[错误] 输入文件不存在: {args.input}")
        sys.exit(1)

    os.makedirs(os.path.dirname(args.output), exist_ok=True)

    text = srt_to_text(args.input)
    line_count = text.count('\n') + 1

    with open(args.output, 'w', encoding='utf-8') as f:
        f.write(text)

    print(f"  {os.path.basename(args.input)} → {os.path.basename(args.output)} "
          f"({line_count} 行, {len(text)} 字符)")


if __name__ == '__main__':
    main()
