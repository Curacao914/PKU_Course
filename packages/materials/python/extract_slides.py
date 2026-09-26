#!/usr/bin/env python3
"""把课件抽成每页文字。PPTX / PDF / DOCX / XLSX / 纯文本，尽量只用标准库。

为什么不用 python-pptx / pdfplumber 之类：服务器可用内存只有 1.2G，这条链路要长期
无人值守地跑，能不加依赖就不加。Office 的新格式（pptx/docx/xlsx）本来就是 zip + XML，
标准库足够；PDF 结构复杂，交给系统的 pdftotext（poppler-utils）——
它是个成熟二进制，比在 Python 里自己解析靠谱得多。

用法：python3 extract_slides.py <文件>
输出：{"slideCount": N, "slides": [{"slideNumber": 1, "text": "..."}]}

"页"的口径按格式定：
  pptx → 一张幻灯片一页
  pdf  → 一页 PDF 一页
  docx → 按段落分块，每块一页（默认 40 段）
  xlsx → 一个工作表一页
  文本 → 整体一页
"""
import json
import os
import re
import shutil
import subprocess
import sys
import zipfile
from xml.etree import ElementTree as ET

A = "{http://schemas.openxmlformats.org/drawingml/2006/main}"
W = "{http://schemas.openxmlformats.org/wordprocessingml/2006/main}"
S = "{http://schemas.openxmlformats.org/spreadsheetml/2006/main}"
SLIDE_RE = re.compile(r"ppt/slides/slide(\d+)\.xml$")
DOCX_CHUNK_PARAGRAPHS = 40


def slide_number(name):
    match = SLIDE_RE.search(name)
    return int(match.group(1)) if match else 0


def paragraph_text(paragraph, tag):
    return "".join(node.text or "" for node in paragraph.iter(tag)).strip()


def extract_pptx(path):
    with zipfile.ZipFile(path) as archive:
        names = [name for name in archive.namelist() if SLIDE_RE.search(name)]
        slides = []
        for name in sorted(names, key=slide_number):
            root = ET.fromstring(archive.read(name))
            lines = [paragraph_text(p, f"{A}t") for p in root.iter(f"{A}p")]
            lines = [line for line in lines if line]
            slides.append({"slideNumber": slide_number(name), "text": "\n".join(lines)})
    return {"slideCount": len(slides), "slides": slides}


def extract_docx(path):
    with zipfile.ZipFile(path) as archive:
        root = ET.fromstring(archive.read("word/document.xml"))
    paragraphs = [paragraph_text(p, f"{W}t") for p in root.iter(f"{W}p")]
    paragraphs = [text for text in paragraphs if text]
    slides = []
    for start in range(0, len(paragraphs), DOCX_CHUNK_PARAGRAPHS):
        chunk = paragraphs[start:start + DOCX_CHUNK_PARAGRAPHS]
        slides.append({"slideNumber": len(slides) + 1, "text": "\n".join(chunk)})
    return {"slideCount": len(slides), "slides": slides}


def extract_xlsx(path):
    with zipfile.ZipFile(path) as archive:
        names = archive.namelist()
        shared = []
        if "xl/sharedStrings.xml" in names:
            root = ET.fromstring(archive.read("xl/sharedStrings.xml"))
            for item in root.iter(f"{S}si"):
                shared.append("".join(node.text or "" for node in item.iter(f"{S}t")).strip())
        sheets = [name for name in names if re.match(r"xl/worksheets/sheet\d+\.xml$", name)]
        slides = []
        for index, name in enumerate(sorted(sheets), start=1):
            root = ET.fromstring(archive.read(name))
            rows = []
            for row in root.iter(f"{S}row"):
                cells = []
                for cell in row.iter(f"{S}c"):
                    value = cell.find(f"{S}v")
                    if value is None or value.text is None:
                        continue
                    text = value.text
                    if cell.get("t") == "s":
                        try:
                            text = shared[int(text)]
                        except (ValueError, IndexError):
                            pass
                    if text.strip():
                        cells.append(text.strip())
                if cells:
                    rows.append(" | ".join(cells))
            if rows:
                slides.append({"slideNumber": index, "text": "\n".join(rows)})
    return {"slideCount": len(slides), "slides": slides}


def extract_pdf(path):
    binary = shutil.which("pdftotext")
    if not binary:
        raise RuntimeError("系统里没有 pdftotext（apt-get install poppler-utils）")
    # -layout 保留版面（表格不至于糊成一团）；pdftotext 用换页符分页
    result = subprocess.run([binary, "-layout", path, "-"], capture_output=True, timeout=180)
    if result.returncode != 0:
        raise RuntimeError(f"pdftotext 退出码 {result.returncode}：{result.stderr.decode('utf-8', 'ignore')[:200]}")
    pages = result.stdout.decode("utf-8", "ignore").split("\f")
    slides = []
    for text in pages:
        cleaned = "\n".join(line.rstrip() for line in text.splitlines()).strip()
        if cleaned:
            slides.append({"slideNumber": len(slides) + 1, "text": cleaned})
    return {"slideCount": len(slides), "slides": slides}


def extract_text(path):
    for encoding in ("utf-8", "utf-8-sig", "gb18030"):
        try:
            with open(path, encoding=encoding) as handle:
                text = handle.read()
            break
        except UnicodeDecodeError:
            continue
    else:
        raise RuntimeError("读不出文本（编码不支持）")
    return {"slideCount": 1, "slides": [{"slideNumber": 1, "text": text.strip()}]}


def extract_json(path):
    with open(path, encoding="utf-8") as handle:
        data = json.load(handle)
    slides = data.get("slides") or []
    return {"slideCount": len(slides), "slides": slides}


HANDLERS = {
    ".pptx": extract_pptx,
    ".docx": extract_docx,
    ".xlsx": extract_xlsx,
    ".pdf": extract_pdf,
    ".json": extract_json,
    ".txt": extract_text,
    ".md": extract_text,
}


def main(argv):
    if len(argv) != 2:
        print("用法：python3 extract_slides.py <文件>", file=sys.stderr)
        return 2
    path = argv[1]
    extension = os.path.splitext(path)[1].lower()
    handler = HANDLERS.get(extension)
    if handler is None:
        print(f"不支持的课件格式：{extension or '（无扩展名）'}（支持 pptx / pdf / docx / xlsx / txt / md）", file=sys.stderr)
        return 3
    try:
        result = handler(path)
    except (zipfile.BadZipFile, ET.ParseError) as error:
        print(f"解析失败：{error}", file=sys.stderr)
        return 1
    except RuntimeError as error:
        print(f"解析失败：{error}", file=sys.stderr)
        return 1
    except subprocess.TimeoutExpired:
        print("解析失败：PDF 太大或损坏，超时", file=sys.stderr)
        return 1
    print(json.dumps(result, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
