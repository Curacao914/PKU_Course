#!/usr/bin/env python3
"""asr_core 纯函数测试。

只依赖标准库：asr_core 本身已剥离第三方依赖，因此这些测试在任何 Python 3.12
环境都能直接运行：

    python3 test_asr_core.py
    python3 -m unittest discover -p 'test_*.py'
"""

from __future__ import annotations

import json
import tempfile
import unittest
from pathlib import Path
from urllib import error

import asr_core


def http_error(code: int) -> error.HTTPError:
    return error.HTTPError("https://example.invalid", code, "boom", None, None)


class FormatTimestampTests(unittest.TestCase):
    def test_formats_hours_minutes_seconds(self):
        self.assertEqual(asr_core.format_timestamp(0), "00:00:00")
        self.assertEqual(asr_core.format_timestamp(59_999), "00:00:59")
        self.assertEqual(asr_core.format_timestamp(3_661_000), "01:01:01")
        self.assertEqual(asr_core.format_timestamp(45 * 60 * 1000), "00:45:00")

    def test_clamps_negative_values(self):
        self.assertEqual(asr_core.format_timestamp(-1), "00:00:00")


class ExtractSentencesTests(unittest.TestCase):
    """分片转录的时间戳偏移是全链路最易错的一段：每段的句子时间都从 0 开始，
    必须加上该片在整段音频中的起点。"""

    def test_applies_chunk_offset_to_every_timestamp(self):
        result = {
            "properties": {"original_duration_in_milliseconds": 2_700_000},
            "transcripts": [{
                "content_duration_in_milliseconds": 2_500_000,
                "sentences": [
                    {"begin_time": 0, "end_time": 1500, "text": "第一句"},
                    {"begin_time": 1500, "end_time": 3000, "text": "第二句"},
                ],
            }],
        }
        sentences, original_ms, speech_ms = asr_core.extract_sentences(result, 2_700_000)
        self.assertEqual([s["begin_time"] for s in sentences], [2_700_000, 2_701_500])
        self.assertEqual([s["end_time"] for s in sentences], [2_701_500, 2_703_000])
        self.assertEqual([s["text"] for s in sentences], ["第一句", "第二句"])
        self.assertEqual(original_ms, 2_700_000)
        self.assertEqual(speech_ms, 2_500_000)

    def test_skips_blank_sentences_and_sums_every_transcript(self):
        result = {
            "transcripts": [
                {"content_duration_in_milliseconds": 1000, "sentences": [
                    {"begin_time": 0, "end_time": 10, "text": "   "},
                    {"begin_time": 10, "end_time": 20, "text": " 保留 "},
                ]},
                {"content_duration_in_milliseconds": 500, "sentences": [
                    {"begin_time": 0, "end_time": 5, "text": "第二轨"},
                ]},
            ],
        }
        sentences, original_ms, speech_ms = asr_core.extract_sentences(result, 0)
        self.assertEqual([s["text"] for s in sentences], ["保留", "第二轨"])
        self.assertEqual(speech_ms, 1500)
        self.assertEqual(original_ms, 0)

    def test_tolerates_missing_fields(self):
        sentences, original_ms, speech_ms = asr_core.extract_sentences({}, 0)
        self.assertEqual(sentences, [])
        self.assertEqual((original_ms, speech_ms), (0, 0))


class SanitizeTests(unittest.TestCase):
    def test_sanitize_text_redacts_credentials_and_urls(self):
        text = asr_core.sanitize_text(
            "GET https://dashscope.aliyuncs.com/api/v1/tasks/abc "
            "api_key=sk-abcdef0123456789 Authorization: Bearer zzzz"
        )
        self.assertIn("<REDACTED_URL>", text)
        self.assertIn("api_key=<REDACTED>", text)
        self.assertIn("Authorization: Bearer <REDACTED>", text)
        self.assertNotIn("sk-abcdef0123456789", text)

    def test_sanitize_text_redacts_home_directory_and_jwt(self):
        text = asr_core.sanitize_text(f"{asr_core.HOME}/course/media.mp4")
        self.assertEqual(text, "<HOME>/course/media.mp4")
        jwt = "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.abcdefghij"
        self.assertNotIn(jwt, asr_core.sanitize_text(f"token {jwt}"))

    def test_sanitize_json_walks_nested_structures(self):
        payload = {
            "task_id": "abc-123",
            "input": {"file_urls": ["https://signed.example/x.mp3"]},
            "results": [{"transcription_url": "https://signed.example/t.json"}],
            "note": "ok",
        }
        clean = asr_core.sanitize_json(payload)
        self.assertEqual(clean["task_id"], "<REDACTED>")
        self.assertEqual(clean["results"][0]["transcription_url"], "<REDACTED_URL>")
        self.assertEqual(clean["note"], "ok")
        # 已知行为：命中敏感键时整个值被替换成字符串，列表会塌缩成标量。
        # 此处如实断言而非"修正"——只有敏感键会塌缩，普通键（如 results）仍递归保形，
        # 而敏感键本来就不应被任何消费方解析。
        self.assertEqual(clean["input"]["file_urls"], "<REDACTED_URL>")
        self.assertNotIn("signed.example", json.dumps(clean))

    def test_sanitize_json_keeps_non_string_scalars(self):
        clean = asr_core.sanitize_json({"count": 3, "ok": True, "ratio": 0.288, "none": None})
        self.assertEqual(clean, {"count": 3, "ok": True, "ratio": 0.288, "none": None})


class SafeSlugTests(unittest.TestCase):
    def test_keeps_chinese_and_normalises_separators(self):
        self.assertEqual(asr_core.safe_slug("刑法分论 2026-06-03 第5-6节"), "刑法分论-2026-06-03-第5-6节")
        self.assertEqual(asr_core.safe_slug("a/b:c"), "a-b-c")

    def test_falls_back_and_truncates(self):
        self.assertEqual(asr_core.safe_slug("   "), "lesson")
        self.assertEqual(len(asr_core.safe_slug("x" * 150)), 100)


class RetentionAndRetryTests(unittest.TestCase):
    def test_task_failure_summary_collects_reasons_in_order(self):
        summary = asr_core.task_failure_summary({
            "output": {
                "code": "InvalidFile",
                "message": "download failed",
                "task_status": "FAILED",
                "results": [{"subtask_status": "FAILED", "code": "BadUrl"}],
            },
        })
        self.assertEqual(
            summary,
            "code=InvalidFile; message=download failed; task_status=FAILED; subtask_status=FAILED; code=BadUrl",
        )

    def test_task_failure_summary_has_a_fallback(self):
        self.assertEqual(asr_core.task_failure_summary({}), "未返回具体失败原因")

    def test_only_transient_failures_are_retryable(self):
        for code in (408, 425, 429, 500, 502, 503, 504):
            self.assertTrue(asr_core.is_retryable_exception(http_error(code)), code)
        for code in (400, 401, 403, 404, 422):
            self.assertFalse(asr_core.is_retryable_exception(http_error(code)), code)
        self.assertTrue(asr_core.is_retryable_exception(error.URLError("reset")))
        self.assertTrue(asr_core.is_retryable_exception(TimeoutError()))
        self.assertTrue(asr_core.is_retryable_exception(ConnectionResetError()))
        self.assertFalse(asr_core.is_retryable_exception(ValueError("nope")))


class TranscribeChunkResumeTests(unittest.TestCase):
    """检查点存在时必须直接返回，不再抽音频、不再上传、不再提交任务。
    这是断点续跑的核心保证：重跑不能重复消费 ASR 额度。"""

    def test_existing_checkpoint_short_circuits(self):
        with tempfile.TemporaryDirectory() as raw:
            root = Path(raw)
            checkpoint = root / "chunk-001.json"
            checkpoint.write_text(json.dumps({
                "chunkIndex": 1,
                "startSeconds": 0,
                "sentences": [{"begin_time": 0, "end_time": 10, "text": "已缓存"}],
            }), encoding="utf-8")

            class ExplodingS3:
                def __getattr__(self, name):
                    raise AssertionError(f"checkpoint 命中后不应触碰 R2：{name}")

            logs: list[str] = []
            result = asr_core.transcribe_chunk(
                source=root / "media.mp4",
                chunk_index=1,
                start_seconds=0.0,
                duration_seconds=2700.0,
                checkpoint_path=checkpoint,
                task_path=root / "chunk-001.task.json",
                temp_dir=root,
                config={"DASHSCOPE_API_KEY": "test"},
                s3=ExplodingS3(),
                bucket="bucket",
                log=logs.append,
            )
            self.assertEqual(result["sentences"][0]["text"], "已缓存")
            self.assertEqual(logs, [])


if __name__ == "__main__":
    unittest.main(verbosity=2)
