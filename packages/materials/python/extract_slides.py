#!/usr/bin/env python3
"""从 .pptx 抽取每页文字，只用标准库。

为什么不用 python-pptx：pptx 就是 zip + XML，按 ppt/slides/slideN.xml 顺序取出
<a:p> 段落里的 <a:t> 文本即可。服务器可用内存只有 1.2G，能不加依赖就不加——
这条链路要长期无人值守地跑，少一个依赖少一份腐坏风险。

用法：python3 extract_slides.py <file.pptx>
输出：{"slideCount": N, "slides": [{"slideNumber": 1, "text": "..."}]}
"""
import json
import re
import sys
import zipfile
from xml.etree import ElementTree as ET

A = "{http://schemas.openxmlformats.org/drawingml/2006/main}"
SLIDE_RE = re.compile(r"ppt/slides/slide(\d+)\.xml$")


def slide_number(name):
    match = SLIDE_RE.search(name)
    return int(match.group(1)) if match else 0


def paragraph_text(paragraph):
    parts = [node.text or "" for node in paragraph.iter(f"{A}t")]
    return "".join(parts).strip()


def extract(path):
    with zipfile.ZipFile(path) as archive:
        names = [name for name in archive.namelist() if SLIDE_RE.search(name)]
        slides = []
        for name in sorted(names, key=slide_number):
            root = ET.fromstring(archive.read(name))
            lines = []
            for paragraph in root.iter(f"{A}p"):
                line = paragraph_text(paragraph)
                if line:
                    lines.append(line)
            slides.append({"slideNumber": slide_number(name), "text": "\n".join(lines)})
    return {"slideCount": len(slides), "slides": slides}


def main(argv):
    if len(argv) != 2:
        print("用法：python3 extract_slides.py <file.pptx>", file=sys.stderr)
        return 2
    try:
        result = extract(argv[1])
    except (zipfile.BadZipFile, ET.ParseError) as error:
        print(f"解析失败：{error}", file=sys.stderr)
        return 1
    print(json.dumps(result, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
