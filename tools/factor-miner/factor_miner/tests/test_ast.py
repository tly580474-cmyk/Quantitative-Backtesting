from __future__ import annotations

import json
from pathlib import Path

import pandas as pd
import pytest

from factor_miner.engine.evaluator import evaluate_tree
from factor_miner.tree.ast import to_ast_expression
from factor_miner.tree.serialize import from_prefix


def test_gp_tree_converts_to_versioned_ast():
    expression = to_ast_expression(from_prefix("(neg (ts_mean returns 5))"))
    assert expression["type"] == "ast"
    assert expression["version"] == 1
    assert expression["root"]["op"] == "neg"
    rolling = expression["root"]["args"][0]
    assert rolling["op"] == "ts_mean"
    assert rolling["window"] == 5
    assert len(rolling["args"]) == 1


def test_terminal_names_are_mapped_to_snapshot_schema():
    expression = to_ast_expression(from_prefix("(ts_mean turnover 20)"))
    terminal = expression["root"]["args"][0]
    assert terminal["name"] == "turnoverRatePct"


def test_unsupported_gp_operator_is_rejected():
    with pytest.raises(ValueError, match="不支持算子"):
        to_ast_expression(from_prefix("(ts_corr close volume 20)"))


def test_python_matches_shared_duckdb_parity_fixture():
    fixture_candidates = []
    for ancestor in Path(__file__).resolve().parents:
        fixture_candidates.extend([
            ancestor / "server" / "src" / "factorResearch" / "engine"
            / "factorAstParity.fixture.json",
            ancestor / "量化回测" / "server" / "src" / "factorResearch" / "engine"
            / "factorAstParity.fixture.json",
        ])
    fixture_path = next(path for path in fixture_candidates if path.exists())
    fixture = json.loads(fixture_path.read_text(encoding="utf-8"))
    rows = fixture["rows"]
    index = pd.MultiIndex.from_arrays(
        [["fixture"] * len(rows), pd.to_datetime([row["tradeDate"] for row in rows])],
        names=["symbol", "trade_date"],
    )
    panel = pd.DataFrame({
        "close": [row["close"] for row in rows],
        "previousClose": [row["previousClose"] for row in rows],
        "log_mktcap": [row["logMktCap"] for row in rows],
    }, index=index)
    panel["returns"] = panel["close"] / panel["previousClose"] - 1.0
    actual = evaluate_tree(from_prefix(fixture["gpPrefix"]), panel)
    compare = actual[index.get_level_values("trade_date") >= pd.Timestamp(fixture["compareFrom"])]
    assert compare.to_list() == pytest.approx(fixture["expected"], abs=fixture["tolerance"])
    scalar = evaluate_tree(from_prefix(fixture["scalarGpPrefix"]), panel)
    assert scalar.to_list() == pytest.approx(fixture["scalarExpected"], abs=fixture["tolerance"])
    neutral_index = pd.MultiIndex.from_arrays(
        [[f"S{i}" for i in range(len(rows))], [pd.Timestamp("2024-01-02")] * len(rows)],
        names=["symbol", "trade_date"],
    )
    neutral_panel = pd.DataFrame({"close": [row["close"] for row in rows],
                                  "log_mktcap": [row["logMktCap"] for row in rows]},
                                 index=neutral_index)
    neutral = evaluate_tree(from_prefix(fixture["neutralGpPrefix"]), neutral_panel)
    assert neutral.to_list() == pytest.approx(fixture["neutralExpected"], abs=1e-10)
    rank_index = pd.MultiIndex.from_arrays(
        [[f"R{i}" for i in range(len(fixture["rankValues"]))],
         [pd.Timestamp("2024-01-02")] * len(fixture["rankValues"])],
        names=["symbol", "trade_date"],
    )
    rank_panel = pd.DataFrame({"close": fixture["rankValues"]}, index=rank_index)
    ranked = evaluate_tree(from_prefix(fixture["rankGpPrefix"]), rank_panel)
    for actual, expected in zip(ranked.to_list(), fixture["rankExpected"]):
        assert (pd.isna(actual) and expected is None) or actual == pytest.approx(expected)
