#!/usr/bin/env python3
"""
转录 JSON → 纯文本
处理听悟返回的 TextPolish（口语书面化）结果，输出纯文本文件。

用法：
    python process_transcript.py --dir ./test_output --output ./test_output/transcripts
"""

import argparse
import json
import os
import sys
from typing import List


def process_text_polish(json_path: str, with_timestamps: bool = False) -> str:
    """
    处理听悟 TextPolish JSON，输出纯文本。
    TextPolish 格式：[{FormalParagraphText, ParagraphId, SentenceIds, Start, End}, ...]
    """
    with open(json_path, 'r', encoding='utf-8') as f:
        data = json.load(f)

    # 兼容两种格式：直接是列表，或包在 TaskId + TextPolish 里
    if isinstance(data, list):
        paragraphs = data
    elif isinstance(data, dict) and 'TextPolish' in data:
        paragraphs = data['TextPolish']
    else:
        print(f"[错误] 未知的 TextPolish 格式，顶层 keys: {list(data.keys()) if isinstance(data, dict) else type(data)}")
        sys.exit(1)

    lines = []
    for para in paragraphs:
        text = para.get('FormalParagraphText', '').strip()
        if not text:
            continue

        if with_timestamps:
            start_ms = para.get('Start', 0)
            timestamp = format_timestamp(start_ms)
            lines.append(f'[{timestamp}] {text}')
        else:
            lines.append(text)

    return '\n'.join(lines)


def process_transcription(json_path: str, with_timestamps: bool = False) -> str:
    """
    处理听悟 Transcription JSON，输出纯文本。
    格式：{Transcription: {Paragraphs: [{Words: [{Text, SentenceId, Start}, ...]}, ...]}}
    """
    with open(json_path, 'r', encoding='utf-8') as f:
        data = json.load(f)

    transcription = data.get('Transcription', data)
    paragraphs = transcription.get('Paragraphs', [])

    lines = []
    for para in paragraphs:
        words = para.get('Words', [])
        if not words:
            continue

        # 按 SentenceId 分组
        sentences = {}
        for word in words:
            sid = word.get('SentenceId', 0)
            if sid not in sentences:
                sentences[sid] = []
            sentences[sid].append(word)

        # 拼接每个句子
        para_text_parts = []
        para_start = None
        for sid in sorted(sentences.keys()):
            sent_words = sentences[sid]
            sent_text = ''.join(w.get('Text', '') for w in sent_words)
            if para_start is None:
                para_start = sent_words[0].get('Start', 0)
            para_text_parts.append(sent_text)

        para_text = ''.join(para_text_parts)
        if not para_text.strip():
            continue

        if with_timestamps and para_start is not None:
            timestamp = format_timestamp(para_start)
            lines.append(f'[{timestamp}] {para_text}')
        else:
            lines.append(para_text)

    return '\n'.join(lines)


def format_timestamp(ms: int) -> str:
    """毫秒转 HH:MM:SS 格式"""
    total_seconds = ms // 1000
    hours = total_seconds // 3600
    minutes = (total_seconds % 3600) // 60
    seconds = total_seconds % 60
    return f'{hours:02d}:{minutes:02d}:{seconds:02d}'


def main():
    parser = argparse.ArgumentParser(description='转录 JSON → 纯文本')
    parser.add_argument('--dir', required=True, help='工作目录（包含 raw/ 子目录）')
    parser.add_argument('--output', help='输出目录（默认: {dir}/transcripts）')
    parser.add_argument('--with-timestamps', action='store_true', help='保留时间戳')
    parser.add_argument('--source', choices=['polish', 'transcription', 'auto'],
                        default='auto', help='数据源（默认: auto，优先用 TextPolish）')
    args = parser.parse_args()

    work_dir = args.dir
    raw_dir = os.path.join(work_dir, 'data', 'raw')
    output_dir = args.output or os.path.join(work_dir, 'data', 'transcripts')
    os.makedirs(output_dir, exist_ok=True)

    if not os.path.isdir(raw_dir):
        print(f"[错误] raw 目录不存在: {raw_dir}")
        sys.exit(1)

    # 查找所有转录文件
    files = sorted(os.listdir(raw_dir))
    polish_files = [f for f in files if f.startswith('text_polish') and f.endswith('.json')]
    trans_files = [f for f in files if f.startswith('transcription') and f.endswith('.json')]

    if args.source == 'polish' and not polish_files:
        print("[错误] 未找到 TextPolish 文件")
        sys.exit(1)

    # 确定要处理的文件
    if args.source == 'polish' or (args.source == 'auto' and polish_files):
        target_files = polish_files
        process_func = process_text_polish
        source_name = 'TextPolish'
    else:
        target_files = trans_files
        process_func = process_transcription
        source_name = 'Transcription'

    print(f"数据源: {source_name}")
    print(f"找到 {len(target_files)} 个文件")

    for fname in target_files:
        # 从文件名提取课程序号
        # 格式: text_polish_1.json 或 transcription_1.json
        num = fname.split('_')[-1].replace('.json', '')
        lesson_name = f'第{num}课'

        input_path = os.path.join(raw_dir, fname)
        output_path = os.path.join(output_dir, f'{lesson_name}.txt')

        print(f"\n处理: {fname} → {lesson_name}.txt")
        text = process_func(input_path, with_timestamps=args.with_timestamps)
        line_count = text.count('\n') + 1

        with open(output_path, 'w', encoding='utf-8') as f:
            f.write(text)

        print(f"  输出: {output_path} ({line_count} 行, {len(text)} 字符)")

    print(f"\n完成。输出目录: {output_dir}")


if __name__ == '__main__':
    main()
