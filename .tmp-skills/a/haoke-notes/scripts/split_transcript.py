#!/usr/bin/env python3
"""
按行数切分转录文本
将长转录文本均匀切分为多个段落，便于笔记生成 A 步骤通读 + 行号定位。

用法：
    python split_transcript.py --input transcripts/第1课.txt --output segments/ --lines 500
"""

import argparse
import json
import os
import re
import sys


def find_split_point(lines: list, target: int, tolerance: int = 50) -> int:
    """
    在 target ± tolerance 范围内寻找最佳切分点。
    优先在空行处切分，其次在句号/问号/感叹号结尾的行切分，最后硬切。
    """
    start = max(0, target - tolerance)
    end = min(len(lines), target + tolerance)

    # 空行优先
    for i in range(target, end):
        if i < len(lines) and not lines[i].strip():
            return i
    for i in range(target, start - 1, -1):
        if i < len(lines) and not lines[i].strip():
            return i

    # 句子结尾
    sentence_end = re.compile(r'[。！？…」』）]$')
    for i in range(target, end):
        if i < len(lines) and sentence_end.search(lines[i].strip()):
            return i + 1
    for i in range(target, start - 1, -1):
        if i < len(lines) and sentence_end.search(lines[i].strip()):
            return i + 1

    return target


def split_transcript(input_path: str, output_dir: str, target_lines: int = 500,
                     tolerance: int = 50, min_segment: int = 200) -> dict:
    """切分转录文本文件，返回元数据字典。"""
    with open(input_path, 'r', encoding='utf-8') as f:
        lines = f.readlines()

    total_lines = len(lines)
    if total_lines == 0:
        return {"error": "空文件"}

    if total_lines <= target_lines + tolerance:
        segments = [{
            "index": 1,
            "start_line": 1,
            "end_line": total_lines,
            "line_count": total_lines
        }]
    else:
        segments = []
        pos = 0
        while pos < total_lines:
            remaining = total_lines - pos
            if remaining <= target_lines + tolerance:
                segments.append({
                    "index": len(segments) + 1,
                    "start_line": pos + 1,
                    "end_line": total_lines,
                    "line_count": remaining
                })
                break

            split_at = find_split_point(lines, pos + target_lines, tolerance)
            seg_lines = split_at - pos

            if seg_lines < min_segment and len(segments) > 0:
                # 太短，合并到上一段
                segments[-1]["end_line"] = split_at
                segments[-1]["line_count"] = (
                    segments[-1]["end_line"] - segments[-1]["start_line"] + 1
                )
            else:
                segments.append({
                    "index": len(segments) + 1,
                    "start_line": pos + 1,
                    "end_line": split_at,
                    "line_count": seg_lines
                })

            # 关键：无论是否合并都推进 pos，避免重复切分同一区域
            pos = split_at

    # 写入切分文件
    os.makedirs(output_dir, exist_ok=True)
    base_name = os.path.splitext(os.path.basename(input_path))[0]

    for seg in segments:
        seg_file = f"{base_name}_segment_{seg['index']}.txt"
        seg_path = os.path.join(output_dir, seg_file)

        start = seg['start_line'] - 1  # 0-indexed
        end = seg['end_line']
        seg_content = ''.join(lines[start:end])

        with open(seg_path, 'w', encoding='utf-8') as f:
            f.write(seg_content)

        seg['file'] = seg_file

    metadata = {
        "source_file": os.path.basename(input_path),
        "total_lines": total_lines,
        "target_lines": target_lines,
        "num_segments": len(segments),
        "segments": segments
    }

    meta_path = os.path.join(output_dir, f"{base_name}_segments.json")
    with open(meta_path, 'w', encoding='utf-8') as f:
        json.dump(metadata, f, ensure_ascii=False, indent=2)

    return metadata


def main():
    parser = argparse.ArgumentParser(description='按行数切分转录文本')
    parser.add_argument('--input', required=True, help='输入文本文件')
    parser.add_argument('--output', required=True, help='输出目录')
    parser.add_argument('--lines', type=int, default=500, help='每段目标行数（默认: 500）')
    parser.add_argument('--tolerance', type=int, default=50, help='切分容差（默认: ±50）')
    parser.add_argument('--min-segment', type=int, default=200, help='最小段行数（默认: 200）')
    args = parser.parse_args()

    if not os.path.isfile(args.input):
        print(f"[错误] 输入文件不存在: {args.input}")
        sys.exit(1)

    print(f"输入: {args.input}")
    print(f"目标行数: {args.lines} (±{args.tolerance})")

    metadata = split_transcript(
        args.input, args.output,
        target_lines=args.lines,
        tolerance=args.tolerance,
        min_segment=args.min_segment
    )

    print(f"总行数: {metadata['total_lines']}")
    print(f"切分为: {metadata['num_segments']} 段")
    for seg in metadata['segments']:
        print(f"  段 {seg['index']}: 行 {seg['start_line']}-{seg['end_line']} "
              f"({seg['line_count']} 行) → {seg['file']}")

    print(f"\n输出目录: {args.output}")


if __name__ == '__main__':
    main()
