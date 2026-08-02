#!/usr/bin/env python3
"""Compare the M5 NumPy reference and VectorBT screening runtimes.

This is a compatibility/throughput drill only. It deliberately compares
signal hashes and rankings; neither runtime is allowed to emit an order book.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import math
import subprocess
import sys
import time
from pathlib import Path


def run(worker: Path, runtime: str, request: dict) -> tuple[dict, float]:
    payload = dict(request, runtime=runtime)
    started = time.perf_counter()
    completed = subprocess.run(
        [sys.executable, str(worker)],
        input=json.dumps(payload),
        text=True,
        capture_output=True,
        check=True,
    )
    return json.loads(completed.stdout), time.perf_counter() - started


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--points", type=int, default=2_000)
    parser.add_argument("--grid", type=int, default=200)
    args = parser.parse_args()
    prices = [100.0]
    for index in range(1, args.points):
        drift = 0.00025 + math.sin(index / 37.0) * 0.0015 + math.cos(index / 11.0) * 0.0007
        prices.append(prices[-1] * (1.0 + drift))
    grid = []
    for fast in range(2, 42):
        for slow in range(max(fast + 2, 10), 111, 5):
            grid.append({"fast": fast, "slow": slow})
            if len(grid) == args.grid:
                break
        if len(grid) == args.grid:
            break
    if len(grid) != args.grid:
        raise ValueError("requested grid is larger than the deterministic benchmark grid")
    canonical = json.dumps(prices, separators=(",", ":")).encode()
    request = {
        "specHash": hashlib.sha256(b"m5-vector-screen-benchmark-v1").hexdigest(),
        "datasetHash": hashlib.sha256(canonical).hexdigest(),
        "close": prices,
        "parameterGrid": grid,
    }
    worker = Path(__file__).with_name("worker.py")
    reference, reference_seconds = run(worker, "numpy_reference", request)
    vectorbt, vectorbt_seconds = run(worker, "vectorbt", request)
    reference_by_parameters = {
        json.dumps(item["parameters"], sort_keys=True): item for item in reference["candidates"]
    }
    mismatches = []
    for item in vectorbt["candidates"]:
        key = json.dumps(item["parameters"], sort_keys=True)
        expected = reference_by_parameters[key]
        if item["signalHash"] != expected["signalHash"]:
            mismatches.append({"parameters": item["parameters"], "kind": "signal_hash"})
    reference_ranking = [item["parameters"] for item in reference["candidates"]]
    vectorbt_ranking = [item["parameters"] for item in vectorbt["candidates"]]
    report = {
        "status": "passed" if not mismatches and reference_ranking == vectorbt_ranking else "failed",
        "authority": "screening_only",
        "points": args.points,
        "parameterGrid": args.grid,
        "numpyReferenceSeconds": round(reference_seconds, 6),
        "vectorbtSeconds": round(vectorbt_seconds, 6),
        "signalHashMismatches": mismatches,
        "rankingEqual": reference_ranking == vectorbt_ranking,
        "resultFields": sorted(vectorbt["candidates"][0].keys()),
    }
    json.dump(report, sys.stdout, ensure_ascii=False, indent=2)
    print()
    raise SystemExit(0 if report["status"] == "passed" else 1)


if __name__ == "__main__":
    main()
