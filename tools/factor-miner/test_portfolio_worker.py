import unittest

import numpy as np

from portfolio_worker import optimize


class PortfolioWorkerTest(unittest.TestCase):
    def payload(self):
        rng = np.random.default_rng(7)
        assets = []
        for i in range(40):
            assets.append({
                "instrumentKey": i + 1,
                "alpha": 1 - i / 100,
                "industry": f"I{i % 5}",
                "sizeExposure": (i - 20) / 20,
                "liquidityExposure": (20 - i) / 20,
                "adv20": 20_000_000,
                "benchmarkWeight": 1 / 40,
            })
        return {"assets": assets, "returns": rng.normal(0, 0.01, (120, 40)).tolist(),
                "constraints": {"maxOneWayTurnover": 1.0}}

    def test_two_stage_result_has_exactly_thirty_names_and_respects_bounds(self):
        result = optimize(self.payload())
        self.assertEqual(result["status"], "solved", result)
        self.assertEqual(len(result["weights"]), 30)
        weights = [row["weight"] for row in result["weights"]]
        self.assertAlmostEqual(sum(weights), 1.0, places=6)
        self.assertGreaterEqual(min(weights), 0.01 - 1e-6)
        self.assertLessEqual(max(weights), 0.05 + 1e-6)

    def test_failure_is_explicit_and_never_falls_back_to_equal_weight(self):
        payload = self.payload()
        payload["assets"] = payload["assets"][:20]
        result = optimize(payload)
        self.assertEqual(result["status"], "failed")
        self.assertEqual(result["weights"], [])


if __name__ == "__main__":
    unittest.main()
