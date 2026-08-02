#!/usr/bin/env python3
"""N2.3 sklearn 白名单模型执行 Worker。

输入（stdin JSON）：
  {
    "protocolVersion": "1.0",
    "spec": {
      "protocolVersion": "1.0",
      "modelType": "ridge" | "random_forest" | "gradient_boosting",
      "features": ["momentum_20", "reversal_5"],
      "labelHorizonDays": 5,
      "trainedThrough": "2026-06-10",
      "validationStartsAt": "2026-06-11",
      "seed": 42,
      "artifactHash": null,
      "hyperparameters": { "modelType": "ridge", "alpha": 1 }
    },
    "rows": [
      { "decisionDate": "2026-06-01", "instrumentKey": "000001", "features": {"momentum_20": 1.2, "reversal_5": -0.3}, "label": 0.05 }
    ]
  }

输出（stdout JSON）：
  {
    "protocolVersion": "1.0",
    "modelType": "ridge",
    "scores": [ { "decisionDate": "...", "instrumentKey": "...", "score": 1.234 } ],
    "artifact": { "sha256": "...", "byteSize": 123 }
  }

约束：
- 只允许白名单模型类型与受限超参（见 mlModelSchema.ts）
- 训练只用 decisionDate <= trainedThrough 且 label 非空的行；其余行只预测
- 固定 random_state，保证跨进程可复现
- 不执行任意用户代码，不使用 Python eval
"""
from __future__ import annotations

import hashlib
import io
import json
import pickle
import sys

import numpy as np

RIDGE = "ridge"
RANDOM_FOREST = "random_forest"
GRADIENT_BOOSTING = "gradient_boosting"


def build_model(spec: dict):
    model_type = spec["modelType"]
    hp = spec["hyperparameters"]
    seed = int(spec["seed"])
    if model_type == RIDGE:
        from sklearn.linear_model import Ridge
        return Ridge(alpha=float(hp["alpha"]), random_state=seed)
    if model_type == RANDOM_FOREST:
        from sklearn.ensemble import RandomForestRegressor
        return RandomForestRegressor(
            n_estimators=int(hp["nEstimators"]),
            max_depth=int(hp["maxDepth"]),
            min_samples_leaf=int(hp["minSamplesLeaf"]),
            random_state=seed,
            n_jobs=1,
        )
    if model_type == GRADIENT_BOOSTING:
        from sklearn.ensemble import GradientBoostingRegressor
        return GradientBoostingRegressor(
            n_estimators=int(hp["nEstimators"]),
            learning_rate=float(hp["learningRate"]),
            max_depth=int(hp["maxDepth"]),
            random_state=seed,
        )
    raise ValueError(f"unsupported model type: {model_type}")


def main() -> None:
    request = json.load(sys.stdin)
    if request.get("protocolVersion") != "1.0":
        raise ValueError("unsupported protocolVersion")
    spec = request["spec"]
    rows = request["rows"]
    features = list(spec["features"])
    if not features:
        raise ValueError("features must not be empty")
    trained_through = spec["trainedThrough"]
    label_horizon = int(spec["labelHorizonDays"])
    if label_horizon < 1:
        raise ValueError("labelHorizonDays must be positive")

    # 分离训练行与预测行（训练段：decisionDate <= trainedThrough 且 label 非空）
    train_rows = []
    predict_rows = []
    for row in rows:
        date = row["decisionDate"]
        has_label = row.get("label") is not None
        if date <= trained_through and has_label:
            train_rows.append(row)
        else:
            predict_rows.append(row)

    if not train_rows:
        raise ValueError("no training rows with labels before trainedThrough")

    def matrix(selected_rows: list[dict]) -> np.ndarray:
        array = np.zeros((len(selected_rows), len(features)), dtype=float)
        for i, row in enumerate(selected_rows):
            fv = row.get("features") or {}
            for j, feature in enumerate(features):
                value = fv.get(feature)
                array[i, j] = 0.0 if value is None else float(value)
        return array

    x_train = matrix(train_rows)
    y_train = np.asarray([float(row["label"]) for row in train_rows], dtype=float)
    if not np.all(np.isfinite(x_train)) or not np.all(np.isfinite(y_train)):
        raise ValueError("training features/labels must be finite")

    model = build_model(spec)
    model.fit(x_train, y_train)

    # 预测全部行（训练 + 预测段），保证分数行与输入行一一对应
    all_rows = rows
    x_all = matrix(all_rows)
    raw_scores = np.asarray(model.predict(x_all), dtype=float)
    if not np.all(np.isfinite(raw_scores)):
        raise ValueError("model produced non-finite scores")

    scores = [
        {"decisionDate": row["decisionDate"], "instrumentKey": row["instrumentKey"],
         "score": round(float(raw_scores[i]), 12)}
        for i, row in enumerate(all_rows)
    ]

    # 模型产物摘要（确定性：随机种子固定，pickle 字节应稳定）
    buffer = io.BytesIO()
    pickle.dump({"spec": spec, "model": model}, buffer)
    payload = buffer.getvalue()
    artifact = {
        "sha256": hashlib.sha256(payload).hexdigest(),
        "byteSize": len(payload),
    }

    json.dump({
        "protocolVersion": "1.0",
        "modelType": spec["modelType"],
        "scores": scores,
        "artifact": artifact,
    }, sys.stdout)


if __name__ == "__main__":
    main()
