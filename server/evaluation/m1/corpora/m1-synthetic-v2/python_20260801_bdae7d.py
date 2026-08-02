#!/usr/bin/env python3
# -*- coding: utf-8 -*-

"""
策略文件解析脚本
功能：将 "accepted - 副本.txt"（每行一个JSON）解析为表格，导出为 CSV/Excel。
使用方法：
    pip install pandas openpyxl   # 首次运行需安装依赖
    python parse_strategies.py -i "accepted - 副本.txt" -o output.csv
    python parse_strategies.py -i "accepted - 副本.txt" -o output.xlsx
"""

import json
import argparse
from pathlib import Path
import pandas as pd


def flatten_score(scores_dict, prefix):
    """将 judge 中的 scores 字典展平为独立列"""
    if not scores_dict:
        return {}
    return {
        f"{prefix}_accuracy": scores_dict.get("accuracy"),
        f"{prefix}_evidence": scores_dict.get("evidenceGrounding"),
        f"{prefix}_ambiguity": scores_dict.get("ambiguityHandling"),
        f"{prefix}_capability": scores_dict.get("capabilityCompliance"),
        f"{prefix}_diversity": scores_dict.get("diversityNaturalness"),
    }


def parse_line(line):
    """解析单行 JSON，提取关键字段，返回字典"""
    try:
        data = json.loads(line.strip())
    except json.JSONDecodeError as e:
        print(f"⚠️  跳过无效 JSON 行: {e}")
        return None

    candidate = data.get("candidate", {})
    judge_b = data.get("judgeB", {})
    judge_c = data.get("judgeC", {})

    # 提取评分
    b_scores = flatten_score(judge_b.get("scores", {}), "b")
    c_scores = flatten_score(judge_c.get("scores", {}), "c")

    row = {
        "id": data.get("id"),
        "source_text": candidate.get("sourceText", "").strip(),
        "expected_disposition": candidate.get("expectedDisposition"),
        "status": data.get("status"),
        "created_at": data.get("createdAt"),
        # 结构化事实（转为 JSON 字符串保持原样）
        "extracted_facts": json.dumps(candidate.get("extractedFacts", []), ensure_ascii=False),
        "assumptions": json.dumps(candidate.get("assumptions", []), ensure_ascii=False),
        "clarifications": json.dumps(candidate.get("clarifications", []), ensure_ascii=False),
        "unsupported_capabilities": json.dumps(candidate.get("unsupportedCapabilities", []), ensure_ascii=False),
        "tags": ", ".join(candidate.get("tags", [])),
        # Judge B
        "b_reason": judge_b.get("reason"),
        "b_passed": data.get("judgeBPassed"),
        **b_scores,
        # Judge C
        "c_reason": judge_c.get("reason"),
        "c_passed": data.get("judgeCPassed"),
        **c_scores,
        # 模型信息
        "generator_model": data.get("models", {}).get("generator"),
        "judgeB_model": data.get("models", {}).get("judgeB"),
        "judgeC_model": data.get("models", {}).get("judgeC"),
    }
    return row


def main():
    parser = argparse.ArgumentParser(description="将策略JSON文件解析为表格")
    parser.add_argument("-i", "--input", required=True, help="输入文件路径，如 'accepted - 副本.txt'")
    parser.add_argument("-o", "--output", required=True, help="输出文件路径，支持 .csv 或 .xlsx")
    args = parser.parse_args()

    input_path = Path(args.input)
    if not input_path.exists():
        print(f"❌ 文件不存在: {input_path}")
        return

    print(f"📂 读取文件: {input_path}")
    rows = []
    with open(input_path, "r", encoding="utf-8") as f:
        for line_num, line in enumerate(f, 1):
            if not line.strip():
                continue
            row = parse_line(line)
            if row:
                rows.append(row)
            else:
                print(f"⚠️  第 {line_num} 行解析失败，已跳过")

    if not rows:
        print("❌ 未解析到任何有效记录，请检查文件格式。")
        return

    df = pd.DataFrame(rows)
    print(f"✅ 成功解析 {len(df)} 条记录")

    # 按创建时间排序
    if "created_at" in df.columns:
        df = df.sort_values("created_at").reset_index(drop=True)

    output_path = Path(args.output)
    # 根据后缀选择导出格式
    if output_path.suffix.lower() == ".csv":
        df.to_csv(output_path, index=False, encoding="utf-8-sig")
    elif output_path.suffix.lower() in [".xlsx", ".xls"]:
        df.to_excel(output_path, index=False, engine="openpyxl")
    else:
        print("⚠️  输出格式不支持，默认保存为 CSV")
        output_path = output_path.with_suffix(".csv")
        df.to_csv(output_path, index=False, encoding="utf-8-sig")

    print(f"📁 已保存至: {output_path}")
    print("\n📊 数据预览（前5行）：")
    print(df.head().to_string(index=False))


if __name__ == "__main__":
    main()