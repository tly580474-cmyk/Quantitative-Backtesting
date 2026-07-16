from __future__ import annotations

import unittest

from index_constituents_derive import derive_weight_values, half_l1_pct


class IndexConstituentDeriveTest(unittest.TestCase):
    def test_derives_normalized_price_drift_weights(self) -> None:
        result = derive_weight_values(
            {"000001": 60.0, "000002": 40.0},
            {"000001": 1, "000002": 2},
            {1: (10.0, "2025-01-01"), 2: (20.0, "2025-01-01")},
            {1: (11.0, "2025-01-31"), 2: (18.0, "2025-01-31")},
        )
        self.assertAlmostEqual(sum(result.values()), 100.0)
        self.assertAlmostEqual(result["000001"], 64.7058823529)
        self.assertAlmostEqual(result["000002"], 35.2941176471)

    def test_half_l1_includes_added_and_removed_members(self) -> None:
        self.assertAlmostEqual(
            half_l1_pct(
                {"000001": 60.0, "000002": 40.0},
                {"000001": 55.0, "000003": 45.0},
            ),
            45.0,
        )


if __name__ == "__main__":
    unittest.main()
