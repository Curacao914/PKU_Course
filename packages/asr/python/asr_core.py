#!/usr/bin/env python3
"""Paraformer-v2 转录核心。

从 my-blog-main 的 scripts/course-worker/python/asr_core.py 摘出，只保留
headless worker 实际使用的部分：网络重试、R2 预签名探测、分片转录、句子抽取、
脱敏与错误摘要。

已剥离（原文件的交互式遗留 CLI）：main()、configure_secrets()、
maybe_import_previous_env()、previous_v004_dirs()、load_env_file()、
find_recent_files()、choose_one()、choose_materials()、extract_material()、
write_materials()、maybe_import_previous_output()、write_transcript()。

由此不再依赖 python-pptx / pypdf / python-docx，也不再在 import 时求值任何
本地路径常量（原实现把 ROOT/LOG_DIR/OUTPUT_ROOT 等写死在模块级）。
"""
from __future__ import annotations

import json
import re
import socket
import ssl
import subprocess
import time
import uuid
from datetime import datetime, timezone
from pathlib import Path
from typing import Any
from urllib import error, request


DASHSCOPE_SUBMIT = "https://dashscope.aliyuncs.com/api/v1/services/audio/asr/transcription"
DASHSCOPE_TASK = "https://dashscope.aliyuncs.com/api/v1/tasks/"
MODEL = "paraformer-v2"
PRICE_PER_HOUR_CNY = 0.288
HOME = str(Path.home())
RETRYABLE_HTTP = {408, 425, 429, 500, 502, 503, 504}
URL_RE = re.compile(r"https?://[^\s'\"<>]+", re.IGNORECASE)
JWT_RE = re.compile(r"eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}(?:\.[A-Za-z0-9_-]{10,})?")


def sanitize_text(text: str) -> str:
    value = text or ""
    value = value.replace(HOME, "<HOME>")
    value = URL_RE.sub("<REDACTED_URL>", value)
    value = JWT_RE.sub("<REDACTED_JWT>", value)
    value = re.sub(
        r"(?i)(api[_-]?key|secret[_-]?access[_-]?key|access[_-]?key[_-]?id)\s*[:=]\s*[^\s,}]+",
        r"\1=<REDACTED>",
        value,
    )
    value = re.sub(r"(?i)(authorization\s*:\s*bearer\s+)[^\s]+", r"\1<REDACTED>", value)
    return value


def sanitize_json(value: Any) -> Any:
    if isinstance(value, dict):
        clean: dict[str, Any] = {}
        for key, item in value.items():
            lowered = str(key).lower()
            if lowered in {
                "file_url", "file_urls", "transcription_url", "url",
                "authorization", "api_key", "secret_access_key", "access_key_id",
                "task_id",
            }:
                clean[key] = "<REDACTED_URL>" if "url" in lowered else "<REDACTED>"
            else:
                clean[key] = sanitize_json(item)
        return clean
    if isinstance(value, list):
        return [sanitize_json(item) for item in value]
    if isinstance(value, str):
        return sanitize_text(value)
    return value


def safe_slug(value: str) -> str:
    value = re.sub(r"\s+", "-", value.strip())
    value = re.sub(r"[^\w\u4e00-\u9fff-]+", "-", value)
    return re.sub(r"-{2,}", "-", value).strip("-")[:100] or "lesson"


def format_timestamp(milliseconds: int) -> str:
    total = max(0, int(milliseconds // 1000))
    hours, remainder = divmod(total, 3600)
    minutes, seconds = divmod(remainder, 60)
    return f"{hours:02d}:{minutes:02d}:{seconds:02d}"


def is_retryable_exception(exc: BaseException) -> bool:
    if isinstance(exc, error.HTTPError):
        return exc.code in RETRYABLE_HTTP
    return isinstance(exc, (
        error.URLError, ssl.SSLError, socket.timeout, TimeoutError,
        ConnectionResetError, ConnectionAbortedError, BrokenPipeError,
    ))


def urlopen_json(req: request.Request, timeout: int = 90, attempts: int = 6, log=None) -> dict[str, Any]:
    last_error: BaseException | None = None
    for attempt in range(1, attempts + 1):
        try:
            with request.urlopen(req, timeout=timeout) as response:
                return json.loads(response.read().decode("utf-8"))
        except error.HTTPError as exc:
            body = exc.read().decode("utf-8", errors="replace")
            last_error = RuntimeError(f"HTTP {exc.code}: {sanitize_text(body)}")
            retryable = exc.code in RETRYABLE_HTTP
        except BaseException as exc:
            last_error = exc
            retryable = is_retryable_exception(exc)
        if not retryable or attempt == attempts:
            break
        wait = min(30, 2 ** (attempt - 1))
        if log:
            log(f"NETWORK_RETRY attempt={attempt} wait={wait}s error={last_error}")
        print(f"      网络连接短暂中断，{wait} 秒后重试（{attempt}/{attempts}）")
        time.sleep(wait)
    raise RuntimeError("网络请求失败：" + sanitize_text(str(last_error))) from last_error


def post_json(url: str, payload: dict[str, Any], headers: dict[str, str], log=None) -> dict[str, Any]:
    return urlopen_json(request.Request(
        url,
        data=json.dumps(payload, ensure_ascii=False).encode("utf-8"),
        headers=headers,
        method="POST",
    ), log=log)


def get_json(url: str, headers: dict[str, str] | None = None, log=None) -> dict[str, Any]:
    return urlopen_json(request.Request(url, headers=headers or {}, method="GET"), log=log)


def run_command(args: list[str], timeout: int, log) -> subprocess.CompletedProcess[str]:
    safe = [
        "<REDACTED_LOCAL_PATH>" if item.startswith(HOME) else
        "<REDACTED_URL>" if item.startswith(("http://", "https://")) else item
        for item in args
    ]
    log("RUN " + " ".join(safe))
    started = time.monotonic()
    result = subprocess.run(
        args, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
        text=True, timeout=timeout, check=False,
    )
    log(f"EXIT {result.returncode} in {time.monotonic() - started:.2f}s")
    if result.stderr:
        log("STDERR " + sanitize_text(result.stderr[-4000:]))
    return result


def ffprobe_duration(source: Path, log) -> float:
    result = run_command([
        "ffprobe", "-v", "error", "-show_entries", "format=duration",
        "-of", "default=noprint_wrappers=1:nokey=1", str(source)
    ], 120, log)
    if result.returncode != 0:
        raise RuntimeError("ffprobe 无法读取课程视频")
    return float(result.stdout.strip())


def test_presigned_url(url: str, log) -> None:
    last: BaseException | None = None
    for attempt in range(1, 5):
        try:
            req = request.Request(url, method="GET", headers={"Range": "bytes=0-1023"})
            with request.urlopen(req, timeout=30) as response:
                if getattr(response, "status", 200) not in (200, 206):
                    raise RuntimeError("签名 URL 状态异常")
                response.read(1024)
                return
        except BaseException as exc:
            last = exc
            if attempt == 4 or not is_retryable_exception(exc):
                break
            wait = 2 ** (attempt - 1)
            log(f"PRESIGNED_RETRY attempt={attempt} error={exc}")
            time.sleep(wait)
    raise RuntimeError("R2 签名地址测试失败：" + sanitize_text(str(last)))


def extract_sentences(result: dict[str, Any], offset_ms: int) -> tuple[list[dict[str, Any]], int, int]:
    sentences: list[dict[str, Any]] = []
    original_ms = int((result.get("properties") or {}).get("original_duration_in_milliseconds") or 0)
    speech_ms = 0
    for transcript in result.get("transcripts") or []:
        speech_ms += int(transcript.get("content_duration_in_milliseconds") or 0)
        for sentence in transcript.get("sentences") or []:
            text = str(sentence.get("text") or "").strip()
            if text:
                sentences.append({
                    "begin_time": int(sentence.get("begin_time") or 0) + offset_ms,
                    "end_time": int(sentence.get("end_time") or 0) + offset_ms,
                    "text": text,
                })
    return sentences, original_ms, speech_ms


def task_failure_summary(task_response: dict[str, Any]) -> str:
    output = task_response.get("output") or {}
    parts: list[str] = []
    for key in ("code", "message", "task_status"):
        value = output.get(key)
        if value:
            parts.append(f"{key}={value}")
    for item in output.get("results") or []:
        for key in ("subtask_status", "code", "message"):
            value = item.get(key)
            if value:
                parts.append(f"{key}={value}")
    return "; ".join(dict.fromkeys(parts)) or "未返回具体失败原因"


def safe_delete_r2_object(s3, bucket: str, object_key: str, chunk_index: int, log) -> None:
    try:
        s3.delete_object(Bucket=bucket, Key=object_key)
        log(f"CHUNK {chunk_index} CLEANUP r2_object_deleted=true")
    except Exception as exc:
        log(f"CHUNK {chunk_index} CLEANUP r2_object_deleted=false {exc}")
        raise RuntimeError(f"第 {chunk_index} 段 R2 临时对象删除失败") from exc


def transcribe_chunk(
    source: Path, chunk_index: int, start_seconds: float, duration_seconds: float,
    checkpoint_path: Path, task_path: Path, temp_dir: Path,
    config: dict[str, str], s3, bucket: str, log,
) -> dict[str, Any]:
    if checkpoint_path.exists():
        return json.loads(checkpoint_path.read_text(encoding="utf-8"))

    failure_path = checkpoint_path.with_suffix(".failure.json")
    task_state: dict[str, Any] | None = None

    if task_path.exists():
        loaded = json.loads(task_path.read_text(encoding="utf-8"))
        # R2 task files did not retain the R2 object key and are therefore not resumable.
        if loaded.get("object_key"):
            task_state = loaded
            print(f"   发现第 {chunk_index} 段已提交任务，继续轮询 …{task_state['task_id'][-8:]}")
        else:
            stale_path = task_path.with_suffix(".stale-r2.json")
            task_path.replace(stale_path)
            print(f"   发现旧版不可恢复任务状态，已归档并重新提交第 {chunk_index} 段")

    if task_state is None:
        audio_path = temp_dir / f"chunk-{chunk_index:03d}.mp3"
        object_key = f"course-pipeline-temp/{uuid.uuid4().hex}.mp3"
        uploaded = False
        try:
            result = run_command([
                "ffmpeg", "-nostdin", "-hide_banner", "-loglevel", "error",
                "-ss", f"{start_seconds:.3f}", "-i", str(source),
                "-t", f"{duration_seconds:.3f}", "-vn", "-ac", "1", "-ar", "16000",
                "-c:a", "libmp3lame", "-b:a", "48k", "-y", str(audio_path),
            ], 900, log)
            if result.returncode != 0 or not audio_path.exists() or audio_path.stat().st_size == 0:
                raise RuntimeError(f"第 {chunk_index} 段音频提取失败")

            s3.upload_file(
                str(audio_path),
                bucket,
                object_key,
                ExtraArgs={"ContentType": "audio/mpeg"},
            )
            uploaded = True
            signed_url = s3.generate_presigned_url(
                "get_object",
                Params={"Bucket": bucket, "Key": object_key},
                ExpiresIn=21600,
            )
            test_presigned_url(signed_url, log)

            submitted = post_json(
                DASHSCOPE_SUBMIT,
                {
                    "model": MODEL,
                    "input": {"file_urls": [signed_url]},
                    "parameters": {
                        "channel_id": [0],
                        "language_hints": ["zh", "en"],
                        "disfluency_removal_enabled": False,
                        "timestamp_alignment_enabled": False,
                        "diarization_enabled": False,
                        "special_word_filter": json.dumps({
                            "filter_with_signed": {"word_list": []},
                            "filter_with_empty": {"word_list": []},
                            "system_reserved_filter": False,
                        }, ensure_ascii=False),
                    },
                },
                {
                    "Authorization": f"Bearer {config['DASHSCOPE_API_KEY']}",
                    "Content-Type": "application/json",
                    "X-DashScope-Async": "enable",
                },
                log=log,
            )
            task_id = str((submitted.get("output") or {}).get("task_id") or "")
            if not task_id:
                raise RuntimeError("提交响应没有 task_id")

            # Persist both task id and R2 object key before polling. The object must remain
            # available until DashScope has downloaded and completed the task.
            task_state = {
                "schemaVersion": 2,
                "task_id": task_id,
                "object_key": object_key,
                "bucket": bucket,
                "chunkIndex": chunk_index,
                "startSeconds": start_seconds,
                "durationSecondsRequested": duration_seconds,
                "submittedAt": datetime.now(timezone.utc).isoformat(),
                "signedUrlExpiresSeconds": 21600,
            }
            task_path.write_text(
                json.dumps(task_state, ensure_ascii=False, indent=2) + "\n",
                encoding="utf-8",
            )
            print(f"   第 {chunk_index} 段任务 …{task_id[-8:]} 已提交；临时音频将保留到任务结束")
        except Exception:
            # If submission did not persist a resumable task, clean any uploaded object.
            if uploaded and task_state is None:
                safe_delete_r2_object(s3, bucket, object_key, chunk_index, log)
            raise
        finally:
            if audio_path.exists():
                audio_path.unlink()
                log(f"CHUNK {chunk_index} CLEANUP local_audio_deleted=true")

    assert task_state is not None
    task_id = task_state["task_id"]
    object_key = task_state["object_key"]
    task_bucket = task_state.get("bucket") or bucket
    headers = {
        "Authorization": f"Bearer {config['DASHSCOPE_API_KEY']}",
        "Content-Type": "application/json",
    }

    deadline = time.monotonic() + 40 * 60
    last_status = None
    task_response: dict[str, Any] | None = None

    try:
        while time.monotonic() < deadline:
            time.sleep(4)
            task_response = urlopen_json(
                request.Request(
                    DASHSCOPE_TASK + task_id,
                    headers=headers,
                    data=b"",
                    method="POST",
                ),
                log=log,
            )
            status = str(
                ((task_response.get("output") or {}).get("task_status")) or "UNKNOWN"
            ).upper()
            if status != last_status:
                print(f"      状态：{status}")
                log(f"CHUNK {chunk_index} TASK_STATUS {status}")
                last_status = status

            if status == "SUCCEEDED":
                break

            if status == "FAILED":
                detail = task_failure_summary(task_response)
                failure_payload = {
                    "chunkIndex": chunk_index,
                    "taskIdSuffix": task_id[-8:],
                    "failedAt": datetime.now(timezone.utc).isoformat(),
                    "detail": sanitize_text(detail),
                    "response": sanitize_json(task_response),
                }
                failure_path.write_text(
                    json.dumps(failure_payload, ensure_ascii=False, indent=2) + "\n",
                    encoding="utf-8",
                )
                safe_delete_r2_object(s3, task_bucket, object_key, chunk_index, log)
                task_path.unlink(missing_ok=True)
                raise RuntimeError(f"第 {chunk_index} 段任务失败：{sanitize_text(detail)}")

            if status not in {"PENDING", "RUNNING"}:
                raise RuntimeError(
                    f"第 {chunk_index} 段出现未知任务状态 {status}；task 状态已保留"
                )
        else:
            raise RuntimeError(
                f"第 {chunk_index} 段等待超过 40 分钟；task 与 R2 对象均已保留，可重跑"
            )

        results = ((task_response or {}).get("output") or {}).get("results") or []
        successful = [
            item for item in results if item.get("subtask_status") == "SUCCEEDED"
        ]
        if not successful or not successful[0].get("transcription_url"):
            raise RuntimeError(
                f"第 {chunk_index} 段任务成功但没有可下载结果；task 状态已保留"
            )

        result = get_json(successful[0]["transcription_url"], log=log)
        sentences, original_ms, speech_ms = extract_sentences(
            result,
            int(start_seconds * 1000),
        )
        checkpoint = {
            "chunkIndex": chunk_index,
            "startSeconds": start_seconds,
            "durationSecondsRequested": duration_seconds,
            "taskIdSuffix": task_id[-8:],
            "originalDurationMilliseconds": original_ms,
            "speechDurationMilliseconds": speech_ms,
            "sentences": sentences,
        }
        checkpoint_path.write_text(
            json.dumps(checkpoint, ensure_ascii=False, indent=2) + "\n",
            encoding="utf-8",
        )

        safe_delete_r2_object(s3, task_bucket, object_key, chunk_index, log)
        task_path.unlink(missing_ok=True)
        failure_path.unlink(missing_ok=True)
        return checkpoint

    except KeyboardInterrupt:
        print(
            f"\n已中断；第 {chunk_index} 段 task 和 R2 临时对象仍保留，"
            "下次运行会继续，不会重新提交。"
        )
        raise

