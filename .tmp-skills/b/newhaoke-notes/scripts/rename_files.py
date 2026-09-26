#!/usr/bin/env python3
"""
安全重命名 raw/ 中的课程文件为标准格式。

支持将以下格式重命名为格式 A：

  格式 B：{课程名}-{老师名}-YYYY-MM-DD第X-Y节_原文.srt
  → 格式 A：{课程名} - YYYY-MM-DD第X-Y节 - {老师名}_原文.srt

用法：
    # 预览（dry-run，不执行实际重命名）
    python rename_files.py --dir ./课程目录

    # 执行重命名
    python rename_files.py --dir ./课程目录 --apply

    # 只查看不匹配的文件
    python rename_files.py --dir ./课程目录 --check-only

安全特性：
    - 默认 dry-run，加 --apply 才执行
    - 重命名前检查目标文件名是否冲突
    - 所有文件操作使用 Python（非 bash），正确处理中文文件名
"""

import argparse
import os
import re
import sys


# 格式 A 正则（目标格式）
PATTERN_A = re.compile(
    r'^(.+?)\s*-\s*'
    r'(\d{4}-\d{2}-\d{2})'
    r'第(\d+(?:-\d+)?)节'
    r'\s*-\s*'
    r'(.+?)'
    r'_(原文|PPT)\.(srt|pptx)$',
    re.IGNORECASE,
)

# 格式 B 正则（替代格式）
PATTERN_B = re.compile(
    r'^(.+)-'
    r'([^-]+)-'
    r'(\d{4}-\d{2}-\d{2})'
    r'第([\d-]+)节'
    r'_(原文|PPT)\.(srt|pptx)$',
    re.IGNORECASE,
)


def to_format_a(match_result: dict) -> str:
    """将解析结果转换为格式 A 的文件名"""
    course = match_result['course_name']
    date = match_result['date']
    period = match_result['period']
    teacher = match_result['teacher']
    type_tag = match_result['type_tag']
    ext = match_result['ext']
    return f'{course} - {date}第{period}节 - {teacher}_{type_tag}.{ext}'


def check_collisions(rename_map: dict) -> list:
    """检查目标文件名是否有冲突，返回冲突列表"""
    seen = {}
    collisions = []
    for src, dst in rename_map.items():
        if dst in seen:
            collisions.append(f"  冲突：'{src}' 和 '{seen[dst]}' 都将被重命名为 '{dst}'")
        else:
            seen[dst] = src
    return collisions


def main():
    parser = argparse.ArgumentParser(description='安全重命名课程文件为标准格式')
    parser.add_argument('--dir', required=True, help='课程工作目录')
    parser.add_argument('--apply', action='store_true', help='执行重命名（默认 dry-run）')
    parser.add_argument('--check-only', action='store_true', help='只显示不匹配的文件，不执行重命名')
    args = parser.parse_args()

    raw_dir = os.path.join(args.dir, 'raw')
    if not os.path.isdir(raw_dir):
        print(f"[错误] raw 目录不存在: {raw_dir}")
        sys.exit(1)

    # 扫描文件
    files = [f for f in os.listdir(raw_dir)
             if os.path.isfile(os.path.join(raw_dir, f)) and not f.startswith('.')]

    if not files:
        print("raw/ 目录为空，无需处理。")
        return

    matching_a = []
    matching_b = []
    unmatched = []

    for f in files:
        if PATTERN_A.match(f):
            matching_a.append(f)
        elif PATTERN_B.match(f):
            matching_b.append(f)
        else:
            unmatched.append(f)

    # 报告扫描结果
    print(f"文件统计：共 {len(files)} 个")
    print(f"  ✓ 已是格式 A：{len(matching_a)} 个")
    print(f"  → 格式 B（需重命名）：{len(matching_b)} 个")
    print(f"  ? 不匹配：{len(unmatched)} 个")
    print()

    if args.check_only:
        if unmatched:
            print("不匹配的文件（请手动检查命名格式）：")
            for f in unmatched:
                print(f"  - {f}")
        return

    # 建立重命名映射
    rename_map = {}
    for f in matching_b:
        m = PATTERN_B.match(f)
        if not m:
            continue

        course = m.group(1).strip()
        teacher = m.group(2).strip()
        date = m.group(3)
        period = m.group(4)
        type_tag = m.group(5)
        ext = m.group(6).lower()

        # 校验
        if not course or not teacher:
            print(f"  [跳过] 无法解析出课程名或老师名：{f}")
            continue

        new_name = f'{course} - {date}第{period}节 - {teacher}_{type_tag}.{ext}'
        rename_map[f] = new_name

    # 检查冲突
    collisions = check_collisions(rename_map)
    if collisions:
        print("[错误] 检测到目标文件名冲突，重命名已中止：")
        for c in collisions:
            print(c)
        sys.exit(1)

    if not rename_map:
        print("没有需要重命名的文件。")
        return

    # 检查目标文件是否已存在（会覆盖）
    existing_targets = []
    for src, dst in rename_map.items():
        dst_path = os.path.join(raw_dir, dst)
        if os.path.exists(dst_path):
            existing_targets.append((src, dst))

    if existing_targets:
        print("[错误] 以下目标文件名已存在，重命名会覆盖已有文件：")
        for src, dst in existing_targets:
            print(f"  '{src}' → '{dst}'（已存在）")
        print("请手动处理冲突后重试。")
        sys.exit(1)

    # 执行重命名
    print(f"重命名计划（{len(rename_map)} 个文件）：")
    for src, dst in rename_map.items():
        print(f"  {src}")
        print(f"    → {dst}")

    if not args.apply:
        print(f"\n这是 dry-run 模式，未执行任何操作。")
        print(f"确认无误后请执行：python rename_files.py --dir {args.dir} --apply")
        return

    # 实际执行
    for src, dst in rename_map.items():
        src_path = os.path.join(raw_dir, src)
        dst_path = os.path.join(raw_dir, dst)
        try:
            os.rename(src_path, dst_path)
            print(f"  ✓ {src} → {dst}")
        except OSError as e:
            print(f"  ✗ 重命名失败 '{src}': {e}")

    print(f"\n完成。共重命名 {len(rename_map)} 个文件。")


if __name__ == '__main__':
    main()
