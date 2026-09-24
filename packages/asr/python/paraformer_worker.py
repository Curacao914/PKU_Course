#!/usr/bin/env python3
from __future__ import annotations

import argparse
import hashlib
import json
import math
import os
from datetime import datetime, timezone
from pathlib import Path

import boto3
from botocore.config import Config

from asr_core import (
    MODEL,
    PRICE_PER_HOUR_CNY,
    ffprobe_duration,
    format_timestamp,
    transcribe_chunk,
)


def required_env(name: str) -> str:
    value = os.environ.get(name, "").strip()
    if not value:
        raise RuntimeError(f"{name} is required")
    return value


def file_sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def write_transcript(path: Path, title: str, sentences: list[dict]) -> str:
    lines = [f"# {title}", ""]
    for sentence in sentences:
        lines.extend([
            f"[{format_timestamp(sentence['begin_time'])} – "
            f"{format_timestamp(sentence['end_time'])}] {sentence['text']}",
            "",
        ])
    content = "\n".join(lines).rstrip() + "\n"
    path.write_text(content, encoding="utf-8")
    return content


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser()
    parser.add_argument("--source", required=True)
    parser.add_argument("--output-dir", required=True)
    parser.add_argument("--course", required=True)
    parser.add_argument("--lesson", required=True)
    parser.add_argument("--chunk-minutes", type=int, default=45)
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    source = Path(args.source).resolve()
    output_dir = Path(args.output_dir).resolve()
    output_dir.mkdir(parents=True, exist_ok=True)
    chunks_dir = output_dir / "chunks"
    chunks_dir.mkdir(exist_ok=True)
    temp_dir = output_dir / ".private"
    temp_dir.mkdir(exist_ok=True)
    log_path = output_dir / "asr.log"

    def log(message: str) -> None:
        with log_path.open("a", encoding="utf-8") as handle:
            handle.write(f"{datetime.now(timezone.utc).isoformat()} {message}\n")

    config = {
        "DASHSCOPE_API_KEY": required_env("DASHSCOPE_API_KEY"),
        "R2_ACCESS_KEY_ID": required_env("R2_ACCESS_KEY_ID"),
        "R2_SECRET_ACCESS_KEY": required_env("R2_SECRET_ACCESS_KEY"),
        "R2_ENDPOINT": required_env("R2_ENDPOINT"),
        "R2_BUCKET": required_env("R2_BUCKET"),
    }

    duration = ffprobe_duration(source, log)
    chunk_seconds = max(10 * 60, int(args.chunk_minutes) * 60)
    chunk_count = math.ceil(duration / chunk_seconds)
    s3 = boto3.client(
        "s3",
        endpoint_url=config["R2_ENDPOINT"],
        aws_access_key_id=config["R2_ACCESS_KEY_ID"],
        aws_secret_access_key=config["R2_SECRET_ACCESS_KEY"],
        region_name="auto",
        config=Config(signature_version="s3v4"),
    )

    checkpoints = []
    for zero in range(chunk_count):
        index = zero + 1
        start = zero * chunk_seconds
        length = min(chunk_seconds, duration - start)
        checkpoints.append(transcribe_chunk(
            source,
            index,
            start,
            length,
            chunks_dir / f"chunk-{index:03d}.json",
            chunks_dir / f"chunk-{index:03d}.task.json",
            temp_dir,
            config,
            s3,
            config["R2_BUCKET"],
            log,
        ))

    sentences = []
    speech_ms = 0
    for checkpoint in sorted(checkpoints, key=lambda item: item["chunkIndex"]):
        sentences.extend(checkpoint["sentences"])
        speech_ms += int(checkpoint.get("speechDurationMilliseconds") or 0)
    sentences.sort(key=lambda item: (item["begin_time"], item["end_time"]))

    transcript_path = output_dir / "raw-transcript.md"
    transcript = write_transcript(
        transcript_path,
        f"{args.course} · {args.lesson} · 原始课堂转录",
        sentences,
    )
    summary = {
        "schemaVersion": 1,
        "model": MODEL,
        "courseName": args.course,
        "lessonName": args.lesson,
        "videoDurationSeconds": round(duration, 3),
        "chunkCount": chunk_count,
        "sentenceCount": len(sentences),
        "characterCount": sum(len(item["text"]) for item in sentences),
        "transcriptCharacterCount": len(transcript),
        "speechDurationMilliseconds": speech_ms,
        "estimatedCostCnyBeforeFreeQuota": round(
            speech_ms / 3_600_000 * PRICE_PER_HOUR_CNY,
            6,
        ),
        "sourceChecksum": file_sha256(source),
        "transcriptChecksum": file_sha256(transcript_path),
        "transcriptFile": transcript_path.name,
        "finishedAt": datetime.now(timezone.utc).isoformat(),
    }
    (output_dir / "run-summary.json").write_text(
        json.dumps(summary, ensure_ascii=False, indent=2) + "\n",
        encoding="utf-8",
    )
    print(json.dumps(summary, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
