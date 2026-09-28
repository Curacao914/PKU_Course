#!/usr/bin/env python3
"""把一个文件上传到 Cloudflare R2（S3 兼容），供 course backup 的异地步骤调用。

用法：
    python3 tools/r2-put.py <本地文件> [远端前缀]

为什么是 Python：R2 的凭据与 boto3 已经在这台机器上（转写时上传媒体用的就是它），
再为备份引一个 Node 侧的 S3 签名实现，等于多一份需要维护、也更容易悄悄写错的加密代码。

成功后打印 `R2 <key> <bytes>` 并以 0 退出；上传后立刻 HEAD 一次确认对象真的在——
"我以为传上去了"和"备份成功"是两件事。

由 course backup 通过 COURSE_BACKUP_OFFSITE 调用，模板里的 {} 会被替换成文件路径：
    COURSE_BACKUP_OFFSITE="/path/.venv/bin/python /path/tools/r2-put.py {} course-backups/"
"""
from __future__ import annotations

import os
import sys
from datetime import datetime, timezone
from pathlib import Path


def fail(message: str) -> "NoReturn":  # noqa: F821 - 只为可读性
    print(f"r2-put 失败：{message}", file=sys.stderr)
    raise SystemExit(1)


def main() -> int:
    if len(sys.argv) < 2:
        fail("用法：r2-put.py <本地文件> [远端前缀]")
    source = Path(sys.argv[1])
    prefix = (sys.argv[2] if len(sys.argv) > 2 else "course-backups").strip("/")
    if not source.is_file():
        fail(f"找不到文件：{source}")

    endpoint = os.environ.get("R2_ENDPOINT", "").strip()
    bucket = os.environ.get("R2_BUCKET", "").strip()
    key_id = os.environ.get("R2_ACCESS_KEY_ID", "").strip()
    secret = os.environ.get("R2_SECRET_ACCESS_KEY", "").strip()
    if not (endpoint and bucket and key_id and secret):
        fail("缺少 R2_ENDPOINT / R2_BUCKET / R2_ACCESS_KEY_ID / R2_SECRET_ACCESS_KEY")

    try:
        import boto3
        from botocore.config import Config
    except ImportError as error:  # pragma: no cover - 环境问题，直接说清楚
        fail(f"没有 boto3：{error}")

    # 按日期分目录：既好找，也避免同一个前缀下无限堆文件
    day = datetime.now(timezone.utc).strftime("%Y-%m-%d")
    key = f"{prefix}/{day}/{source.name}" if prefix else f"{day}/{source.name}"
    client = boto3.client(
        "s3",
        endpoint_url=endpoint,
        aws_access_key_id=key_id,
        aws_secret_access_key=secret,
        region_name="auto",
        config=Config(signature_version="s3v4"),
    )
    try:
        client.upload_file(str(source), bucket, key)
        head = client.head_object(Bucket=bucket, Key=key)
    except Exception as error:  # pragma: no cover - 网络/凭据问题
        fail(f"{type(error).__name__}: {error}")

    print(f"R2 {key} {head.get('ContentLength', source.stat().st_size)}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
