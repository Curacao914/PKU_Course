#!/usr/bin/env python3
"""
提交听悟转录任务。
被 workflow.py 调用，也可独立运行。
"""

import os
import json
import datetime
from aliyunsdkcore.client import AcsClient
from aliyunsdkcore.request import CommonRequest
from aliyunsdkcore.auth.credentials import AccessKeyCredential


def submit_task(file_url: str) -> dict:
    """提交单个听悟转录任务，返回 API 响应"""
    credentials = AccessKeyCredential(
        os.environ['ALIBABA_CLOUD_ACCESS_KEY_ID'],
        os.environ['ALIBABA_CLOUD_ACCESS_KEY_SECRET']
    )
    client = AcsClient(region_id='cn-beijing', credential=credentials)

    body = {
        'AppKey': os.environ['TINGWU_APP_KEY'],
        'Input': {
            'SourceLanguage': 'cn',
            'FileUrl': file_url,
            'TaskKey': 'task_' + datetime.datetime.now().strftime('%Y%m%d%H%M%S_%f'),
        },
        'Parameters': {
            'Transcription': {
                'DiarizationEnabled': False,
            },
            'PptExtractionEnabled': True,
            'TextPolishEnabled': True,
        }
    }

    request = CommonRequest()
    request.set_accept_format('json')
    request.set_domain('tingwu.cn-beijing.aliyuncs.com')
    request.set_version('2023-09-30')
    request.set_protocol_type('https')
    request.set_method('PUT')
    request.set_uri_pattern('/openapi/tingwu/v2/tasks')
    request.add_query_param('type', 'offline')
    request.add_header('Content-Type', 'application/json')
    request.set_content(json.dumps(body).encode('utf-8'))

    response = client.do_action_with_exception(request)
    return json.loads(response)


if __name__ == '__main__':
    import argparse
    parser = argparse.ArgumentParser(description='提交听悟转录任务')
    parser.add_argument('--url', required=True, help='音视频文件 URL')
    args = parser.parse_args()

    result = submit_task(args.url)
    print(json.dumps(result, indent=2, ensure_ascii=False))
