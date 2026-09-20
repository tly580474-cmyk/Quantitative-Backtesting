"""Bounded, repeatable research charts. Run --help for the JSON contract."""
import argparse
import hashlib
import json
import math
import os
from pathlib import Path


def render(spec, output, revision="initial", font=None):
    import matplotlib
    matplotlib.use("Agg")
    import matplotlib.pyplot as plt
    from matplotlib import font_manager

    root = Path(__file__).resolve().parents[2]
    output = Path(output).resolve()
    if not output.is_relative_to(root / "tmp_output" / "agent-runs") or output.suffix != ".png":
        raise ValueError("output must be a PNG inside tmp_output/agent-runs/<runId>")
    if not all(isinstance(spec.get(key), str) and spec[key].strip() for key in ["title", "source", "yLabel"]):
        raise ValueError("title, source and yLabel (including units) are required")
    kind = spec.get("type")
    if kind not in ["line", "bar", "histogram", "heatmap", "nav-drawdown", "factor-layers"]:
        raise ValueError("unsupported chart type")
    bundled_font = root / "tmp_output" / "fonts" / "wqy-microhei.ttc"
    if not font and bundled_font.is_file(): font = str(bundled_font)
    if font:
        font_manager.fontManager.addfont(font)
        family = font_manager.FontProperties(fname=font).get_name()
    else:
        families = {f.name for f in font_manager.fontManager.ttflist}
        family = next((f for f in ["Noto Sans CJK SC", "WenQuanYi Micro Hei", "Microsoft YaHei", "SimHei", "PingFang SC"] if f in families), None)
    if not family and any("\u3400" <= c <= "\u9fff" for c in json.dumps(spec, ensure_ascii=False)):
        raise ValueError("Chinese font unavailable; install a CJK font or provide --font")
    plt.rcParams.update({"font.family": family or "DejaVu Sans", "axes.unicode_minus": False,
                         "axes.spines.top": False, "axes.spines.right": False, "font.size": 10})
    meta_path = output.with_suffix(".plot.json")
    previous = json.loads(meta_path.read_text()) if meta_path.exists() else {}
    decorations = previous.get("decorations", 0) + (revision == "decoration")
    if decorations > 1:
        raise ValueError("Decoration budget exhausted; correctness fixes remain allowed")
    if output.exists() and revision == "initial":
        raise ValueError("Output exists; choose correctness or decoration revision explicitly")
    fig, axes = plt.subplots(2 if kind == "nav-drawdown" else 1, 1, figsize=(10, 6), layout="constrained")
    ax = axes[0] if kind == "nav-drawdown" else axes
    try:
        if kind == "heatmap":
            matrix = spec.get("matrix", [])
            if not matrix or len(matrix) > 60 or not matrix[0] or len(matrix[0]) > 60 or any(len(r) != len(matrix[0]) for r in matrix):
                raise ValueError("heatmap requires a rectangular matrix no larger than 60x60")
            values = [[number(v) for v in row] for row in matrix]
            fig.colorbar(ax.imshow(values, aspect="auto", cmap="RdYlBu_r"), ax=ax, label=spec["yLabel"])
            if len(spec.get("x", [])) != len(matrix[0]) or len(spec.get("y", [])) != len(matrix):
                raise ValueError("heatmap labels must match matrix")
            ax.set_xticks(range(len(matrix[0])), spec["x"], rotation=45, ha="right")
            ax.set_yticks(range(len(matrix)), spec["y"])
        else:
            series = spec.get("series", [])
            if not 1 <= len(series) <= 8:
                raise ValueError("requires 1..8 series")
            for item in series:
                values = [number(v) for v in item.get("y", [])]
                x = item.get("x", [])
                if not 1 <= len(values) <= 5000 or (kind != "histogram" and len(x) != len(values)):
                    raise ValueError("series needs 1..5000 values and matching x")
                label = item.get("label", "")
                if kind in ["bar", "factor-layers"]:
                    if len(series) != 1: raise ValueError("bar chart accepts one series; use separate charts for comparisons")
                    ax.bar(x, values, color="#2563eb", label=label)
                elif kind == "histogram": ax.hist([v for v in values if math.isfinite(v)], bins=30, alpha=.6, label=label)
                else: ax.plot(x, values, label=label, linewidth=1.7)
                if kind == "nav-drawdown":
                    peak = 0
                    drawdown = []
                    for value in values:
                        if math.isfinite(value) and value <= 0: raise ValueError("NAV must be positive; null remains a gap")
                        if math.isfinite(value): peak = max(peak, value)
                        drawdown.append((value / peak - 1) * 100 if peak else float("nan"))
                    axes[1].plot(x, drawdown, label=label)
                    axes[1].set_ylabel("回撤 (%)")
                if kind != "histogram" and len(x) > 12:
                    ticks = list(range(0, len(x), max(1, len(x)//8)))
                    ax.set_xticks(ticks, [str(x[i]) for i in ticks], rotation=30, ha="right")
                    if kind == "nav-drawdown": axes[1].set_xticks(ticks, [str(x[i]) for i in ticks], rotation=30, ha="right")
            if any(item.get("label") for item in series): ax.legend(loc="best", frameon=False)
        ax.set_title(spec["title"], loc="left", fontweight="bold")
        ax.set_ylabel(spec["yLabel"])
        ax.set_xlabel(spec.get("xLabel", ""))
        if kind != "heatmap": ax.grid(axis="y", alpha=.2)
        fig.supxlabel("来源：" + spec["source"][:180], fontsize=8)
        output.parent.mkdir(parents=True, exist_ok=True)
        temporary = output.with_suffix(".partial.png")
        fig.savefig(temporary, dpi=135)
        if temporary.stat().st_size > 2*1024*1024:
            temporary.unlink()
            raise ValueError("chart exceeds report image size limit")
        os.replace(temporary, output)
        metadata = {"path": str(output), "font": family, "type": kind, "decorations": decorations,
                    "revision": revision, "source": spec["source"], "specSha256": hashlib.sha256(json.dumps(spec, sort_keys=True).encode()).hexdigest(),
                    "pngSha256": hashlib.sha256(output.read_bytes()).hexdigest()}
        meta_path.write_text(json.dumps(metadata, ensure_ascii=False, indent=2), encoding="utf-8")
        return metadata
    finally:
        plt.close(fig)


def number(value):
    if value is None: return float("nan")
    if isinstance(value, bool) or not isinstance(value, (float, int)) or not math.isfinite(value):
        raise ValueError("numbers must be finite; missing values must be null")
    return value


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description='JSON: {type,title,source,yLabel,xLabel?,series:[{label,x:[],y:[]}]} or heatmap {matrix,x,y}. Types: line,bar,histogram,heatmap,nav-drawdown,factor-layers. Missing values=null. Output only under tmp_output/agent-runs.')
    parser.add_argument("--input", required=True)
    parser.add_argument("--output", required=True)
    parser.add_argument("--font")
    parser.add_argument("--revision", choices=["initial", "correctness", "decoration"], default="initial")
    args = parser.parse_args()
    print(json.dumps(render(json.loads(Path(args.input).read_text(encoding="utf-8")), args.output, args.revision, args.font), ensure_ascii=False))
