"""Deterministic JSON worker for the long-only factor portfolio optimizer."""
from __future__ import annotations

import json
import sys

import numpy as np
from scipy.optimize import minimize
from sklearn.covariance import LedoitWolf


def _failure(message: str) -> dict:
    return {"status": "failed", "message": message, "weights": [],
            "constraintMargins": {}, "risk": {}}


def optimize(payload: dict) -> dict:
    assets = payload.get("assets") or []
    if len(assets) < 30:
        return _failure("at least 30 eligible assets are required")
    returns = np.asarray(payload.get("returns"), dtype=float)
    if returns.ndim != 2 or returns.shape[1] != len(assets) or returns.shape[0] < 20:
        return _failure("returns must have at least 20 rows and one column per asset")
    if not np.isfinite(returns).all():
        return _failure("returns contain missing or non-finite values")

    alpha = np.asarray([float(a["alpha"]) for a in assets])
    order = np.argsort(-alpha, kind="stable")[: min(50, len(assets))]
    first = _solve([assets[i] for i in order], returns[:, order], payload, final=False)
    if first["status"] != "solved":
        return first
    first_w = np.asarray([x["weight"] for x in first["weights"]])
    keep_local = np.argsort(-first_w, kind="stable")[:30]
    keep = order[keep_local]
    keep_set = set(int(i) for i in keep)
    final_payload = dict(payload)
    final_payload["outsidePriorWeight"] = float(payload.get("outsidePriorWeight", 0)) + sum(
        float(asset.get("priorWeight", 0))
        for i, asset in enumerate(assets) if i not in keep_set)
    return _solve([assets[i] for i in keep], returns[:, keep], final_payload, final=True)


def _solve(assets: list[dict], returns: np.ndarray, payload: dict, final: bool) -> dict:
    n = len(assets)
    cfg = {
        "minWeight": 0.01 if final else 0.0,
        "maxWeight": 0.05,
        "industryDeviation": 0.10,
        "maxStyleExposure": 0.5,
        "maxAnnualVolatility": 0.25,
        "maxTrackingError": 0.15,
        "maxOneWayTurnover": 0.40,
        "maxAdvParticipation": 0.05,
        "capital": 1_000_000.0,
        "riskAversion": 4.0,
        "turnoverPenalty": 0.2,
        **(payload.get("constraints") or {}),
    }
    alpha = np.asarray([float(a["alpha"]) for a in assets])
    covariance = LedoitWolf().fit(returns).covariance_ * 252.0
    prior = np.asarray([float(a.get("priorWeight", 0)) for a in assets])
    outside_prior = float(payload.get("outsidePriorWeight", 0))
    size = np.asarray([float(a.get("sizeExposure", 0)) for a in assets])
    liquidity = np.asarray([float(a.get("liquidityExposure", 0)) for a in assets])
    benchmark = np.asarray([float(a.get("benchmarkWeight", 0)) for a in assets])
    if benchmark.sum() > 0:
        benchmark /= benchmark.sum()
    else:
        benchmark[:] = 1.0 / n

    lower = np.full(n, float(cfg["minWeight"]))
    upper = np.full(n, float(cfg["maxWeight"]))
    capital = float(cfg["capital"])
    for i, asset in enumerate(assets):
        adv_cap = float(asset.get("adv20", 0)) * float(cfg["maxAdvParticipation"]) / capital
        upper[i] = min(upper[i], prior[i] + max(0.0, adv_cap))
    if lower.sum() > 1 + 1e-9 or upper.sum() < 1 - 1e-9:
        return _failure("weight or capacity bounds are infeasible")

    industries = sorted({str(a.get("industry", "UNKNOWN")) for a in assets})
    industry_masks = {industry: np.asarray(
        [1.0 if str(a.get("industry", "UNKNOWN")) == industry else 0.0 for a in assets])
        for industry in industries}
    benchmark_industries = payload.get("benchmarkIndustryWeights") or {}
    constraints = [{"type": "eq", "fun": lambda w: np.sum(w) - 1.0}]
    style_limit = float(cfg["maxStyleExposure"])
    for exposure in (size, liquidity):
        constraints.extend([
            {"type": "ineq", "fun": lambda w, x=exposure: style_limit - np.dot(w, x)},
            {"type": "ineq", "fun": lambda w, x=exposure: style_limit + np.dot(w, x)},
        ])
    industry_limit = float(cfg["industryDeviation"])
    for industry_name, mask in industry_masks.items():
        benchmark_industry = float(benchmark_industries.get(
            industry_name, np.dot(benchmark, mask)))
        constraints.extend([
            {"type": "ineq", "fun": lambda w, m=mask, b=benchmark_industry:
             industry_limit - (np.dot(w, m) - b)},
            {"type": "ineq", "fun": lambda w, m=mask, b=benchmark_industry:
             industry_limit + (np.dot(w, m) - b)},
        ])
    max_vol = float(cfg["maxAnnualVolatility"])
    max_te = float(cfg["maxTrackingError"])
    max_turnover = float(cfg["maxOneWayTurnover"])
    constraints.extend([
        {"type": "ineq", "fun": lambda w: max_vol ** 2 - float(w @ covariance @ w)},
        {"type": "ineq", "fun": lambda w: max_te ** 2
         - float((w - benchmark) @ covariance @ (w - benchmark))},
        {"type": "ineq", "fun": lambda w: max_turnover
         - 0.5 * (outside_prior
                  + float(np.sum(np.sqrt((w - prior) ** 2 + 1e-12))))},
    ])

    def objective(w: np.ndarray) -> float:
        risk = float(w @ covariance @ w)
        turnover = float(np.sum(np.sqrt((w - prior) ** 2 + 1e-12)))
        return -(float(alpha @ w) - float(cfg["riskAversion"]) * risk
                 - float(cfg["turnoverPenalty"]) * turnover)

    x0 = np.clip(np.full(n, 1.0 / n), lower, upper)
    x0 += (1.0 - x0.sum()) * (upper - x0) / max(float((upper - x0).sum()), 1e-12)
    result = minimize(objective, x0, method="SLSQP", bounds=list(zip(lower, upper)),
                      constraints=constraints,
                      options={"ftol": 1e-10, "maxiter": 1000, "disp": False})
    if not result.success:
        return _failure(f"optimizer failed: {result.message}")
    w = np.asarray(result.x)
    vol = float(np.sqrt(max(0.0, w @ covariance @ w)))
    te = float(np.sqrt(max(0.0, (w - benchmark) @ covariance @ (w - benchmark))))
    turnover = 0.5 * (outside_prior + float(np.sum(np.abs(w - prior))))
    margins = {
        "fullInvestment": 1e-6 - abs(float(w.sum()) - 1),
        "annualVolatility": max_vol - vol,
        "trackingError": max_te - te,
        "oneWayTurnover": max_turnover - turnover,
        "sizeExposure": style_limit - abs(float(w @ size)),
        "liquidityExposure": style_limit - abs(float(w @ liquidity)),
    }
    for industry, mask in industry_masks.items():
        margins[f"industry:{industry}"] = industry_limit - abs(
            float(w @ mask) - float(benchmark_industries.get(
                industry, benchmark @ mask)))
    if min(margins.values()) < -1e-5:
        return _failure("optimizer returned a constraint-violating solution")
    return {
        "status": "solved",
        "message": str(result.message),
        "weights": [{"instrumentKey": a["instrumentKey"], "weight": float(weight)}
                    for a, weight in zip(assets, w)],
        "constraintMargins": margins,
        "risk": {"annualVolatility": vol, "trackingError": te,
                 "oneWayTurnover": turnover},
        "solver": {"name": "scipy-slsqp-ledoit-wolf", "iterations": int(result.nit)},
    }


if __name__ == "__main__":
    try:
        print(json.dumps(optimize(json.load(sys.stdin)), ensure_ascii=False))
    except Exception as exc:  # worker boundary must always return JSON
        print(json.dumps(_failure(str(exc)), ensure_ascii=False))
