from __future__ import annotations

import unittest

import pandas as pd

from sw_industry_update import Instrument, normalize_definitions, normalize_memberships


class SwIndustryUpdateTest(unittest.TestCase):
    def test_normalizes_taxonomy_hierarchy_and_index_mapping(self) -> None:
        frame = pd.DataFrame([
            {"行业代码": "110000", "一级行业名称": "农林牧渔", "二级行业名称": "", "三级行业名称": ""},
            {"行业代码": "110100", "一级行业名称": "农林牧渔", "二级行业名称": "种植业", "三级行业名称": ""},
            {"行业代码": "110101", "一级行业名称": "农林牧渔", "二级行业名称": "种植业", "三级行业名称": "种子"},
        ])
        with self.assertRaisesRegex(RuntimeError, "incomplete"):
            normalize_definitions(
                frame,
                [{"swindexname": "农林牧渔", "swindexcode": "801010"}],
            )

    def test_seeds_sw2021_at_taxonomy_start_and_builds_scd(self) -> None:
        definitions = [
            {"industry_code": "110000"},
            {"industry_code": "110100"},
            {"industry_code": "110101"},
            {"industry_code": "110102"},
        ]
        frame = pd.DataFrame([
            {"股票代码": "000001", "计入日期": "2014-01-01", "行业代码": "110101", "更新日期": "2020-01-01"},
            {"股票代码": "000001", "计入日期": "2023-01-02", "行业代码": "110102", "更新日期": "2023-01-02"},
        ])
        memberships = normalize_memberships(
            frame,
            definitions,
            {"000001": Instrument(1, "000001", "active", None)},
        )
        self.assertEqual(len(memberships), 2)
        self.assertEqual(str(memberships[0]["effective_from"]), "2021-07-30 00:00:00")
        self.assertEqual(str(memberships[0]["effective_to"]), "2023-01-01 23:59:59.999000")
        self.assertEqual(memberships[1]["level3_code"], "110102")


if __name__ == "__main__":
    unittest.main()
