#!/usr/bin/env python3
"""M5 non-authoritative vectorized candidate screener.

The worker emits candidate parameters and signal hashes only. It never emits an
authoritative order ledger, cash balance, or publishable performance result.
"""

from __future__ import annotations

import hashlib
import json
import math
import sys
import uuid
from datetime import datetime, timezone

import numpy as np


def moving_average(values: np.ndarray, window: int) -> np.ndarray:
    result = np.full(values.shape, np.nan, dtype=float)
    if window > len(values):
        return result
    cumulative = np.cumsum(np.insert(values, 0, 0.0))
    result[window - 1 :] = (cumulative[window:] - cumulative[:-window]) / window
    return result


def vectorbt_moving_averages(values: np.ndarray, windows: list[int]) -> dict[int, np.ndarray]:
    import pandas as pd
    import vectorbt as vbt

    series = pd.Series(values)
    frame = vbt.MA.run(series, window=windows).ma
    return {window: np.asarray(frame[window], dtype=float) for window in windows}


def main() -> None:
    request = json.load(sys.stdin)
    runtime = request["runtime"]
    prices = np.asarray(request["close"], dtype=float)
    if prices.ndim != 1 or len(prices) < 3 or not np.all(np.isfinite(prices)) or np.any(prices <= 0):
        raise ValueError("close must be a finite, positive one-dimensional series")
    spec_hash = request["specHash"]
    dataset_hash = request["datasetHash"]
    if len(spec_hash) != 64 or len(dataset_hash) != 64:
        raise ValueError("specHash and datasetHash must be SHA-256 values")

    returns = np.zeros_like(prices)
    returns[1:] = prices[1:] / prices[:-1] - 1.0
    normalized_grid = []
    for item in request["parameterGrid"]:
        fast, slow = int(item["fast"]), int(item["slow"])
        if fast < 2 or slow <= fast:
            raise ValueError("moving-average windows require 2 <= fast < slow")
        normalized_grid.append((fast, slow))
    windows = sorted({window for pair in normalized_grid for window in pair})
    if runtime == "vectorbt":
        moving_averages = vectorbt_moving_averages(prices, windows)
    elif runtime == "numpy_reference":
        moving_averages = {window: moving_average(prices, window) for window in windows}
    else:
        raise ValueError(f"unsupported runtime: {runtime}")

    candidates = []
    for fast, slow in normalized_grid:
        fast_ma, slow_ma = moving_averages[fast], moving_averages[slow]
        raw_signal = np.nan_to_num(fast_ma > slow_ma, nan=False)
        shifted_signal = np.zeros_like(raw_signal, dtype=bool)
        shifted_signal[1:] = raw_signal[:-1]
        screened_returns = returns * shifted_signal.astype(float)
        active = screened_returns[shifted_signal]
        volatility = float(np.std(active)) if len(active) else 0.0
        score = float(np.mean(active) / volatility * math.sqrt(252)) if volatility > 0 else 0.0
        parameters = {"fast": fast, "slow": slow}
        identity = f"{spec_hash}:{dataset_hash}:{fast}:{slow}"
        candidates.append({
            "protocolVersion": "1.0",
            "candidateId": str(uuid.uuid5(uuid.NAMESPACE_URL, identity)),
            "sourceRuntime": runtime,
            "specHash": spec_hash,
            "datasetHash": dataset_hash,
            "parameters": parameters,
            "screeningScore": score,
            "signalHash": hashlib.sha256(shifted_signal.tobytes()).hexdigest(),
            "createdAt": datetime.now(timezone.utc).isoformat().replace("+00:00", "Z"),
            "authority": "screening_only",
        })
    candidates.sort(key=lambda item: (-item["screeningScore"], item["parameters"]["fast"], item["parameters"]["slow"]))
    json.dump({"protocolVersion": "1.0", "runtime": runtime, "candidates": candidates}, sys.stdout)


if __name__ == "__main__":
    main()
