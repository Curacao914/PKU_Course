#!/usr/bin/env python3
"""
从 PPTX 提取幻灯片图片
适用于纯图型 PPTX（每张幻灯片是一张嵌入图片），提取后保存为 PNG。
后续由 ocr_ppt.py 进行 OCR 识别。

用法：
    python extract_slides.py --input raw/xxx_PPT.pptx --output data/ppt_images/ppt_1
"""

import argparse
import os
import sys

from pptx import Presentation
from pptx.enum.shapes import MSO_SHAPE_TYPE


def extract_slide_images(pptx_path: str) -> list:
    """
    从 PPTX 提取每张幻灯片的图片。

    策略（按优先级）：
    1. 幻灯片背景填充图片
    2. 幻灯片中最大的图片形状

    返回：图片二进制数据列表（与幻灯片顺序对应；某页无图则该位置为 None）
    """
    prs = Presentation(pptx_path)
    images = []

    for slide in prs.slides:
        img_blob = None

        # 策略 1：背景填充
        try:
            bg = slide.background
            fill = bg.fill
            if fill.type is not None:
                try:
                    img_blob = fill.image.blob
                except (AttributeError, TypeError):
                    pass
        except Exception:
            pass

        # 策略 2：最大的图片形状
        if img_blob is None:
            largest_area = 0
            for shape in slide.shapes:
                if shape.shape_type == MSO_SHAPE_TYPE.PICTURE:
                    area = shape.width * shape.height
                    if area > largest_area:
                        try:
                            blob = shape.image.blob
                            largest_area = area
                            img_blob = blob
                        except (AttributeError, TypeError):
                            pass

        images.append(img_blob)

    return images


def ensure_png_extension(filename: str) -> str:
    if not filename.lower().endswith('.png'):
        return filename + '.png'
    return filename


def extract_and_save(pptx_path: str, output_dir: str) -> dict:
    """提取 PPTX 幻灯片图片并保存到指定目录。"""
    os.makedirs(output_dir, exist_ok=True)

    print(f"  提取: {os.path.basename(pptx_path)}")
    images = extract_slide_images(pptx_path)

    saved = 0
    skipped = 0
    for i, blob in enumerate(images, 1):
        if blob is None:
            skipped += 1
            continue

        filename = ensure_png_extension(f'幻灯片_{i}.png')
        out_path = os.path.join(output_dir, filename)

        with open(out_path, 'wb') as f:
            f.write(blob)
        saved += 1

    print(f"  共 {len(images)} 张幻灯片: 保存 {saved} 张, 跳过 {skipped} 张")
    return {"total": len(images), "saved": saved, "skipped": skipped}


# workflow.py 调用入口
main_args = extract_and_save


def main():
    parser = argparse.ArgumentParser(description='从 PPTX 提取幻灯片图片')
    parser.add_argument('--input', required=True, help='输入 PPTX 文件')
    parser.add_argument('--output', required=True, help='输出目录（如 data/ppt_images/ppt_1）')
    args = parser.parse_args()

    if not os.path.isfile(args.input):
        print(f"[错误] 输入文件不存在: {args.input}")
        sys.exit(1)

    extract_and_save(args.input, args.output)
    print(f"  输出: {args.output}")


if __name__ == '__main__':
    main()
