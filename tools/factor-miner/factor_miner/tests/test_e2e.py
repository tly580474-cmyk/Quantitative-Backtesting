"""端到端冒烟测试：在合成数据上跑通最小进化并产出候选因子。"""
from __future__ import annotations

from factor_miner.engine.evolve import evolve
from factor_miner.tree.serialize import from_prefix, to_formula


def test_synthetic_e2e(cfg, panels, tmp_path):
    cfg["evolution"]["generations"] = 4
    cfg["evolution"]["population_size"] = 30
    cfg["evolution"]["checkpoint_freq"] = 2
    cfg["report"]["out_dir"] = str(tmp_path / "output")

    best, trace = evolve(cfg, panels, ckpt_path=str(tmp_path / "ckpt.pkl"))
    assert best is not None
    assert len(trace) >= 1
    # 每代记录关键统计
    rec = trace[0]
    for k in ("generation", "best_train_fitness", "best_val_fitness", "diversity"):
        assert k in rec
    # 最优个体可序列化与可读
    assert isinstance(to_formula(best), str)
    # 候选表达式非空
    assert any(r["best_prefix"] for r in trace)


def test_same_snapshot_config_and_seed_reproduce_same_trace(cfg, panels, tmp_path):
    cfg["evolution"].update({"generations": 2, "population_size": 16, "n_jobs": 1,
                             "seed": 12345, "seed_factors": []})
    _, first = evolve(cfg, panels, ckpt_path=str(tmp_path / "first.pkl"))
    _, second = evolve(cfg, panels, ckpt_path=str(tmp_path / "second.pkl"))
    assert [row["best_prefix"] for row in first] == [row["best_prefix"] for row in second]
    assert [row["best_train_fitness"] for row in first] == [row["best_train_fitness"] for row in second]
    assert [row["best_val_fitness"] for row in first] == [row["best_val_fitness"] for row in second]
