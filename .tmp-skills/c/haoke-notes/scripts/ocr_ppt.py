#!/usr/bin/env python3
"""
PPT 图片 OCR
使用 GLM-OCR 对 PPT 关键帧进行文字识别，输出 Markdown。

并发数默认 2（智谱 GLM-OCR 限流约 2 RPS）。
遇到 429 / rate limit 错误时指数退避重试。

用法：
    python ocr_ppt.py --ppt-dir ./data/ppt_images --output ./data/ppt_md
"""

import argparse
import base64
import os
import re
import sys
import time
from concurrent.futures import ThreadPoolExecutor, as_completed

from zai import ZhipuAiClient


# ---- 清理 OCR 输出 ----

def clean_ocr_output(md: str) -> str:
    """清理 GLM-OCR 输出，只保留文字内容"""
    lines = md.split('\n')
    cleaned = []

    for line in lines:
        stripped = line.strip()

        # 跳过图片引用行
        if re.match(r'^!\[.*\]\(.*\)$', stripped):
            continue

        # 跳过常见水印
        if any(w in stripped for w in (
            '课堂教学视频受知识产权保护',
            '未经北京大学授权',
            '不得翻录转载',
            '违者追究法律责任',
        )):
            continue

        # HTML 表格转 Markdown
        if '<table' in stripped or '</table>' in stripped:
            continue
        if '<tr>' in stripped or '</tr>' in stripped:
            continue
        if '<td>' in stripped or '</td>' in stripped:
            cells = re.findall(r'<td[^>]*>(.*?)</td>', stripped, re.DOTALL)
            if cells:
                cleaned.append('| ' + ' | '.join(c.strip() for c in cells) + ' |')
            continue

        cleaned.append(line)

    result = '\n'.join(cleaned).strip()
    result = re.sub(r'\n{3,}', '\n\n', result)
    return result


# ---- OCR 调用与重试 ----

def is_rate_limit_error(e: Exception) -> bool:
    """判断是否是限流错误（429 / rate limit）"""
    msg = str(e).lower()
    return ('429' in msg or 'rate' in msg or 'limit' in msg or 'too many' in msg)


def ocr_single_image(client, image_path: str) -> str:
    """对单张图片做 OCR"""
    with open(image_path, 'rb') as f:
        b64 = base64.b64encode(f.read()).decode()

    ext = os.path.splitext(image_path)[1].lower().lstrip('.')
    mime = {'png': 'image/png', 'jpg': 'image/jpeg', 'jpeg': 'image/jpeg'}.get(ext, 'image/png')
    file_input = f'data:{mime};base64,{b64}'

    response = client.layout_parsing.create(model='glm-ocr', file=file_input)
    raw_md = response.md_results or ''
    return clean_ocr_output(raw_md)


def ocr_single_image_with_retry(client, image_path: str, max_retries: int = 4) -> str:
    """带指数退避重试的 OCR 调用。

    遇 429 / rate limit 时退避更激进（base 4s）；其他错误退避较温和（base 2s）。
    """
    last_err = None
    for attempt in range(max_retries + 1):
        try:
            return ocr_single_image(client, image_path)
        except Exception as e:
            last_err = e
            if attempt == max_retries:
                break
            if is_rate_limit_error(e):
                wait = 4 * (2 ** attempt)  # 4s, 8s, 16s, 32s
            else:
                wait = 2 * (attempt + 1)   # 2s, 4s, 6s, 8s
            print(f"    重试 {attempt+1}/{max_retries} (等 {wait}s): {e}")
            time.sleep(wait)
    return f'[OCR错误: {last_err}]'


# ---- 主处理逻辑 ----

def find_image_files(directory: str) -> list:
    extensions = {'.png', '.jpg', '.jpeg'}
    files = []
    for f in os.listdir(directory):
        if os.path.splitext(f)[1].lower() in extensions:
            files.append(os.path.join(directory, f))
    return sorted(files)


def process_ppt_directory(client, ppt_dir: str, output_path: str,
                          max_workers: int = 2) -> dict:
    """处理一个 PPT 图片目录，输出合并的 Markdown"""
    images = find_image_files(ppt_dir)
    if not images:
        print(f"  [警告] 未找到图片文件: {ppt_dir}")
        return {"status": "empty", "slides": 0}

    print(f"  找到 {len(images)} 张图片，并发 {max_workers}")

    results = {}
    with ThreadPoolExecutor(max_workers=max_workers) as executor:
        futures = {
            executor.submit(ocr_single_image_with_retry, client, img): (i, img)
            for i, img in enumerate(images)
        }
        for future in as_completed(futures):
            idx, img_path = futures[future]
            md = future.result()
            results[idx] = md
            print(f"    [{idx+1}/{len(images)}] {os.path.basename(img_path)} ✓ ({len(md)} chars)")

    # 合并为单个 Markdown
    output_lines = []
    for i in range(len(images)):
        md = results.get(i, '')
        slide_num = i + 1
        output_lines.append(f'## 幻灯片 {slide_num}')
        output_lines.append(md if md else '（此页无可识别文字内容）')
        output_lines.append('')

    output = '\n'.join(output_lines)

    os.makedirs(os.path.dirname(output_path), exist_ok=True)
    with open(output_path, 'w', encoding='utf-8') as f:
        f.write(output)

    return {"status": "done", "slides": len(images), "output": output_path}


def main():
    parser = argparse.ArgumentParser(description='PPT 图片 OCR')
    parser.add_argument('--ppt-dir', required=True,
                        help='PPT 图片目录（或包含多个 ppt_N 子目录的父目录）')
    parser.add_argument('--output', required=True, help='输出目录')
    parser.add_argument('--max-workers', type=int, default=2,
                        help='并发线程数（默认 2，匹配 GLM-OCR 限流）')
    parser.add_argument('--api-key', default=None, help='GLM-OCR API Key')
    args = parser.parse_args()

    api_key = args.api_key or os.environ.get('ZHIPUAI_API_KEY')
    if not api_key:
        print("[错误] 未提供 API Key。使用 --api-key 或设置 ZHIPUAI_API_KEY。")
        sys.exit(1)

    client = ZhipuAiClient(api_key=api_key)
    os.makedirs(args.output, exist_ok=True)

    ppt_dir = args.ppt_dir
    subdirs = [d for d in os.listdir(ppt_dir)
               if os.path.isdir(os.path.join(ppt_dir, d)) and d.startswith('ppt_')]

    if subdirs:
        print(f"找到 {len(subdirs)} 个 PPT 子目录")
        for subdir in sorted(subdirs):
            lesson_num = subdir.replace('ppt_', '')
            input_dir = os.path.join(ppt_dir, subdir)
            output_path = os.path.join(args.output, f'第{lesson_num}课_ppt.md')
            print(f"\n处理 {subdir}/ → {os.path.basename(output_path)}")
            result = process_ppt_directory(client, input_dir, output_path, args.max_workers)
            print(f"  结果: {result['status']}, {result['slides']} 页")
    else:
        output_path = os.path.join(args.output, 'ppt_ocr.md')
        print(f"处理单目录: {ppt_dir}")
        result = process_ppt_directory(client, ppt_dir, output_path, args.max_workers)
        print(f"结果: {result['status']}, {result['slides']} 页")

    print(f"\n输出目录: {args.output}")


if __name__ == '__main__':
    main()
