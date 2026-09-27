#!/usr/bin/env python3
"""PaddleOCR-VL 异步接口：把图片 / PDF 里"抽不出文字"的内容识别出来。

为什么单独一个模块：课件里有一类是"用图片做的"——整页就是一张图，或者正文之外
夹着截图、图表、扫描件。XML 里根本没有这些文字，pdftotext 也抽不到，笔记就缺一块。
这里把这些页送去 PaddleOCR-VL 识别，再把文字填回课件文本。

只用标准库。服务器可用内存只有 1.2G，这条链路要长期无人值守地跑，
不引入 requests / pillow 之类的依赖：multipart 自己拼，轮询自己写。

用法：
  python3 ocr_paddle.py <图片|PDF> [--pages 3-8] [--max-pages 200] [--concurrency 3]
输出（stdout，一行 JSON）：
  {"engine": "PaddleOCR-VL-1.5", "pages": [{"index": 1, "markdown": "..."}], "seconds": 12.3}

令牌：环境变量 PADDLEOCR_ACCESS_TOKEN；没有令牌时以退出码 4 结束并说明原因
（课件照常入库，只是没有图片文字——OCR 是补全，不是前置条件）。
"""
import argparse
import hashlib
import json
import os
import shutil
import subprocess
import sys
import tempfile
import threading
import time
import urllib.error
import urllib.request
import uuid

DEFAULT_JOB_URL = "https://paddleocr.aistudio-app.com/api/v2/ocr/jobs"
# 模型名必须与官方当前版本一致：写错的名字提交会成功、任务却一直 pending（不报错，最难查）
MODEL = os.environ.get("PADDLEOCR_MODEL") or "PaddleOCR-VL-1.6"
POLL_SECONDS = 3
EXIT_NO_TOKEN = 4
IMAGE_SUFFIXES = (".png", ".jpg", ".jpeg", ".bmp", ".webp", ".tif", ".tiff", ".gif")

# 系统代理会让上传走到错误的出口；服务器上也不需要代理，直接绕开。
OPENER = urllib.request.build_opener(urllib.request.ProxyHandler({}))


class OcrError(RuntimeError):
    pass


# ── HTTP：multipart 自己拼，不依赖 requests ────────────────────────────────

def _multipart(fields, files):
    boundary = "----course" + uuid.uuid4().hex
    body = bytearray()
    for name, value in fields.items():
        body += ("--%s\r\nContent-Disposition: form-data; name=\"%s\"\r\n\r\n%s\r\n"
                 % (boundary, name, value)).encode("utf-8")
    for name, path in files.items():
        with open(path, "rb") as handle:
            payload = handle.read()
        body += ("--%s\r\nContent-Disposition: form-data; name=\"%s\"; filename=\"%s\"\r\n"
                 "Content-Type: application/octet-stream\r\n\r\n"
                 % (boundary, name, os.path.basename(path))).encode("utf-8")
        body += payload + b"\r\n"
    body += ("--%s--\r\n" % boundary).encode("utf-8")
    return boundary, bytes(body)


def _request(request, timeout):
    try:
        with OPENER.open(request, timeout=timeout) as response:
            return json.loads(response.read().decode("utf-8"))
    except urllib.error.HTTPError as error:
        detail = error.read().decode("utf-8", "ignore")[:200]
        if error.code in (401, 403):
            raise OcrError("PaddleOCR 令牌无效或已过期（HTTP %s）" % error.code)
        raise OcrError("PaddleOCR 接口返回 HTTP %s：%s" % (error.code, detail))
    except urllib.error.URLError as error:
        raise OcrError("连不上 PaddleOCR：%s" % error.reason)


def submit(path, token, job_url=DEFAULT_JOB_URL, timeout=300):
    fields = {
        "model": MODEL,
        "optionalPayload": json.dumps({
            "useDocOrientationClassify": False,
            "useDocUnwarping": False,
            "useChartRecognition": False
        })
    }
    boundary, body = _multipart(fields, {"file": path})
    request = urllib.request.Request(job_url, data=body, method="POST")
    request.add_header("Authorization", "bearer " + token)
    request.add_header("Content-Type", "multipart/form-data; boundary=" + boundary)
    payload = _request(request, timeout)
    job_id = (payload.get("data") or {}).get("jobId")
    if not job_id:
        raise OcrError("提交任务没有拿到 jobId：%s" % json.dumps(payload, ensure_ascii=False)[:200])
    return job_id


def _status(job_id, token, job_url):
    request = urllib.request.Request("%s/%s" % (job_url, job_id))
    request.add_header("Authorization", "bearer " + token)
    return (_request(request, 60).get("data") or {})


def poll(job_id, token, job_url, timeout=900):
    """等任务完成，返回结果 JSONL 的地址。"""
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        data = _status(job_id, token, job_url)
        state = data.get("state")
        if state == "done":
            url = (data.get("resultUrl") or {}).get("jsonUrl")
            if not url:
                raise OcrError("任务完成但没有结果地址")
            return url
        if state == "failed":
            raise OcrError("任务失败：%s" % (data.get("errorMsg") or "原因未知"))
        time.sleep(POLL_SECONDS)
    raise OcrError("任务超时（%s 秒内没有完成）" % timeout)


def fetch_pages(json_url, limit=0):
    """下载结果 JSONL，按页取出 markdown 文本。"""
    request = urllib.request.Request(json_url)
    with OPENER.open(request, timeout=300) as response:
        text = response.read().decode("utf-8", "ignore")
    pages = []
    for line in text.strip().splitlines():
        line = line.strip()
        if not line:
            continue
        try:
            record = json.loads(line)
        except ValueError:
            continue
        for result in (record.get("result") or {}).get("layoutParsingResults", []):
            markdown = (result.get("markdown") or {}).get("text", "")
            pages.append(markdown.strip())
            if limit and len(pages) >= limit:
                return pages
    return pages


def ocr_file(path, token, job_url=DEFAULT_JOB_URL, timeout=900):
    """识别一份文件（图片或 PDF），返回每页文本。"""
    if not os.path.exists(path):
        raise OcrError("找不到文件：%s" % path)
    started = time.monotonic()
    job_id = submit(path, token, job_url)
    json_url = poll(job_id, token, job_url, timeout=timeout)
    pages = fetch_pages(json_url)
    return {"pages": pages, "seconds": round(time.monotonic() - started, 1), "jobId": job_id}


# ── 图片文件本身的信息：用来跳过图标、装饰线这类没有文字的图 ────────────────

def image_size(path):
    """不装 pillow 也能读图片尺寸：只解析文件头。读不出返回 (0, 0)。"""
    try:
        with open(path, "rb") as handle:
            head = handle.read(32)
            if head[:8] == b"\x89PNG\r\n\x1a\n":
                return int.from_bytes(head[16:20], "big"), int.from_bytes(head[20:24], "big")
            if head[:2] == b"\xff\xd8":
                handle.seek(2)
                while True:
                    marker = handle.read(2)
                    if len(marker) < 2 or marker[0] != 0xFF:
                        return (0, 0)
                    length = int.from_bytes(handle.read(2), "big")
                    if 0xC0 <= marker[1] <= 0xCF and marker[1] not in (0xC4, 0xC8, 0xCC):
                        data = handle.read(5)
                        return int.from_bytes(data[3:5], "big"), int.from_bytes(data[1:3], "big")
                    handle.seek(length - 2, os.SEEK_CUR)
            if head[:6] in (b"GIF87a", b"GIF89a"):
                return int.from_bytes(head[6:8], "little"), int.from_bytes(head[8:10], "little")
            if head[:2] == b"BM":
                return int.from_bytes(head[18:22], "little"), int.from_bytes(head[22:26], "little")
            if head[:4] == b"RIFF" and head[8:12] == b"WEBP":
                return (0, 0)
    except OSError:
        return (0, 0)
    return (0, 0)


def sha1_of_bytes(payload):
    return hashlib.sha1(payload).hexdigest()


def sha1_of(path):
    digest = hashlib.sha1()
    with open(path, "rb") as handle:
        for chunk in iter(lambda: handle.read(1 << 20), b""):
            digest.update(chunk)
    return digest.hexdigest()


def ocr_images(paths, token, job_url=DEFAULT_JOB_URL, concurrency=3, timeout=600, on_progress=None):
    """并发识别一批图片，按输入顺序返回文本。

    一张图一次任务：同一张图在几十页里重复出现时，调用方先去重，这里不管。
    """
    results = [""] * len(paths)
    errors = []
    lock = threading.Lock()
    queue = list(range(len(paths)))

    def worker():
        while True:
            with lock:
                if not queue:
                    return
                index = queue.pop(0)
            try:
                outcome = ocr_file(paths[index], token, job_url, timeout=timeout)
                results[index] = "\n".join(page for page in outcome["pages"] if page)
            except OcrError as error:
                with lock:
                    errors.append({"path": os.path.basename(paths[index]), "error": str(error)})
            if on_progress:
                on_progress()

    threads = [threading.Thread(target=worker, daemon=True)
               for _ in range(max(1, min(concurrency, len(paths))))]
    for thread in threads:
        thread.start()
    for thread in threads:
        thread.join()
    return {"texts": results, "errors": errors}


def render_pdf_pages(path, first, last, dpi=150, out_dir=None):
    """把 PDF 的某几页渲染成 PNG（图片版 PDF 只有渲染出来才认得出字）。"""
    binary = shutil.which("pdftoppm")
    if not binary:
        raise OcrError("系统里没有 pdftoppm（apt-get install poppler-utils）")
    target = out_dir or tempfile.mkdtemp(prefix="course-ocr-")
    prefix = os.path.join(target, "page")
    result = subprocess.run([binary, "-png", "-r", str(dpi), "-f", str(first), "-l", str(last), path, prefix],
                            capture_output=True, timeout=600)
    if result.returncode != 0:
        raise OcrError("pdftoppm 失败：%s" % result.stderr.decode("utf-8", "ignore")[:200])
    return sorted(os.path.join(target, name) for name in os.listdir(target) if name.endswith(".png"))


def parse_pages(spec, total=0):
    """把 "3-8" / "5" / "1-4,9" 解析成 [(3,8),(9,9)]。"""
    ranges = []
    for part in str(spec or "").replace("，", ",").split(","):
        part = part.strip()
        if not part:
            continue
        if "-" in part:
            left, _, right = part.partition("-")
            try:
                start, end = int(left), int(right)
            except ValueError:
                continue
        else:
            try:
                start = end = int(part)
            except ValueError:
                continue
        if start > end:
            start, end = end, start
        if total:
            start, end = max(1, start), min(total, end)
        if start <= end:
            ranges.append((start, end))
    return ranges


def main(argv):
    parser = argparse.ArgumentParser(description="PaddleOCR-VL 识别图片或 PDF")
    parser.add_argument("path", help="图片或 PDF 文件")
    parser.add_argument("--pages", default="", help="只识别这几页，例如 3-8 或 1,4,9（仅 PDF）")
    parser.add_argument("--max-pages", type=int, default=200, help="单次最多识别多少页（防跑飞）")
    parser.add_argument("--concurrency", type=int, default=3)
    parser.add_argument("--timeout", type=int, default=900, help="单个任务的等待上限（秒）")
    parser.add_argument("--job-url", default=os.environ.get("PADDLEOCR_DOC_PARSING_API_URL") or DEFAULT_JOB_URL)
    options = parser.parse_args(argv[1:])

    token = os.environ.get("PADDLEOCR_ACCESS_TOKEN", "").strip()
    if not token:
        print("没有 PADDLEOCR_ACCESS_TOKEN，跳过图片 OCR", file=sys.stderr)
        return EXIT_NO_TOKEN

    suffix = os.path.splitext(options.path)[1].lower()
    started = time.monotonic()
    try:
        if suffix == ".pdf":
            ranges = parse_pages(options.pages)
            if ranges:
                texts = []
                for first, last in ranges:
                    images = render_pdf_pages(options.path, first, last)
                    outcome = ocr_images(images[:max(0, options.max_pages - len(texts))], token,
                                         options.job_url, options.concurrency, options.timeout)
                    for offset, text in enumerate(outcome["texts"]):
                        texts.append({"index": first + offset, "markdown": text})
                payload = {"engine": MODEL, "pages": texts, "errors": outcome["errors"]}
            else:
                outcome = ocr_file(options.path, token, options.job_url, timeout=options.timeout)
                payload = {"engine": MODEL,
                           "pages": [{"index": index + 1, "markdown": text}
                                     for index, text in enumerate(outcome["pages"][:options.max_pages])],
                           "errors": []}
        elif suffix in IMAGE_SUFFIXES:
            outcome = ocr_file(options.path, token, options.job_url, timeout=options.timeout)
            payload = {"engine": MODEL,
                       "pages": [{"index": 1, "markdown": "\n".join(outcome["pages"])}],
                       "errors": []}
        else:
            print("不认识的格式：%s" % (suffix or "（无扩展名）"), file=sys.stderr)
            return 3
    except OcrError as error:
        print("图片 OCR 失败：%s" % error, file=sys.stderr)
        return 1

    payload["seconds"] = round(time.monotonic() - started, 1)
    print(json.dumps(payload, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
