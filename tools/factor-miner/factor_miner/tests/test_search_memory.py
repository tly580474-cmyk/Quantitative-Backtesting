from factor_miner.analysis.search_memory import candidate_family_signature, is_blocked_direction
from factor_miner.tree.serialize import from_prefix


def test_related_windows_share_a_family_but_direction_is_distinct():
    first = from_prefix("(add (ts_mean returns 10) 1)")
    related = from_prefix("(add 2 (ts_mean returns 15))")
    higher = candidate_family_signature(first, "higher-is-better")
    assert higher == "222684749b85e5377a2c670adfbbadb147327fd0924fc31471465e0e83e381db"
    assert higher == candidate_family_signature(related, "higher-is-better")
    assert higher != candidate_family_signature(first, "lower-is-better")


def test_invalid_direction_is_removed_from_fitness_search():
    node = from_prefix("(ts_mean returns 10)")
    blocked = candidate_family_signature(node, "higher-is-better")
    cfg = {"search_memory": {"blocked_family_signatures": [blocked]}}
    assert is_blocked_direction(node, 0.02, cfg)
    assert not is_blocked_direction(node, -0.02, cfg)
