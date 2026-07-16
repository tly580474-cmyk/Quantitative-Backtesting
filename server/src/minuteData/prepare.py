from __future__ import annotations

import argparse
import json
import os
import re
import shutil
import sys
import time
import zipfile
import zlib
from datetime import datetime, timezone
from pathlib import Path


PARQUET_NAME = re.compile(r"^(\d{8})\.parquet$")
EXPECTED_COLUMNS = [
    "code", "trade_time", "close", "open", "high", "low", "vol", "amount",
    "date", "pre_close", "change", "pct_chg", "__index_level_0__",
]


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Prepare the historical 1-minute Parquet lake")
    parser.add_argument("--zip-root", default=os.getenv("MINUTE_DATA_ZIP_ROOT", "../../所有股票的历史数据/1m_price_zip"))
    parser.add_argument("--output-root", default=os.getenv("MINUTE_DATA_ROOT", "../../所有股票的历史数据/1m_price_parquet"))
    parser.add_argument("--start-year", type=int, default=2010)
    parser.add_argument("--end-year", type=int, default=2026)
    parser.add_argument("--overwrite", action="store_true")
    return parser.parse_args()


def safe_member(member: zipfile.ZipInfo, year: int) -> tuple[str, str]:
    name = Path(member.filename).name
    match = PARQUET_NAME.fullmatch(name)
    if member.is_dir() or not match or not name.startswith(str(year)):
        raise ValueError(f"{year}.zip 包含不符合约定的成员：{member.filename}")
    return name, match.group(1)


def extract_member(
    archive: zipfile.ZipFile,
    member: zipfile.ZipInfo,
    target: Path,
    overwrite: bool,
) -> bool:
    if not overwrite and target.exists() and target.stat().st_size == member.file_size:
        return False
    temporary = target.with_suffix(target.suffix + ".partial")
    temporary.unlink(missing_ok=True)
    with archive.open(member) as source, temporary.open("wb") as output:
        shutil.copyfileobj(source, output, length=4 * 1024 * 1024)
    if temporary.stat().st_size != member.file_size:
        temporary.unlink(missing_ok=True)
        raise IOError(f"解包大小不一致：{member.filename}")
    os.replace(temporary, target)
    return True


def file_crc32(path: Path) -> str:
    checksum = 0
    with path.open("rb") as source:
        while chunk := source.read(4 * 1024 * 1024):
            checksum = zlib.crc32(chunk, checksum)
    return f"{checksum & 0xFFFFFFFF:08x}"


def main() -> int:
    args = parse_args()
    if args.start_year > args.end_year:
        raise ValueError("start-year 不能大于 end-year")
    zip_root = Path(args.zip_root).resolve()
    output_root = Path(args.output_root).resolve()
    output_root.mkdir(parents=True, exist_ok=True)
    years: list[dict[str, object]] = []
    files: list[dict[str, object]] = []
    started = time.monotonic()

    for year in range(args.start_year, args.end_year + 1):
        source_zip = zip_root / f"{year}.zip"
        if not source_zip.is_file():
            raise FileNotFoundError(f"缺少年度压缩包：{source_zip}")
        year_root = output_root / f"year={year}"
        year_root.mkdir(parents=True, exist_ok=True)
        extracted = 0
        year_files: list[dict[str, object]] = []
        with zipfile.ZipFile(source_zip) as archive:
            members = sorted(
                (member for member in archive.infolist() if not member.is_dir()),
                key=lambda member: member.filename,
            )
            for member in members:
                name, date = safe_member(member, year)
                target = year_root / name
                extracted += int(extract_member(archive, member, target, args.overwrite))
                entry = {
                    "date": f"{date[:4]}-{date[4:6]}-{date[6:]}",
                    "relativePath": f"year={year}/{name}",
                    "bytes": member.file_size,
                    "crc32": f"{member.CRC:08x}",
                    "source": "archive",
                }
                year_files.append(entry)
                files.append(entry)
        archived_names = {Path(str(item["relativePath"])).name for item in year_files}
        for target in sorted(year_root.glob("*.parquet")):
            if target.name in archived_names:
                continue
            name, date = safe_member(zipfile.ZipInfo(target.name), year)
            entry = {
                "date": f"{date[:4]}-{date[4:6]}-{date[6:]}",
                "relativePath": f"year={year}/{name}",
                "bytes": target.stat().st_size,
                "crc32": file_crc32(target),
                "source": "incremental",
            }
            year_files.append(entry)
            files.append(entry)
        year_files.sort(key=lambda item: str(item["date"]))
        zip_stat = source_zip.stat()
        years.append({
            "year": year,
            "sourceZip": str(source_zip),
            "sourceBytes": zip_stat.st_size,
            "sourceModifiedAt": datetime.fromtimestamp(zip_stat.st_mtime, timezone.utc).isoformat(),
            "fileCount": len(year_files),
            "firstDate": year_files[0]["date"] if year_files else None,
            "lastDate": year_files[-1]["date"] if year_files else None,
            "parquetBytes": sum(int(item["bytes"]) for item in year_files),
            "extractedFiles": extracted,
        })
        print(json.dumps({
            "year": year,
            "files": len(year_files),
            "extracted": extracted,
            "elapsedSeconds": round(time.monotonic() - started, 1),
        }, ensure_ascii=False), flush=True)

    files.sort(key=lambda item: str(item["date"]))
    manifest = {
        "schemaVersion": 1,
        "dataset": "a-share-1m-price",
        "startYear": args.start_year,
        "endYear": args.end_year,
        "preparedAt": datetime.now(timezone.utc).isoformat(),
        "columns": EXPECTED_COLUMNS,
        "years": years,
        "files": files,
    }
    temporary_manifest = output_root / "manifest.json.partial"
    temporary_manifest.write_text(json.dumps(manifest, ensure_ascii=False, indent=2), encoding="utf-8")
    os.replace(temporary_manifest, output_root / "manifest.json")
    print(json.dumps({
        "status": "ready",
        "root": str(output_root),
        "years": len(years),
        "files": len(files),
        "parquetBytes": sum(int(item["bytes"]) for item in files),
        "elapsedSeconds": round(time.monotonic() - started, 1),
    }, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except Exception as error:
        print(json.dumps({"status": "failed", "error": str(error)}, ensure_ascii=False), file=sys.stderr)
        raise
