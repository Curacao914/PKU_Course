#!/usr/bin/env python3
"""
扫描 raw/ 文件夹，解析文件名，按日期+节次排序，建立课次映射。

支持的文件名格式：

  格式 A（推荐）：{课程名} - YYYY-MM-DD第X-Y节 - {老师名}_原文.srt
  示例：知识产权法 - 2026-03-05第10-12节 - 刘银良_原文.srt

  格式 B  (自动识别)：{课程名}-{老师名}-YYYY-MM-DD第X-Y节_原文.srt
  示例：人工智能时代的超级个体：从零开始AI编程实战-刘建波-2026-03-02第10-11节_原文.srt

输出：working/lesson_map.json

用法：
    python scan_files.py --dir ./课程目录
"""

import argparse
import json
import os
import re
import sys
from datetime import datetime


# ---- 文件名解析正则（支持多种格式）----

FILENAME_PATTERNS = [
    # 格式 A：课程名 - YYYY-MM-DD第X-Y节 - 老师名_原文.srt
    # 组顺序：课程名, 日期, 节次, 老师名, 类型, 扩展名
    re.compile(
        r'^(.+?)\s*-\s*'           # 课程名
        r'(\d{4}-\d{2}-\d{2})'     # 日期
        r'第(\d+(?:-\d+)?)节'       # 节次（如 10-12 或 10）
        r'\s*-\s*'                  # 分隔符
        r'(.+?)'                    # 老师名
        r'_(原文|PPT)'              # 类型标记
        r'\.(srt|pptx)$',           # 扩展名
        re.IGNORECASE
    ),

    # 格式 B：课程名-老师名-YYYY-MM-DD第X-Y节_原文.srt
    # 组顺序：课程名, 老师名, 日期, 节次, 类型, 扩展名
    # 注意：老师名不含连字符，课程名可包含连字符
    re.compile(
        r'^(.+)-'                   # 课程名（greedy，回溯到倒数第二个分隔符）
        r'([^-]+)-'                 # 老师名（不含连字符）
        r'(\d{4}-\d{2}-\d{2})'     # 日期
        r'第([\d-]+)节'            # 节次（如 10-12 或 10）
        r'_(原文|PPT)'              # 类型标记
        r'\.(srt|pptx)$',           # 扩展名
        re.IGNORECASE
    ),
]


def parse_filename(filename: str) -> dict | None:
    """解析文件名，返回结构化信息，不匹配则返回 None"""
    # 依序尝试每种格式
    last_error = None
    for i, pattern in enumerate(FILENAME_PATTERNS):
        m = pattern.match(filename)
        if not m:
            continue

        try:
            if i == 0:
                # 格式 A：课程名, 日期, 节次, 老师名, 类型, 扩展名
                course_name = m.group(1).strip()
                date_str = m.group(2)
                period = m.group(3)
                teacher = m.group(4).strip()
                type_tag = m.group(5)
                ext = m.group(6).lower()
            elif i == 1:
                # 格式 B：课程名, 老师名, 日期, 节次, 类型, 扩展名
                course_name = m.group(1).strip()
                teacher = m.group(2).strip()
                date_str = m.group(3)
                period = m.group(4)
                type_tag = m.group(5)
                ext = m.group(6).lower()

            # 校验：字段不能为空
            if not course_name or not teacher:
                continue

            # 解析日期
            date_obj = datetime.strptime(date_str, '%Y-%m-%d')

            # 解析节次起始号用于排序（10-12 → 10）
            period_start = int(period.split('-')[0])

            return {
                'course_name': course_name,
                'date': date_str,
                'date_obj': date_obj,
                'period': period,
                'period_start': period_start,
                'teacher': teacher,
                'type_tag': type_tag,
                'ext': ext,
                'filename': filename,
            }

        except (ValueError, IndexError) as e:
            last_error = e
            continue

    return None


def scan_and_sort(raw_dir: str) -> dict:
    """
    扫描 raw/ 目录，解析文件名，按日期+节次排序，生成课次映射。

    返回 lesson_map 结构：
    {
        "course_name": "知识产权法",
        "teacher": "刘银良",
        "created_at": "...",
        "lessons": [
            {
                "lesson_num": 1,
                "date": "2026-03-05",
                "period": "10-12",
                "srt_file": "...",
                "pptx_file": "..."
            },
            ...
        ]
    }
    """
    if not os.path.isdir(raw_dir):
        print(f"[错误] raw 目录不存在: {raw_dir}")
        sys.exit(1)

    # 扫描所有文件
    files = [f for f in os.listdir(raw_dir)
             if os.path.isfile(os.path.join(raw_dir, f))
             and not f.startswith('.')]

    if not files:
        print(f"[错误] raw 目录为空: {raw_dir}")
        sys.exit(1)

    # 解析文件名
    parsed = []
    skipped = []
    for f in files:
        info = parse_filename(f)
        if info:
            parsed.append(info)
        else:
            skipped.append(f)

    if skipped:
        print(f"[警告] 跳过 {len(skipped)} 个不匹配的文件:")
        for s in skipped:
            print(f"  - {s}")

    if not parsed:
        print("[错误] 没有匹配的文件。支持的文件名格式：\n"
              "  格式 A：课程名 - YYYY-MM-DD第X-Y节 - 老师名_原文.srt\n"
              "  格式 B：课程名-老师名-YYYY-MM-DD第X-Y节_原文.srt")
        sys.exit(1)

    # 按课程名+老师分组（支持不同课程混放在同一目录）
    groups = {}
    for info in parsed:
        key = (info['course_name'], info['teacher'])
        if key not in groups:
            groups[key] = []
        groups[key].append(info)

    # 取最大的组作为主课程（或只有一个组时直接用）
    if len(groups) == 1:
        (course_name, teacher), items = list(groups.items())[0]
    else:
        # 多个课程，选择文件数最多的
        (course_name, teacher), items = max(groups.items(), key=lambda x: len(x[1]))
        print(f"[警告] 发现多个课程，选择文件最多的: {course_name} - {teacher}")

    # 按日期+节次排序
    items.sort(key=lambda x: (x['date_obj'], x['period_start']))

    # 分组：同一日期+节次 = 一节课
    lessons_dict = {}
    for info in items:
        key = (info['date'], info['period'])
        if key not in lessons_dict:
            lessons_dict[key] = {
                'date': info['date'],
                'period': info['period'],
                'srt_file': None,
                'pptx_file': None,
            }
        if info['type_tag'] == '原文':
            lessons_dict[key]['srt_file'] = info['filename']
        elif info['type_tag'] == 'PPT':
            lessons_dict[key]['pptx_file'] = info['filename']

    # 按日期+节次排序并编号
    sorted_keys = sorted(lessons_dict.keys(),
                         key=lambda k: (datetime.strptime(k[0], '%Y-%m-%d'),
                                        int(k[1].split('-')[0])))

    lessons = []
    for i, key in enumerate(sorted_keys, 1):
        lesson = lessons_dict[key]
        lesson['lesson_num'] = i
        lessons.append(lesson)

    # 检查完整性
    warnings = []
    for lesson in lessons:
        if not lesson['srt_file']:
            warnings.append(f"第{lesson['lesson_num']}课 ({lesson['date']}第{lesson['period']}节): 缺少 SRT 文件")
        if not lesson['pptx_file']:
            warnings.append(f"第{lesson['lesson_num']}课 ({lesson['date']}第{lesson['period']}节): 缺少 PPTX 文件")

    if warnings:
        print(f"\n[警告] 文件不完整:")
        for w in warnings:
            print(f"  - {w}")

    lesson_map = {
        'course_name': course_name,
        'teacher': teacher,
        'created_at': datetime.now().isoformat(),
        'lessons': lessons,
    }

    return lesson_map


def main():
    parser = argparse.ArgumentParser(description='扫描 raw/ 文件夹，建立课次映射')
    parser.add_argument('--dir', required=True, help='课程工作目录')
    args = parser.parse_args()

    raw_dir = os.path.join(args.dir, 'raw')
    working_dir = os.path.join(args.dir, 'working')
    os.makedirs(working_dir, exist_ok=True)

    lesson_map = scan_and_sort(raw_dir)

    # 保存 lesson_map.json
    output_path = os.path.join(working_dir, 'lesson_map.json')
    with open(output_path, 'w', encoding='utf-8') as f:
        json.dump(lesson_map, f, ensure_ascii=False, indent=2)

    # 打印结果
    print(f"\n课程: {lesson_map['course_name']}")
    print(f"老师: {lesson_map['teacher']}")
    print(f"共 {len(lesson_map['lessons'])} 节课:\n")

    for lesson in lesson_map['lessons']:
        srt = os.path.basename(lesson['srt_file']) if lesson['srt_file'] else '(缺失)'
        pptx = os.path.basename(lesson['pptx_file']) if lesson['pptx_file'] else '(缺失)'
        print(f"  第{lesson['lesson_num']}课  {lesson['date']} 第{lesson['period']}节")
        print(f"    SRT:  {srt}")
        print(f"    PPTX: {pptx}")

    print(f"\n映射已保存: {output_path}")


if __name__ == '__main__':
    main()
