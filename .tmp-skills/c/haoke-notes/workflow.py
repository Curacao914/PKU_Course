#!/usr/bin/env python3
"""
好课工作流 — 主入口
从 SRT 转写稿 + PPT/PPTX 课件到结构化笔记的端到端预处理工作流。

用法：
    # 完整流程（Step 1-5）
    python workflow.py run --dir ./课程目录

    # 单步执行
    python workflow.py scan --dir ./课程目录
    python workflow.py srt --dir ./课程目录
    python workflow.py ppt --dir ./课程目录       # 文字提取或 OCR（自动判断）
    python workflow.py split --dir ./课程目录

    # 断点恢复
    python workflow.py run --dir ./课程目录 --resume

    # 只处理部分课程
    python workflow.py run --dir ./课程目录 --lessons 1,3,5
"""

import argparse
import datetime
import json
import os
import subprocess
import sys

# 将 scripts 目录加入路径
SCRIPT_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'scripts')
sys.path.insert(0, SCRIPT_DIR)


# ---- changelog ----

def get_changelog_path(work_dir: str) -> str:
    return os.path.join(work_dir, '.haoke_changelog.md')


def update_changelog(work_dir: str, step: str, status: str, description: str):
    path = get_changelog_path(work_dir)
    date = datetime.datetime.now().strftime('%Y-%m-%d %H:%M')
    status_icon = {'done': '✅', 'running': '🔄', 'failed': '❌',
                   'pending': '⏳'}.get(status, status)
    row = f"| {step} | {date} | {status_icon} | {description} |"

    if os.path.exists(path):
        with open(path, 'r', encoding='utf-8') as f:
            content = f.read()
    else:
        content = ("# 好课工作流 — 进度追踪\n\n"
                   "| 步骤 | 时间 | 状态 | 说明 |\n"
                   "|------|------|------|------|\n")

    content += row + '\n'
    with open(path, 'w', encoding='utf-8') as f:
        f.write(content)


# ---- lesson_map ----

def load_lesson_map(work_dir: str) -> dict:
    path = os.path.join(work_dir, 'working', 'lesson_map.json')
    if not os.path.exists(path):
        return None
    with open(path, 'r', encoding='utf-8') as f:
        return json.load(f)


def save_lesson_map(work_dir: str, lesson_map: dict):
    working_dir = os.path.join(work_dir, 'working')
    os.makedirs(working_dir, exist_ok=True)
    path = os.path.join(working_dir, 'lesson_map.json')
    with open(path, 'w', encoding='utf-8') as f:
        json.dump(lesson_map, f, ensure_ascii=False, indent=2)


def filter_lessons(lesson_map: dict, lessons_filter: str) -> list:
    if not lessons_filter:
        return lesson_map['lessons']
    nums = [int(x) for x in lessons_filter.split(',')]
    return [l for l in lesson_map['lessons'] if l['lesson_num'] in nums]


# ---- Step 1: 扫描 ----

def cmd_scan(args):
    import scan_files as scan

    work_dir = args.dir
    raw_dir = os.path.join(work_dir, 'raw')

    update_changelog(work_dir, 'scan', 'running', '扫描文件')
    lesson_map = scan.scan_and_sort(raw_dir)
    save_lesson_map(work_dir, lesson_map)
    update_changelog(work_dir, 'scan', 'done',
                     f'扫描完成，共 {len(lesson_map["lessons"])} 节课')


# ---- Step 2: SRT → 文本 ----

def cmd_srt(args):
    import parse_srt as srt

    work_dir = args.dir
    lesson_map = load_lesson_map(work_dir)
    if not lesson_map:
        print("[错误] 未找到 lesson_map.json，请先运行 scan")
        sys.exit(1)

    output_dir = os.path.join(work_dir, 'data', 'transcripts')
    os.makedirs(output_dir, exist_ok=True)

    update_changelog(work_dir, 'srt', 'running', 'SRT 转文本')

    lessons = filter_lessons(lesson_map, args.lessons)
    raw_dir = os.path.join(work_dir, 'raw')

    for lesson in lessons:
        lesson_num = lesson['lesson_num']
        srt_file = lesson.get('srt_file')
        if not srt_file:
            print(f"  [跳过] 第{lesson_num}课: 无 SRT 文件")
            continue

        srt_path = os.path.join(raw_dir, srt_file)
        output_path = os.path.join(output_dir, f'第{lesson_num}课.txt')

        if args.resume and os.path.exists(output_path):
            print(f"  [跳过] 第{lesson_num}课: 已存在")
            continue

        print(f"  第{lesson_num}课: {srt_file}")
        text = srt.srt_to_text(srt_path)
        with open(output_path, 'w', encoding='utf-8') as f:
            f.write(text)
        line_count = text.count('\n') + 1
        print(f"    → {line_count} 行, {len(text)} 字符")

    update_changelog(work_dir, 'srt', 'done', 'SRT 转文本完成')


# ---- Step 3: PPT 处理（文字提取或 OCR，自动判断）----

def cmd_ppt(args):
    """
    PPT 路径预判 + 处理：
      1. 用 extract_ppt.py 检查每节 PPT 是带文字还是纯图
      2. 带文字 → 直接生成 ppt_md/第N课_ppt.md（python-pptx 提取，无需 API）
      3. 纯图 → extract_slides.py 拆图 + ocr_ppt.py 调用 GLM-OCR
    """
    import extract_ppt
    import extract_slides
    import ocr_ppt

    work_dir = args.dir
    lesson_map = load_lesson_map(work_dir)
    if not lesson_map:
        print("[错误] 未找到 lesson_map.json，请先运行 scan")
        sys.exit(1)

    raw_dir = os.path.join(work_dir, 'raw')
    ppt_md_dir = os.path.join(work_dir, 'data', 'ppt_md')
    ppt_images_dir = os.path.join(work_dir, 'data', 'ppt_images')
    os.makedirs(ppt_md_dir, exist_ok=True)

    update_changelog(work_dir, 'ppt', 'running', 'PPT 处理（文字提取 / OCR）')

    lessons = filter_lessons(lesson_map, args.lessons)

    # 第一遍：尝试文字提取，记录哪些需要 OCR
    needs_ocr = []
    for lesson in lessons:
        lesson_num = lesson['lesson_num']
        pptx_file = lesson.get('pptx_file')
        if not pptx_file:
            print(f"  [跳过] 第{lesson_num}课: 无 PPT 文件")
            continue

        if pptx_file.lower().endswith('.ppt') and not pptx_file.lower().endswith('.pptx'):
            print(f"\n  [⚠️ 第{lesson_num}课] 检测到 .ppt 格式: {pptx_file}")
            print(f"     .ppt 不支持自动处理。请用 PowerPoint / WPS / Keynote 打开，")
            print(f"     另存为 .pptx 后再继续。不要尝试 libreoffice 等命令行工具。")
            update_changelog(work_dir, f'ppt-第{lesson_num}课', 'failed',
                             f'.ppt 格式需手动转 .pptx: {pptx_file}')
            continue

        pptx_path = os.path.join(raw_dir, pptx_file)
        output_md = os.path.join(ppt_md_dir, f'第{lesson_num}课_ppt.md')

        if args.resume and os.path.exists(output_md):
            print(f"  [跳过] 第{lesson_num}课: ppt_md 已存在")
            continue

        print(f"\n  第{lesson_num}课: 分析 {pptx_file}")
        try:
            result = extract_ppt.extract_to_md(pptx_path, output_md)
        except Exception as e:
            print(f"    [错误] PPT 分析失败: {e}")
            continue

        if result['route'] == 'text':
            print(f"    ✓ 带文字 PPT，已直接提取（{result['slides']} 页, "
                  f"平均 {result['avg_text_per_slide']} 字/页）")
        else:
            print(f"    → 纯图 PPT，将走 OCR（{result['reason']}）")
            needs_ocr.append((lesson_num, pptx_path))

    # 第二遍：对需要 OCR 的课，先拆图，再调用 GLM-OCR
    if needs_ocr:
        print(f"\n  共 {len(needs_ocr)} 节课需要 OCR 处理")

        api_key = args.api_key or os.environ.get('ZHIPUAI_API_KEY')
        if not api_key:
            print("\n[错误] 需要 OCR 但未配置 ZHIPUAI_API_KEY 环境变量。")
            print("       请设置后重新运行，或仅使用带文字的 PPT。")
            update_changelog(work_dir, 'ppt', 'failed',
                             f'有 {len(needs_ocr)} 节课需 OCR，但未配置 API Key')
            sys.exit(1)

        from zai import ZhipuAiClient
        client = ZhipuAiClient(api_key=api_key)

        os.makedirs(ppt_images_dir, exist_ok=True)

        for lesson_num, pptx_path in needs_ocr:
            ppt_dir = os.path.join(ppt_images_dir, f'ppt_{lesson_num}')
            output_md = os.path.join(ppt_md_dir, f'第{lesson_num}课_ppt.md')

            # 拆图
            print(f"\n  第{lesson_num}课: 拆图 → {ppt_dir}")
            if not (args.resume and os.path.isdir(ppt_dir) and os.listdir(ppt_dir)):
                extract_slides.extract_and_save(pptx_path, ppt_dir)

            # OCR
            print(f"  第{lesson_num}课: OCR → {os.path.basename(output_md)}")
            result = ocr_ppt.process_ppt_directory(client, ppt_dir, output_md,
                                                   args.max_workers)
            print(f"    {result['slides']} 页")

    update_changelog(work_dir, 'ppt', 'done', 'PPT 处理完成')


# ---- Step 5: 切分 ----

def cmd_split(args):
    import split_transcript as splitter

    work_dir = args.dir
    lesson_map = load_lesson_map(work_dir)
    if not lesson_map:
        print("[错误] 未找到 lesson_map.json，请先运行 scan")
        sys.exit(1)

    transcripts_dir = os.path.join(work_dir, 'data', 'transcripts')
    segments_dir = os.path.join(work_dir, 'data', 'segments')

    if not os.path.isdir(transcripts_dir):
        print(f"[错误] transcripts 目录不存在: {transcripts_dir}")
        sys.exit(1)

    update_changelog(work_dir, 'split', 'running', f'切分转录 (目标 {args.lines} 行)')

    os.makedirs(segments_dir, exist_ok=True)
    lessons = filter_lessons(lesson_map, args.lessons)

    for lesson in lessons:
        lesson_num = lesson['lesson_num']
        input_path = os.path.join(transcripts_dir, f'第{lesson_num}课.txt')

        if not os.path.exists(input_path):
            print(f"  [跳过] 第{lesson_num}课: 转录文件不存在")
            continue

        print(f"\n切分: 第{lesson_num}课.txt")
        metadata = splitter.split_transcript(
            input_path, segments_dir,
            target_lines=args.lines,
            tolerance=args.tolerance,
            min_segment=args.min_segment
        )
        print(f"  {metadata['total_lines']} 行 → {metadata['num_segments']} 段")

    update_changelog(work_dir, 'split', 'done', '切分完成')


# ---- 完整流程 ----

def cmd_run(args):
    print("=" * 60)
    print("  好课工作流 — 完整流程")
    print("=" * 60)
    print()
    print("  提示：单课笔记生成（阶段 2）需要大上下文模式。")
    print("       请确认 Claude Code 已切到 /model deepseek-v4-pro[1m]")
    print()

    steps = [
        ('Step 1: 扫描排序', cmd_scan),
        ('Step 2: SRT 转文本', cmd_srt),
        ('Step 3: PPT 处理', cmd_ppt),
        ('Step 4: 切分转录', cmd_split),
    ]

    for name, func in steps:
        print(f"\n{'=' * 60}")
        print(f"  {name}")
        print(f"{'=' * 60}")
        try:
            func(args)
        except Exception as e:
            print(f"\n✗ {name} 失败: {e}")
            update_changelog(args.dir, name, 'failed', str(e))
            if not args.resume:
                sys.exit(1)

    print(f"\n{'=' * 60}")
    print(f"  预处理全部完成！")
    print(f"{'=' * 60}")
    print(f"  转录: {args.dir}/data/transcripts/")
    print(f"  PPT:  {args.dir}/data/ppt_md/")
    print(f"  分段: {args.dir}/data/segments/")
    print()
    print(f"  下一步：阶段 2 单课笔记生成。")
    print(f"  在 Claude Code 中读 references/preflight.md 完成用户问卷，")
    print(f"  然后按 references/note-writing.md 生成笔记。")


# ---- CLI ----

def main():
    parser = argparse.ArgumentParser(description='好课工作流')
    subparsers = parser.add_subparsers(dest='command', help='子命令')

    # run
    p_run = subparsers.add_parser('run', help='运行完整流程')
    p_run.add_argument('--dir', required=True, help='课程工作目录')
    p_run.add_argument('--resume', action='store_true', help='断点恢复')
    p_run.add_argument('--lessons', default=None, help='只处理指定课程，逗号分隔')
    p_run.add_argument('--lines', type=int, default=500, help='切分行数')
    p_run.add_argument('--tolerance', type=int, default=50, help='切分容差')
    p_run.add_argument('--min-segment', type=int, default=200, help='最小段行数')
    p_run.add_argument('--max-workers', type=int, default=2,
                       help='OCR 并发数（默认 2，匹配 GLM-OCR 限流）')
    p_run.add_argument('--api-key', default=None, help='GLM-OCR API Key')

    # scan
    p_scan = subparsers.add_parser('scan', help='扫描文件，建立课次映射')
    p_scan.add_argument('--dir', required=True)

    # srt
    p_srt = subparsers.add_parser('srt', help='SRT 转文本')
    p_srt.add_argument('--dir', required=True)
    p_srt.add_argument('--resume', action='store_true')
    p_srt.add_argument('--lessons', default=None)

    # ppt（合并 extract-ppt + extract-slides + ocr）
    p_ppt = subparsers.add_parser('ppt', help='PPT 处理（文字提取或 OCR，自动判断）')
    p_ppt.add_argument('--dir', required=True)
    p_ppt.add_argument('--resume', action='store_true')
    p_ppt.add_argument('--lessons', default=None)
    p_ppt.add_argument('--max-workers', type=int, default=2)
    p_ppt.add_argument('--api-key', default=None)

    # split
    p_split = subparsers.add_parser('split', help='切分转录')
    p_split.add_argument('--dir', required=True)
    p_split.add_argument('--resume', action='store_true')
    p_split.add_argument('--lessons', default=None)
    p_split.add_argument('--lines', type=int, default=500)
    p_split.add_argument('--tolerance', type=int, default=50)
    p_split.add_argument('--min-segment', type=int, default=200)

    args = parser.parse_args()

    if not args.command:
        parser.print_help()
        sys.exit(1)

    commands = {
        'run': cmd_run,
        'scan': cmd_scan,
        'srt': cmd_srt,
        'ppt': cmd_ppt,
        'split': cmd_split,
    }

    commands[args.command](args)


if __name__ == '__main__':
    main()
