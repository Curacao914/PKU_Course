#!/usr/bin/env python3
"""
对照链接合集文件，将乱码（hash）文件名重命名为日期格式。

典型场景：从北大资源平台下载的录播文件和课件，文件名是 32 位 hex hash，
通过下载链接中的日期路径提取上课日期，重命名为可读格式。

链接格式：.../Source/YYYY/MM/DD/{32位hex}.mp4
文件格式：{32位hex}.mp4_{类型}.{ext}

用法：
    python rename_from_links.py --dir ./课程目录
    python rename_from_links.py --dir ./课程目录 --apply
    python rename_from_links.py --dir ./raw --link-file ./下载源 --apply
"""

import argparse
import os
import re
import sys


def find_link_file(search_dir: str) -> str | None:
    """在 search_dir 及其父目录中搜索链接合集文件。

    扫描无扩展名文件和 .txt 文件，读取内容判断是否含 http + .mp4 链接。
    先搜 search_dir 本身，再搜父目录。
    返回找到的第一个文件路径，找不到返回 None。
    """
    dirs_to_search = [search_dir]
    parent = os.path.dirname(search_dir)
    if parent and parent != search_dir:
        dirs_to_search.append(parent)

    for d in dirs_to_search:
        if not os.path.isdir(d):
            continue
        try:
            entries = os.listdir(d)
        except OSError:
            continue

        for f in entries:
            fpath = os.path.join(d, f)
            if not os.path.isfile(fpath) or f.startswith('.'):
                continue
            # 只看无扩展名文件和 .txt 文件
            _, ext = os.path.splitext(f)
            if ext and ext.lower() != '.txt':
                continue

            try:
                with open(fpath, 'r', encoding='utf-8') as fh:
                    content = fh.read(4096)
            except (UnicodeDecodeError, OSError):
                continue
            except PermissionError:
                continue

            if re.search(r'https?://[^\s]+\.mp4', content):
                return fpath

    return None


def parse_links(link_file: str) -> dict:
    """解析链接文件，返回 {hash: 'YYYY-MM-DD'} 映射。

    链接格式: .../Source/YYYY/MM/DD/{hash}.mp4
    """
    pattern = re.compile(r'Source/(\d{4})/(\d{2})/(\d{2})/([0-9A-Fa-f]{32})\.mp4')

    mapping = {}
    with open(link_file, 'r', encoding='utf-8') as f:
        for line in f:
            line = line.strip()
            if not line:
                continue
            m = pattern.search(line)
            if m:
                y, mo, d, hash_str = m.groups()
                date_str = f'{y}-{mo}-{d}'
                hash_upper = hash_str.upper()
                if hash_upper in mapping and mapping[hash_upper] != date_str:
                    print(f"  [警告] hash {hash_upper} 重复映射: "
                          f"{mapping[hash_upper]} vs {date_str}，保留前者")
                else:
                    mapping[hash_upper] = date_str

    return mapping


def extract_hash_from_filename(filename: str) -> str | None:
    """从文件名中提取 32 位 hex hash，返回大写形式。"""
    m = re.search(r'([0-9A-Fa-f]{32})', filename)
    return m.group(1).upper() if m else None


def scan_files(target_dir: str) -> list:
    """扫描 target_dir 中的普通文件（排除隐藏文件和目录）。"""
    try:
        entries = os.listdir(target_dir)
    except OSError:
        return []

    return [
        f for f in entries
        if os.path.isfile(os.path.join(target_dir, f)) and not f.startswith('.')
    ]


def main():
    parser = argparse.ArgumentParser(
        description='对照链接合集文件，将乱码文件名重命名为日期格式'
    )
    parser.add_argument(
        '--dir', required=True,
        help='包含乱码文件的目录（在此目录中扫描待重命名文件）'
    )
    parser.add_argument(
        '--link-file', default=None,
        help='链接合集文件的路径（可选；不指定则自动搜索）'
    )
    parser.add_argument(
        '--apply', action='store_true',
        help='执行重命名（默认 dry-run）'
    )
    args = parser.parse_args()

    target_dir = os.path.abspath(args.dir)
    if not os.path.isdir(target_dir):
        print(f"[错误] 目录不存在: {target_dir}")
        sys.exit(1)

    # Step 1: 定位链接文件
    if args.link_file:
        link_file = os.path.abspath(args.link_file)
        if not os.path.isfile(link_file):
            print(f"[错误] 指定的链接文件不存在: {link_file}")
            sys.exit(1)
        print(f"链接文件（显式指定）: {link_file}")
    else:
        link_file = find_link_file(target_dir)
        if not link_file:
            print("[提示] 未找到链接合集文件。")
            print("请将包含下载链接的文件（文件名随意，如'下载源'、'links.txt'）放入：")
            print(f"  {target_dir}")
            print("  或其父目录。")
            print("文件内容应包含类似以下格式的链接：")
            print("  http://.../Source/YYYY/MM/DD/{32位hex}.mp4")
            print("或通过 --link-file 参数显式指定路径。")
            sys.exit(1)
        print(f"链接文件（自动发现）: {link_file}")

    # Step 2: 解析链接
    mapping = parse_links(link_file)
    if not mapping:
        print("[错误] 链接文件中未找到匹配的链接。")
        print("预期格式: .../Source/YYYY/MM/DD/{32位hex}.mp4")
        sys.exit(1)

    print(f"解析到 {len(mapping)} 条链接映射")

    # Step 3: 扫描文件，匹配 hash
    files = scan_files(target_dir)
    rename_map = {}
    unmatched = []

    for f in files:
        h = extract_hash_from_filename(f)
        if h is None:
            continue  # 不含 hash，跳过（不是乱码文件）
        if h in mapping:
            date = mapping[h]
            # 提取 .mp4_ 后的类型+扩展名
            suffix_m = re.search(r'\.mp4_(.+)$', f, re.IGNORECASE)
            if suffix_m:
                new_name = f'{date}_{suffix_m.group(1)}'
            else:
                _, ext = os.path.splitext(f)
                new_name = f'{date}{ext}'
            rename_map[f] = new_name
        else:
            unmatched.append(f)

    if not rename_map:
        print("\n[错误] 没有文件能匹配链接中的 hash。")
        if unmatched:
            print(f"以下文件含 hash 但未在链接中找到：")
            for f in unmatched:
                print(f"  - {f}")
        sys.exit(1)

    if unmatched:
        print(f"\n[警告] {len(unmatched)} 个文件含 hash 但未在链接中找到映射（将被跳过）：")
        for f in unmatched:
            print(f"  - {f}")

    # Step 4: 检查目标文件名冲突
    seen = {}
    collisions = []
    for src, dst in rename_map.items():
        if dst in seen:
            collisions.append(f"  '{src}' 和 '{seen[dst]}' 都 → '{dst}'")
        else:
            seen[dst] = src

    if collisions:
        print(f"\n[错误] 目标文件名冲突，重命名已中止：")
        for c in collisions:
            print(c)
        sys.exit(1)

    # 检查目标是否已有同名文件（会覆盖）
    existing = []
    for src, dst in rename_map.items():
        if os.path.exists(os.path.join(target_dir, dst)):
            existing.append((src, dst))

    if existing:
        print(f"\n[错误] 以下目标文件已存在，重命名会覆盖：")
        for src, dst in existing:
            print(f"  '{src}' → '{dst}'（已存在）")
        print("请手动处理冲突后重试。")
        sys.exit(1)

    # Step 5: 输出重命名计划
    print(f"\n重命名计划（{len(rename_map)} 个文件）：")
    # 按新名字典序排列便于核对
    for src, dst in sorted(rename_map.items(), key=lambda x: x[1]):
        print(f"  {src}")
        print(f"    → {dst}")

    if not args.apply:
        print(f"\n这是 dry-run 模式，未执行任何操作。")
        print(f"确认无误后执行：")
        link_arg = f" --link-file {args.link_file}" if args.link_file else ""
        print(f"  python rename_from_links.py --dir {args.dir}{link_arg} --apply")
        return

    # 执行重命名
    print()
    ok = 0
    for src, dst in rename_map.items():
        src_path = os.path.join(target_dir, src)
        dst_path = os.path.join(target_dir, dst)
        try:
            os.rename(src_path, dst_path)
            print(f"  ✓ {src} → {dst}")
            ok += 1
        except OSError as e:
            print(f"  ✗ 失败 '{src}': {e}")

    print(f"\n完成。成功 {ok}/{len(rename_map)}。")


if __name__ == '__main__':
    main()
