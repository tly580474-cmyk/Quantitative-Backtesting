"""Integration checks: run with the same Python and CJK font used by agents."""
import json
from pathlib import Path
import shutil
import unittest
import uuid
from researchPlot import render


class ResearchPlotTests(unittest.TestCase):
    def setUp(self):
        self.output = Path(__file__).resolve().parents[2] / "tmp_output" / "agent-runs" / ("plot-test-" + uuid.uuid4().hex)
        self.spec = {"type": "line", "title": "中文研究图", "source": "合成测试数据，非行情", "yLabel": "收益 (%)",
                     "series": [{"label": "测试序列", "x": ["一", "二", "三"], "y": [1, None, 2]}]}

    def tearDown(self):
        if self.output.exists(): shutil.rmtree(self.output)

    def test_all_chart_types(self):
        from PIL import Image
        for kind in ["line", "bar", "histogram", "nav-drawdown", "factor-layers", "heatmap"]:
            with self.subTest(kind=kind):
                spec = dict(self.spec, type=kind)
                if kind == "heatmap": spec.update(matrix=[[1,None],[2,3]],x=["甲","乙"],y=["丙","丁"])
                result = render(spec, self.output / (kind + ".png"))
                self.assertTrue(result["font"])
                with Image.open(result["path"]) as img:
                    self.assertEqual(img.size, (1350,810))
                    img.verify()

    def test_decoration_budget_does_not_block_corrections(self):
        path = self.output / "budget.png"
        render(self.spec, path)
        render(self.spec, path, "decoration")
        with self.assertRaisesRegex(ValueError, "budget"): render(self.spec, path, "decoration")
        render(self.spec, path, "correctness")
        self.assertEqual(json.loads(path.with_suffix('.plot.json').read_text())["decorations"],1)

    def test_invalid_values_and_paths(self):
        with self.assertRaisesRegex(ValueError, "output"): render(self.spec, self.output / ".." / ".." / ".." / "outside.png")
        spec = dict(self.spec, series=[{"x":[1],"y":[float("inf")]}])
        with self.assertRaisesRegex(ValueError, "finite"): render(spec, self.output / "invalid.png")
        with self.assertRaisesRegex(ValueError, "required"): render(dict(self.spec,source=""), self.output / "no-source.png")


if __name__ == '__main__': unittest.main()
