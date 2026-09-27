#!/usr/bin/env python3
"""把课件抽成每页文字。PPTX / PDF / DOCX / XLSX / 图片 / 纯文本，尽量只用标准库。

为什么不用 python-pptx / pdfplumber 之类：服务器可用内存只有 1.2G，这条链路要长期
无人值守地跑，能不加依赖就不加。Office 的新格式（pptx/docx/xlsx）本来就是 zip + XML，
标准库足够；PDF 结构复杂，交给系统的 pdftotext（poppler-utils）——
它是个成熟二进制，比在 Python 里自己解析靠谱得多。

图片里的文字（OCR）：课件里有一类是"用图片做的"——整页就是一张图，或者正文之外夹着
截图、图表、扫描件。XML 与 pdftotext 都抽不到这些字，缺了它笔记就少一块。
加 --ocr 时这些图会送去 PaddleOCR-VL 识别（见 ocr_paddle.py），文字并进该页；
不加 --ocr 时只数一件事：哪些图可能需要识别（images / ocrPending）。
入库保持秒回，识别单独走一步——一张图要几秒到几十秒，不能挂在上传请求里。

用法：python3 extract_slides.py <文件> [--ocr] [--ocr-max-pages 60] [--ocr-concurrency 3]
输出：{"slideCount": N, "slides": [{"slideNumber": 1, "text": "..."}],
      "images": [...], "ocr": {"pending": N, ...}}

"页"的口径按格式定：
  pptx → 一张幻灯片一页
  pdf  → 一页 PDF 一页（空页也保留，页号必须与原件对得上）
  docx → 按段落分块，每块一页（默认 40 段）
  xlsx → 一个工作表一页
  图片 → 整体一页
  文本 → 整体一页
"""
import argparse
import json
import os
import re
import shutil
import subprocess
import sys
import tempfile
import zipfile
from xml.etree import ElementTree as ET

A = "{http://schemas.openxmlformats.org/drawingml/2006/main}"
W = "{http://schemas.openxmlformats.org/wordprocessingml/2006/main}"
S = "{http://schemas.openxmlformats.org/spreadsheetml/2006/main}"
R = "{http://schemas.openxmlformats.org/officeDocument/2006/relationships}"
SLIDE_RE = re.compile(r"ppt/slides/slide(\d+)\.xml$")
DOCX_CHUNK_PARAGRAPHS = 40

# 什么样的图值得送去识别：图标、logo、装饰线条不必花钱花时间。
# 阈值按"最小可读的截图/图表"定，宁可漏掉一点小的，也不要把整套课的图标都识别一遍。
IMAGE_MIN_BYTES = 30 * 1024
IMAGE_MIN_WIDTH = 400
IMAGE_MIN_HEIGHT = 200
PDF_MIN_TEXT = 20
OCR_MARKER = "【图片文字】"
IMAGE_SUFFIXES = (".png", ".jpg", ".jpeg", ".bmp", ".webp", ".tif", ".tiff", ".gif")


def load_ocr():
    """OCR 是可选能力：没装模块或没配令牌时，课件照样要能入库。"""
    try:
        import ocr_paddle
    except ImportError:
        return None
    return ocr_paddle


def slide_number(name):
    match = SLIDE_RE.search(name)
    return int(match.group(1)) if match else 0


def paragraph_text(paragraph, tag):
    return "".join(node.text or "" for node in paragraph.iter(tag)).strip()


# ── 图片清单：先数清楚，再决定要不要识别 ─────────────────────────────────

def image_entry(ocr_paddle, archive, name, min_bytes=IMAGE_MIN_BYTES):
    """一张内嵌图片的档案：多大、什么尺寸、出现在哪几页、值不值得识别。"""
    info = archive.getinfo(name)
    payload = archive.read(name)
    digest = ""
    width = height = 0
    if ocr_paddle is not None:
        digest = ocr_paddle.sha1_of_bytes(payload)
        with tempfile.NamedTemporaryFile(suffix=os.path.splitext(name)[1], delete=False) as handle:
            handle.write(payload)
            probe = handle.name
        try:
            width, height = ocr_paddle.image_size(probe)
        finally:
            os.unlink(probe)
    big_enough = info.file_size >= min_bytes
    # 读不出尺寸的格式（webp 等）只按体积判断，别因为读不到尺寸就整批漏掉
    sized = (width >= IMAGE_MIN_WIDTH and height >= IMAGE_MIN_HEIGHT) if width and height else big_enough
    return {
        "path": name,
        "bytes": info.file_size,
        "width": width,
        "height": height,
        "sha1": digest,
        "slides": [],
        "needsOcr": bool(big_enough and sized)
    }


def collect_zip_images(ocr_paddle, archive, min_bytes=IMAGE_MIN_BYTES):
    names = sorted(name for name in archive.namelist()
                   if name.startswith("ppt/media/") or name.startswith("word/media/")
                   or name.startswith("xl/media/"))
    entries = {}
    for name in names:
        try:
            entries[name] = image_entry(ocr_paddle, archive, name, min_bytes)
        except (KeyError, OSError):
            continue
    return entries


def slide_media_paths(archive, slide_name):
    """这张幻灯片按顺序引用了哪些图片（走 rels，不猜文件名）。"""
    rels_name = "ppt/slides/_rels/%s.rels" % os.path.basename(slide_name)
    if rels_name not in archive.namelist():
        return []
    targets = {}
    for node in ET.fromstring(archive.read(rels_name)):
        if node.get("Type", "").endswith("/image"):
            target = node.get("Target", "")
            targets[node.get("Id")] = os.path.normpath(os.path.join("ppt/slides", target)).replace(os.sep, "/")
    ordered = []
    root = ET.fromstring(archive.read(slide_name))
    for node in root.iter():
        rid = node.get(R + "embed") or node.get(R + "link")
        if rid and rid in targets:
            ordered.append(targets[rid])
    return ordered


# ── 识别：只把"要用的那几张"送去 API ──────────────────────────────────────

def needs_token(ocr_paddle):
    if ocr_paddle is None:
        return "没有 ocr_paddle 模块"
    if not os.environ.get("PADDLEOCR_ACCESS_TOKEN", "").strip():
        return "没有 PADDLEOCR_ACCESS_TOKEN"
    return ""


def ocr_zip_images(ocr_paddle, archive, entries, wanted, options, prefix="slide"):
    """识别一批内嵌图片，返回 {zip 路径: 文字} 与过程记录。"""
    paths = list(dict.fromkeys(wanted))
    if not paths:
        return {}, {"attempted": 0, "errors": []}
    temp_dir = tempfile.mkdtemp(prefix="course-media-")
    files = []
    for index, name in enumerate(paths):
        suffix = os.path.splitext(name)[1] or ".png"
        target = os.path.join(temp_dir, "%s-%03d%s" % (prefix, index, suffix))
        with open(target, "wb") as handle:
            handle.write(archive.read(name))
        files.append(target)
    try:
        outcome = ocr_paddle.ocr_images(files, os.environ["PADDLEOCR_ACCESS_TOKEN"].strip(),
                                        concurrency=options.ocr_concurrency, timeout=options.ocr_timeout)
    finally:
        shutil.rmtree(temp_dir, ignore_errors=True)
    texts = {}
    for index, name in enumerate(paths):
        texts[name] = outcome["texts"][index]
    return texts, {"attempted": len(paths), "errors": outcome["errors"]}


def merge_text(text, blocks):
    """把识别出来的文字并进这一页：原文在前，图片文字在后，并标出来源。"""
    parts = [text.strip()] if text.strip() else []
    for block in blocks:
        block = (block or "").strip()
        if block:
            parts.append(OCR_MARKER + "\n" + block)
    return "\n".join(parts)


# ── 各格式 ────────────────────────────────────────────────────────────────

def extract_pptx(path, options=None):
    options = options or Options()
    ocr_paddle = load_ocr()
    with zipfile.ZipFile(path) as archive:
        names = [name for name in archive.namelist() if SLIDE_RE.search(name)]
        entries = collect_zip_images(ocr_paddle, archive, options.ocr_min_bytes)
        slides = []
        used = {}
        for name in sorted(names, key=slide_number):
            root = ET.fromstring(archive.read(name))
            lines = [paragraph_text(p, f"{A}t") for p in root.iter(f"{A}p")]
            lines = [line for line in lines if line]
            number = slide_number(name)
            media_paths = [media for media in slide_media_paths(archive, name) if media in entries]
            for media in media_paths:
                entries[media]["slides"].append(number)
            used[number] = media_paths
            slides.append({"slideNumber": number, "text": "\n".join(lines)})

        wanted = [name for name, entry in entries.items() if entry["needsOcr"]]
        report = {"pending": len(wanted), "attempted": 0, "errors": [], "engine": ""}
        if options.ocr and wanted:
            blocker = needs_token(ocr_paddle)
            if blocker:
                report["errors"] = [{"path": "", "error": blocker}]
            else:
                selected = wanted[:max(0, options.ocr_max_pages)]
                texts, outcome = ocr_zip_images(ocr_paddle, archive, entries, selected, options)
                report.update(outcome)
                report["engine"] = ocr_paddle.MODEL
                report["skipped"] = len(wanted) - len(selected)
                for slide in slides:
                    blocks = [texts[media] for media in used.get(slide["slideNumber"], []) if media in texts]
                    if blocks:
                        slide["text"] = merge_text(slide["text"], blocks)
                # 还剩几张没识别（超过单份上限时），如实记下来，别假装做完了
                report["pending"] = max(0, len(wanted) - len(selected))

        done = {name for name, entry in entries.items() if entry["needsOcr"]} if report["attempted"] else set()
        inventory = list(entries.values())
    return {
        "slideCount": len(slides),
        "slides": slides,
        "images": inventory,
        "ocr": report,
        "ocrDone": sorted(done)
    }


def extract_docx(path, options=None):
    options = options or Options()
    ocr_paddle = load_ocr()
    with zipfile.ZipFile(path) as archive:
        root = ET.fromstring(archive.read("word/document.xml"))
        entries = collect_zip_images(ocr_paddle, archive, options.ocr_min_bytes)
        paragraphs = [paragraph_text(p, f"{W}t") for p in root.iter(f"{W}p")]
        paragraphs = [text for text in paragraphs if text]
        slides = []
        for start in range(0, len(paragraphs), DOCX_CHUNK_PARAGRAPHS):
            chunk = paragraphs[start:start + DOCX_CHUNK_PARAGRAPHS]
            slides.append({"slideNumber": len(slides) + 1, "text": "\n".join(chunk)})
        report, extra = ocr_attached(ocr_paddle, archive, entries, options, "docx-media")
        if extra:
            slides.append({"slideNumber": len(slides) + 1, "text": extra})
        inventory = list(entries.values())
    return {"slideCount": len(slides), "slides": slides, "images": inventory, "ocr": report}


def extract_xlsx(path, options=None):
    options = options or Options()
    ocr_paddle = load_ocr()
    with zipfile.ZipFile(path) as archive:
        names = archive.namelist()
        shared = []
        if "xl/sharedStrings.xml" in names:
            root = ET.fromstring(archive.read("xl/sharedStrings.xml"))
            for item in root.iter(f"{S}si"):
                shared.append("".join(node.text or "" for node in item.iter(f"{S}t")).strip())
        sheets = [name for name in names if re.match(r"xl/worksheets/sheet\d+\.xml$", name)]
        entries = collect_zip_images(ocr_paddle, archive, options.ocr_min_bytes)
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
        report, extra = ocr_attached(ocr_paddle, archive, entries, options, "xlsx-media")
        if extra:
            slides.append({"slideNumber": len(slides) + 1, "text": extra})
        inventory = list(entries.values())
    return {"slideCount": len(slides), "slides": slides, "images": inventory, "ocr": report}


def ocr_attached(ocr_paddle, archive, entries, options, prefix):
    """docx / xlsx 里图片没有可靠的页映射：识别完作为单独一页附在末尾。"""
    wanted = [name for name, entry in entries.items() if entry["needsOcr"]]
    report = {"pending": len(wanted), "attempted": 0, "errors": [], "engine": ""}
    if not options.ocr or not wanted:
        return report, ""
    blocker = needs_token(ocr_paddle)
    if blocker:
        report["errors"] = [{"path": "", "error": blocker}]
        return report, ""
    selected = wanted[:max(0, options.ocr_max_pages)]
    texts, outcome = ocr_zip_images(ocr_paddle, archive, entries, selected, options, prefix=prefix)
    report.update(outcome)
    report["engine"] = ocr_paddle.MODEL
    report["pending"] = max(0, len(wanted) - len(selected))
    blocks = [texts[name] for name in selected if texts.get(name)]
    return report, merge_text("", blocks)


def extract_pdf(path, options=None):
    options = options or Options()
    ocr_paddle = load_ocr()
    binary = shutil.which("pdftotext")
    if not binary:
        raise RuntimeError("系统里没有 pdftotext（apt-get install poppler-utils）")
    # -layout 保留版面（表格不至于糊成一团）；pdftotext 用换页符分页
    result = subprocess.run([binary, "-layout", path, "-"], capture_output=True, timeout=180)
    if result.returncode != 0:
        raise RuntimeError(f"pdftotext 退出码 {result.returncode}：{result.stderr.decode('utf-8', 'ignore')[:200]}")
    pages = result.stdout.decode("utf-8", "ignore").split("\f")
    slides = []
    for index, text in enumerate(pages, start=1):
        cleaned = "\n".join(line.rstrip() for line in text.splitlines()).strip()
        slides.append({"slideNumber": index, "text": cleaned})
    while slides and not slides[-1]["text"]:
        slides.pop()

    # 抽不出字的页就是"图片页"：整份都抽不出（扫描件）就整份送识别，只有零星几页就渲染那几页
    image_pages = [slide["slideNumber"] for slide in slides if len(slide["text"]) < PDF_MIN_TEXT]
    report = {"pending": len(image_pages), "attempted": 0, "errors": [], "engine": ""}
    if options.ocr and image_pages:
        blocker = needs_token(ocr_paddle)
        if blocker:
            report["errors"] = [{"path": "", "error": blocker}]
        else:
            try:
                texts = ocr_pdf_pages(ocr_paddle, path, slides, image_pages, options)
                report["engine"] = ocr_paddle.MODEL
                report["attempted"] = len(texts)
                by_number = {slide["slideNumber"]: slide for slide in slides}
                for number, text in texts.items():
                    if number in by_number:
                        by_number[number]["text"] = merge_text(by_number[number]["text"], [text])
                report["pending"] = max(0, len(image_pages) - len(texts))
            except ocr_paddle.OcrError as error:
                report["errors"] = [{"path": os.path.basename(path), "error": str(error)}]
    return {"slideCount": len(slides), "slides": slides, "images": [], "ocr": report}


def ocr_pdf_pages(ocr_paddle, path, slides, image_pages, options):
    """图片页的识别：整份扫描件直接送 PDF（版面与阅读顺序都在），零星的渲染成图再送。"""
    page_count = len(slides)
    budget = max(1, options.ocr_max_pages)
    if len(image_pages) >= max(1, int(page_count * 0.8)) and page_count <= budget:
        outcome = ocr_paddle.ocr_file(path, os.environ["PADDLEOCR_ACCESS_TOKEN"].strip(),
                                      timeout=options.ocr_timeout)
        return {index + 1: text for index, text in enumerate(outcome["pages"])}
    wanted = image_pages[:budget]
    ranges = []
    for number in wanted:
        if ranges and ranges[-1][1] == number - 1:
            ranges[-1][1] = number
        else:
            ranges.append([number, number])
    texts = {}
    for first, last in ranges:
        directory = tempfile.mkdtemp(prefix="course-ocr-")
        try:
            images = ocr_paddle.render_pdf_pages(path, first, last, out_dir=directory)
            outcome = ocr_paddle.ocr_images(images, os.environ["PADDLEOCR_ACCESS_TOKEN"].strip(),
                                            concurrency=options.ocr_concurrency, timeout=options.ocr_timeout)
            for offset, text in enumerate(outcome["texts"]):
                texts[first + offset] = text
        finally:
            shutil.rmtree(directory, ignore_errors=True)
    return texts


def extract_image(path, options=None):
    options = options or Options()
    ocr_paddle = load_ocr()
    text = ""
    report = {"pending": 1, "attempted": 0, "errors": [], "engine": ""}
    if options.ocr:
        blocker = needs_token(ocr_paddle)
        if blocker:
            report["errors"] = [{"path": os.path.basename(path), "error": blocker}]
        else:
            outcome = ocr_paddle.ocr_file(path, os.environ["PADDLEOCR_ACCESS_TOKEN"].strip(),
                                          timeout=options.ocr_timeout)
            text = merge_text("", ["\n".join(page for page in outcome["pages"] if page)])
            report.update({"pending": 0, "attempted": 1, "engine": ocr_paddle.MODEL})
    slides = [{"slideNumber": 1, "text": text}] if text else []
    return {"slideCount": len(slides), "slides": slides, "images": [], "ocr": report}


def extract_text(path, options=None):
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


def extract_json(path, options=None):
    with open(path, encoding="utf-8") as handle:
        data = json.load(handle)
    slides = data.get("slides") or []
    return {"slideCount": len(slides), "slides": slides}


class Options:
    """识别相关的开关。默认全关：入库要秒回，识别单独一步走。"""

    def __init__(self, ocr=False, ocr_max_pages=60, ocr_concurrency=3,
                 ocr_timeout=900, ocr_min_bytes=IMAGE_MIN_BYTES):
        self.ocr = ocr
        self.ocr_max_pages = ocr_max_pages
        self.ocr_concurrency = ocr_concurrency
        self.ocr_timeout = ocr_timeout
        self.ocr_min_bytes = ocr_min_bytes


HANDLERS = {
    ".pptx": extract_pptx,
    ".docx": extract_docx,
    ".xlsx": extract_xlsx,
    ".pdf": extract_pdf,
    ".json": extract_json,
    ".txt": extract_text,
    ".md": extract_text,
}
for _suffix in IMAGE_SUFFIXES:
    HANDLERS[_suffix] = extract_image


def main(argv):
    parser = argparse.ArgumentParser(description="把课件抽成每页文字")
    parser.add_argument("path", help="课件文件")
    parser.add_argument("--ocr", action="store_true",
                        help="识别图片里的文字（需要 PADDLEOCR_ACCESS_TOKEN；一张图几秒到几十秒）")
    parser.add_argument("--ocr-max-pages", type=int, default=60, help="单份课件最多识别多少张图")
    parser.add_argument("--ocr-concurrency", type=int, default=3)
    parser.add_argument("--ocr-timeout", type=int, default=900, help="单张图/单个任务的等待上限（秒）")
    parser.add_argument("--ocr-min-bytes", type=int, default=IMAGE_MIN_BYTES,
                        help="小于这个体积的图不当成内容（图标、装饰）")
    options = parser.parse_args(argv[1:])

    path = options.path
    extension = os.path.splitext(path)[1].lower()
    handler = HANDLERS.get(extension)
    if handler is None:
        print(f"不支持的课件格式：{extension or '（无扩展名）'}"
              f"（支持 pptx / pdf / docx / xlsx / 图片 / txt / md）", file=sys.stderr)
        return 3
    try:
        result = handler(path, options)
    except (zipfile.BadZipFile, ET.ParseError) as error:
        print(f"解析失败：{error}", file=sys.stderr)
        return 1
    except RuntimeError as error:
        print(f"解析失败：{error}", file=sys.stderr)
        return 1
    except subprocess.TimeoutExpired:
        print("解析失败：PDF 太大或损坏，超时", file=sys.stderr)
        return 1
    except Exception as error:  # OCR 侧的任何意外都不该让课件入不了库
        ocr_paddle = load_ocr()
        if ocr_paddle is not None and isinstance(error, ocr_paddle.OcrError):
            print(f"图片 OCR 失败：{error}", file=sys.stderr)
            result = {"slideCount": 0, "slides": [], "images": [],
                      "ocr": {"pending": 0, "attempted": 0, "engine": "", "errors": [{"path": "", "error": str(error)}]}}
            print(json.dumps(result, ensure_ascii=False))
            return 0
        raise
    print(json.dumps(result, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))