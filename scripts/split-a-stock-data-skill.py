#!/usr/bin/env python3
"""Split an installed upstream a-stock-data skill without changing its code.

Uses only the Python standard library. Build and verify before installing; the
installer backs up SKILL.md and switches the entry only after references exist.
"""
import argparse
import hashlib
import json
import os
import re
import shutil
from pathlib import Path


def digest(data):
    return hashlib.sha256(data).hexdigest()


def sections(raw):
    # Split on LF rather than str.splitlines(): some installations have CR CR LF.
    lines = raw.splitlines(keepends=True) if b"\r\r\n" not in raw else raw.split(b"\n")
    if b"\r\r\n" in raw:
        lines = [line + b"\n" for line in lines[:-1]] + ([lines[-1]] if lines[-1] else [])
    starts = [(0, "上游原始元信息、作者与版本记录")]
    parent = ""
    fence = None
    offset = 0
    for line in lines:
        text = line.decode("utf-8-sig").rstrip("\r\n")
        marker = re.match(r"^ {0,3}(`{3,}|~{3,})(.*)$", text)
        if marker:
            if fence is None:
                fence = marker[1]
            elif marker[1][0] == fence[0] and len(marker[1]) >= len(fence) and not marker[2].strip():
                fence = None
        elif fence is None:
            heading = re.match(r"^(#{2,3}) (.+)$", text)
            if heading:
                level, title = len(heading[1]), heading[2]
                if level == 2:
                    parent = title
                # Keep each domain intact, including examples that use earlier
                # functions. Split prerequisites into independently routed helpers.
                if level == 2 or (level == 3 and parent == "Prerequisites"):
                    starts.append((offset, title))
        offset += len(line)
    if fence:
        raise ValueError("Unclosed Markdown fence in upstream skill")
    titles = [title for _, title in starts]
    for required in ("Prerequisites", "When to Activate"):
        if required not in titles:
            raise ValueError(f"Missing expected upstream section: {required}")
    if not any(title.startswith("Layer 1:") for title in titles):
        raise ValueError("No upstream data layers found")
    result = []
    for i, (start, title) in enumerate(starts):
        end = starts[i + 1][0] if i + 1 < len(starts) else len(raw)
        result.append((title, raw[start:end]))
    assert b"".join(content for _, content in result) == raw
    return result


def entry_text(records, refdir, version, origin):
    rows = []
    for item in records:
        title = item["title"].replace("|", "\\|")
        rows.append(f'| [{title}]({refdir}/{item["file"]}) | {item["bytes"] / 1024:.1f} KB |')
    return f'''---
name: a-stock-data
description: 当任务需要写代码实际获取 A 股及相关市场数据时使用，覆盖行情、财报、研报、资金、新闻、公告、打板、ETF、宏观及该版本提供的其他端点。只在实际取数时加载；概念解释、投资观点或无需取数的策略讨论不触发。按目录读取所需数据层及公共 helper。
metadata:
  version: {json.dumps(version)}
  origin: {json.dumps(origin)}
  layout: progressive-disclosure-v1
---

# A 股数据工具包：按需读取入口

上游：[simonlin1212/a-stock-data](https://github.com/simonlin1212/a-stock-data)，作者 Simon 林。
本地拆分自 **{version}**，只调整文档布局，接口代码和原文逐字节保存在下列参考文件。
原始声明、作者信息和更新记录位于第一份参考文件；不要为普通取数任务加载更新记录。

## 使用步骤

1. 在本量化项目中，先用项目行情接口；仅在缺失、为空、过期或不支持时补充外部数据。
   遵守项目的数据访问约束，外部结果不得直接回写权威数据库、数据湖或研究快照。
2. 从下表选取需要的数据层。只读该层及其依赖，不要遍历目录或一次性读取全部文件。
   不确定端点时先读「端点路由速查」；原文中的 § 编号和「上方/下方」指向下表对应文件。
3. 首次调用某数据源时读取「数据源优先级 & 东财防封」及需要的公共准备代码。
   `Prerequisites` 仅列依赖；共享 helper 已单独拆出，不能假定读取端点就已执行依赖。
4. 在同一 Python 进程中先定义依赖，再运行所选函数。Markdown 内有示例调用，
   **不要自动执行整份参考文档、所有代码块或完整调研流程**。
5. 记录来源、数据日期、抓取时间与降级原因；将空数据和接口失败区分。版本记录中的实测日期
   是上游历史记录，不代表本次网络验证。失败时再读「备用源速查」和 FAQ。

## 公共代码依赖

- 使用配置好的 Python/venv，按所选接口安装缺失依赖，见 `Prerequisites`。
- 标的代码先按「市场前缀规则」和「Ticker 格式归一化」处理，保留显式市场信息。
- mootdx 必须使用「mootdx 客户端」中的 `tdx_client()`，并遵循所安装版本的命令限制。
- 东财接口先定义「东财数据中心统一查询」中的 `em_get()` 等 helper；串行访问、
  每次至少间隔 1 秒加随机抖动、复用会话与 UA/Referer，批量任务进一步降速。
- 若目录提供「V3.9.0 共用 helper」，所有标注 V3.9.0 的新端点先读取该文件；
  其中引用的东财、市场前缀、代码归一化函数也须先定义。其他跨层函数按函数名定位定义。
- iwencai 仅在需要语义搜索且已配置 API Key 时使用；不要将凭据写入文档或输出。

## 按需参考目录

链接相对本 `SKILL.md` 所在目录解析；打开文件时使用这个技能安装目录的绝对路径。
参考文件保留上游原文；其中 `docs/...` 链接以原上游仓库根目录为基准，缺少时到项目主页查阅。
这些文件是代码片段文档，未改造成可直接 import 的 Python 模块。

| 内容 | 原文字节大小 |
| --- | ---: |
{chr(10).join(rows)}

<!-- quant-a-stock-split-manifest: {refdir}/manifest.json -->
'''


def build(source, output):
    raw = source.read_bytes()
    text = raw.decode("utf-8-sig").replace("\r\r\n", "\n").replace("\r\n", "\n")
    if "quant-a-stock-split-manifest:" in text:
        raise ValueError("Source is already split; use the original backup for rebuilding")
    front = re.match(r"\A---\n(.*?)\n---(?:\n|$)", text, re.S)
    if not front or not re.search(r"^name: a-stock-data$", front[1], re.M):
        raise ValueError("Expected upstream a-stock-data YAML frontmatter")
    # Unknown runtime control fields must not silently disappear in a rewrite.
    keys = set(re.findall(r"^([a-z][a-z-]*):", front[1], re.M))
    if keys - {"name", "description", "version", "origin"}:
        raise ValueError(f"Review new upstream metadata before splitting: {sorted(keys)}")
    def field(key):
        found = re.search(rf"^{key}: ([^\n]+)$", front[1], re.M)
        if not found:
            raise ValueError(f"Missing {key}")
        return found[1].strip().strip('\"\'')
    version, origin = field("version"), field("origin")
    chunks = sections(raw)
    output.mkdir(parents=True, exist_ok=False)
    refdir = "references/quant-split-" + digest(raw)[:16]
    refs = output / refdir
    refs.mkdir(parents=True)
    records = []
    for i, (title, content) in enumerate(chunks):
        file = f"{i:02d}.md"
        (refs / file).write_bytes(content)
        records.append(dict(title=title, file=file, bytes=len(content), sha256=digest(content)))
    entry = entry_text(records, refdir, version, origin).encode("utf-8")
    (output / "SKILL.md").write_bytes(entry)
    manifest = dict(format=1, source_sha256=digest(raw), source_bytes=len(raw),
                    version=version, entry_sha256=digest(entry), sections=records)
    (refs / "manifest.json").write_text(json.dumps(manifest, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    return verify(output)


def verify(root):
    entry = (root / "SKILL.md").read_bytes()
    text = entry.decode("utf-8")
    marker = re.search(r"<!-- quant-a-stock-split-manifest: (references/quant-split-[0-9a-f]{16}/manifest.json) -->", text)
    if not marker:
        raise ValueError("Missing split manifest marker")
    manifest_path = root / marker[1]
    manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    if manifest["format"] != 1 or digest(entry) != manifest["entry_sha256"]:
        raise ValueError("Entry or format differs from generated manifest")
    content = []
    for i, item in enumerate(manifest["sections"]):
        if item["file"] != f"{i:02d}.md":
            raise ValueError("Unexpected reference filename")
        data = (manifest_path.parent / item["file"]).read_bytes()
        if digest(data) != item["sha256"] or len(data) != item["bytes"]:
            raise ValueError(f'Reference changed: {item["file"]}')
        link = str(Path(marker[1]).parent / item["file"]).replace("\\", "/")
        if f"]({link})" not in text:
            raise ValueError(f"Unrouted reference: {link}")
        content.append(data)
    original = b"".join(content)
    if digest(original) != manifest["source_sha256"] or len(original) != manifest["source_bytes"]:
        raise ValueError("Original document cannot be reconstructed byte for byte")
    if len(entry) >= 12 * 1024:
        raise ValueError("Entry exceeded 12 KiB; review routing before installing")
    return dict(version=manifest["version"], source_bytes=len(original), entry_bytes=len(entry),
                entry_lines=len(text.splitlines()), references=len(content),
                source_sha256=manifest["source_sha256"], manifest=marker[1])


def install(bundle, target, backup_dir):
    info = verify(bundle)
    target = target.resolve(strict=True)
    backup_dir = backup_dir.resolve()
    if backup_dir == target or target in backup_dir.parents:
        raise ValueError("Backups must be outside the installed skill directory")
    skill = target / "SKILL.md"
    if skill.is_symlink():
        raise ValueError("Resolve a symlinked SKILL.md installation manually before installing")
    current = skill.read_bytes()
    wanted = (bundle / "SKILL.md").read_bytes()
    if current == wanted:
        verify(target)
        return dict(info, installed=False, reason="already installed and verified")
    if digest(current) != info["source_sha256"]:
        raise ValueError("Installed source changed; rebuild from that source before installing")
    backup_dir.mkdir(parents=True, exist_ok=True)
    backup = backup_dir / (info["source_sha256"] + ".original.md")
    if backup.exists():
        if backup.read_bytes() != current:
            raise ValueError("Backup collision")
    else:
        with backup.open("xb") as stream:
            stream.write(current)
    relative = Path(info["manifest"]).parent
    destination = target / relative
    if not destination.resolve().is_relative_to(target):
        raise ValueError("References path escapes installed skill directory")
    # Never overwrite a pre-existing directory: it may belong to the user.
    shutil.copytree(bundle / relative, destination)
    if skill.read_bytes() != current:
        raise ValueError("Installed entry changed during copy; entry was not replaced")
    temporary = target / ".quant-split-entry.tmp"
    created = False
    try:
        with temporary.open("xb") as stream:
            created = True
            stream.write(wanted)
        os.chmod(temporary, skill.stat().st_mode)
        os.replace(temporary, skill)
        verify(target)
    finally:
        if created and temporary.exists():
            temporary.unlink()
    return dict(info, installed=True, backup=str(backup))


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    sub = parser.add_subparsers(dest="command", required=True)
    cmd = sub.add_parser("build")
    cmd.add_argument("source", type=Path)
    cmd.add_argument("output", type=Path, help="new staging directory (must not already exist)")
    cmd = sub.add_parser("verify")
    cmd.add_argument("directory", type=Path)
    cmd = sub.add_parser("install")
    cmd.add_argument("bundle", type=Path)
    cmd.add_argument("target", type=Path, help="existing skill directory")
    cmd.add_argument("--backup-dir", type=Path, required=True)
    args = parser.parse_args()
    if args.command == "build":
        result = build(args.source, args.output)
    elif args.command == "verify":
        result = verify(args.directory)
    else:
        result = install(args.bundle, args.target, args.backup_dir)
    print(json.dumps(result, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
