#!/usr/bin/env python3
"""
轮询听悟任务状态并下载结果。
被 workflow.py 调用，也可独立运行。
"""

import json
import os
import time
import urllib.request
from aliyunsdkcore.client import AcsClient
from aliyunsdkcore.request import CommonRequest
from aliyunsdkcore.auth.credentials import AccessKeyCredential


def create_client():
    credentials = AccessKeyCredential(
        os.environ['ALIBABA_CLOUD_ACCESS_KEY_ID'],
        os.environ['ALIBABA_CLOUD_ACCESS_KEY_SECRET']
    )
    return AcsClient(region_id='cn-beijing', credential=credentials)


def query_task(client, task_id: str) -> dict:
    uri = f'/openapi/tingwu/v2/tasks/{task_id}'
    request = CommonRequest()
    request.set_accept_format('json')
    request.set_domain('tingwu.cn-beijing.aliyuncs.com')
    request.set_version('2023-09-30')
    request.set_protocol_type('https')
    request.set_method('GET')
    request.set_uri_pattern(uri)
    request.add_header('Content-Type', 'application/json')

    response = client.do_action_with_exception(request)
    return json.loads(response)


def download_file(url: str, output_path: str):
    urllib.request.urlretrieve(url, output_path)


def poll_and_download(tasks: dict, raw_dir: str, resume: bool = False,
                      poll_interval: int = 60):
    """轮询所有任务并下载结果"""
    client = create_client()
    lessons = tasks.get('lessons', [])

    # 分类：已完成、待下载、待轮询
    to_poll = []
    for lesson in lessons:
        if lesson.get('status') == 'SUBMIT_FAILED':
            continue

        lesson_num = lesson['lesson_num']
        task_id = lesson.get('task_id', '')

        # 检查是否已下载
        trans_path = os.path.join(raw_dir, f'transcription_{lesson_num}.json')
        polish_path = os.path.join(raw_dir, f'text_polish_{lesson_num}.json')

        if resume and (os.path.exists(trans_path) or os.path.exists(polish_path)):
            print(f"  [{lesson_num}] 已下载，跳过")
            continue

        to_poll.append(lesson)

    if not to_poll:
        print("  所有任务已完成下载")
        return

    print(f"  待处理: {len(to_poll)} 个任务")

    # 轮询循环
    completed = {}
    while to_poll:
        remaining = []
        for lesson in to_poll:
            task_id = lesson['task_id']
            lesson_num = lesson['lesson_num']

            try:
                result = query_task(client, task_id)
                data = result.get('Data', {})
                status = data.get('TaskStatus', 'UNKNOWN')

                if status == 'COMPLETED':
                    print(f"  [{lesson_num}] COMPLETED ✓")
                    download_results(data, raw_dir, lesson_num)
                    completed[lesson_num] = data
                elif status == 'FAILED':
                    print(f"  [{lesson_num}] FAILED ✗ ({data.get('ErrorMessage', '')})")
                else:
                    remaining.append(lesson)
            except Exception as e:
                print(f"  [{lesson_num}] 查询失败: {e}")
                remaining.append(lesson)

        to_poll = remaining

        if to_poll:
            print(f"  {len(to_poll)} 个任务进行中，{poll_interval}s 后重试...")
            time.sleep(poll_interval)

    print(f"\n  完成: {len(completed)} 个任务下载成功")


def download_results(data: dict, raw_dir: str, lesson_num: int):
    """下载任务结果"""
    result = data.get('Result', {})

    # 下载转录
    if 'Transcription' in result:
        url = result['Transcription']
        path = os.path.join(raw_dir, f'transcription_{lesson_num}.json')
        print(f"    下载转录...")
        download_file(url, path)

    # 下载口语书面化
    if 'TextPolish' in result:
        url = result['TextPolish']
        path = os.path.join(raw_dir, f'text_polish_{lesson_num}.json')
        print(f"    下载口语书面化...")
        download_file(url, path)

    # 下载 PPT 提取结果（JSON 格式，包含图片 URL 列表）
    if 'PptExtraction' in result:
        url = result['PptExtraction']
        json_path = os.path.join(raw_dir, f'ppt_extraction_{lesson_num}.json')
        print(f"    下载 PPT 结果...")
        download_file(url, json_path)

        # 解析 PPT JSON，下载所有图片
        with open(json_path, 'r', encoding='utf-8') as f:
            ppt_data = json.load(f)

        ppt_dir = os.path.join(raw_dir, f'ppt_{lesson_num}')
        os.makedirs(ppt_dir, exist_ok=True)

        frames = ppt_data.get('PptExtraction', {}).get('KeyFrameList', [])
        print(f"    下载 {len(frames)} 张 PPT 截图...")
        for i, frame in enumerate(frames):
            img_url = frame.get('FileUrl', '')
            if img_url:
                img_path = os.path.join(ppt_dir, f'slide_{i+1:03d}.png')
                if not os.path.exists(img_path):  # 断点续传
                    try:
                        download_file(img_url, img_path)
                    except Exception as e:
                        print(f"      [{i+1}] 下载失败: {e}")


if __name__ == '__main__':
    import argparse
    parser = argparse.ArgumentParser(description='轮询听悟任务并下载结果')
    parser.add_argument('--dir', required=True, help='工作目录')
    parser.add_argument('--resume', action='store_true', help='跳过已下载的任务')
    parser.add_argument('--interval', type=int, default=60, help='轮询间隔（秒）')
    args = parser.parse_args()

    tasks_path = os.path.join(args.dir, 'working', 'tasks.json')
    if not os.path.exists(tasks_path):
        print(f"[错误] 未找到 {tasks_path}")
        exit(1)

    with open(tasks_path, 'r', encoding='utf-8') as f:
        tasks = json.load(f)

    raw_dir = os.path.join(args.dir, 'data', 'raw')
    os.makedirs(raw_dir, exist_ok=True)

    poll_and_download(tasks, raw_dir, resume=args.resume, poll_interval=args.interval)
