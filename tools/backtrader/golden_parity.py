"""N1.1 黄金样例：Backtrader 事件引擎与 TS 权威引擎一致性复现。

输入（stdin JSON）：
  {
    "candles": [{ "time": "2025-01-02", "open": 100, "high": 101, "low": 99, "close": 100.5, "volume": 100000 }, ...],
    "strategy": { "type": "dual_ma", "fast": 5, "slow": 20 },
    "config": {
      "initialCapital": 100000,
      "positionSizing": 0.9,
      "commissionRate": 0.0003,
      "minimumCommission": 5,
      "sellTaxRate": 0.001,
      "slippageBps": 3,
      "tradingUnitMode": "stock",
      "forceCloseAtEnd": true
    }
  }

输出（stdout JSON）：
  {
    "protocolVersion": "1.0",
    "runtime": "backtrader",
    "trades": [{ "time", "side", "quantity", "rawPrice", "fillPrice", "commission", "tax", "amount" }],
    "finalEquity": number,
    "orders": [{ "time", "side", "quantity", "status" }]
  }

撮合口径与 TS 引擎（src/features/backtest/broker.ts + engine.ts）对齐：
- T 日收盘生成信号，T+1 开盘成交
- 买入：数量 = 整手化(cash * positionSizing / 成交价)；循环减一手直到 amount+commission <= cash
- 卖出：数量 = 持仓（positionSizing=1 时全卖）；整手化
- 佣金 = max(amount * commissionRate, minimumCommission)，4 位舍入
- 印花税 = amount * sellTaxRate（仅卖出），4 位舍入
- 滑点：买入 open*(1+slip)，卖出 open*(1-slip)
"""
from __future__ import annotations

import json
import math
import sys

import backtrader as bt


def round_money(value: float) -> float:
    return round(value + 1e-12, 4)


def apply_slippage(price: float, side: str, slippage_bps: float) -> float:
    factor = slippage_bps / 10000.0
    return price * (1 + factor) if side == "buy" else price * (1 - factor)


def calculate_commission(amount: float, rate: float, minimum: float) -> float:
    if amount <= 0 or not math.isfinite(amount):
        return 0.0
    return round_money(max(amount * rate, minimum))


def calculate_sell_tax(amount: float, tax_rate: float) -> float:
    if amount <= 0 or not math.isfinite(amount):
        return 0.0
    return round_money(amount * tax_rate)


def normalize_stock_buy(quantity: float) -> int:
    if not math.isfinite(quantity) or quantity <= 0:
        return 0
    return int(quantity // 100) * 100


def normalize_stock_sell(quantity: float, position: int) -> int:
    if quantity <= 0 or position <= 0:
        return 0
    capped = min(quantity, position)
    if capped >= position:
        return position
    return int(capped // 100) * 100


class DualMaStrategy(bt.Strategy):
    params = (
        ("fast", 5),
        ("slow", 20),
        ("position_sizing", 0.9),
        ("commission_rate", 0.0003),
        ("minimum_commission", 5.0),
        ("sell_tax_rate", 0.001),
        ("slippage_bps", 3),
        ("force_close_at_end", True),
    )

    def __init__(self):
        self.fast_ma = bt.indicators.SimpleMovingAverage(self.data.close, period=self.p.fast)
        self.slow_ma = bt.indicators.SimpleMovingAverage(self.data.close, period=self.p.slow)
        self.trades: list[dict] = []
        self.orders: list[dict] = []
        self.cash: float = float(self.broker.getcash())
        self.position_qty: int = 0

    def next(self):
        # 在 bar T（收盘后）生成信号；订单在下一根 bar 开盘成交。
        if len(self) < self.p.slow:
            return
        prev_fast = self.fast_ma[-1]
        prev_slow = self.slow_ma[-1]
        curr_fast = self.fast_ma[0]
        curr_slow = self.slow_ma[0]

        if prev_fast is None or prev_slow is None or curr_fast is None or curr_slow is None:
            return

        last_bar = len(self.data) == self.data.buflen() - 1

        signal: str | None = None
        if prev_fast <= prev_slow and curr_fast > curr_slow and self.position_qty == 0:
            signal = "buy"
        elif prev_fast >= prev_slow and curr_fast < curr_slow and self.position_qty > 0:
            signal = "sell"

        if signal is None or last_bar:
            return

        next_open = self.data.open[1]  # 下一根 bar 开盘价（backtrader 预加载后可访问）
        if next_open is None or not math.isfinite(next_open) or next_open <= 0:
            return

        if signal == "buy":
            fill_price = apply_slippage(float(next_open), "buy", self.p.slippage_bps)
            spend_limit = self.cash * self.p.position_sizing
            size = normalize_stock_buy(spend_limit / fill_price)
            if size < 100:
                self.orders.append({"time": self.data.datetime.date(0).isoformat(), "side": "buy", "quantity": 0, "status": "rejected"})
                return
            # 循环减一手直到 amount + commission <= cash（与 TS fillBuy 一致）
            while size >= 100:
                amount = size * fill_price
                commission = calculate_commission(amount, self.p.commission_rate, self.p.minimum_commission)
                if amount + commission <= self.cash:
                    break
                size -= 100
            if size < 100:
                self.orders.append({"time": self.data.datetime.date(0).isoformat(), "side": "buy", "quantity": 0, "status": "rejected"})
                return
            self.buy(size=size)
            self.orders.append({"time": self.data.datetime.date(0).isoformat(), "side": "buy", "quantity": size, "status": "submitted"})
        elif signal == "sell":
            # 与 TS createSellOrder 对齐：按 positionSizing 比例卖出，剩余不足以成一手时全卖
            requested = self.position_qty * self.p.position_sizing
            partial = max(100, int(requested // 100) * 100) if requested > 0 else 0
            remaining = self.position_qty - partial
            remaining_is_tradable = remaining >= 100
            size = min(partial, self.position_qty) if remaining_is_tradable else self.position_qty
            if size <= 0:
                return
            self.sell(size=size)
            self.orders.append({"time": self.data.datetime.date(0).isoformat(), "side": "sell", "quantity": size, "status": "submitted"})

    def notify_order(self, order):
        if order.status not in (order.Completed, order.Rejected, order.Margin, order.Canceled):
            return
        exec_dt = getattr(order.executed, "dt", None)
        if exec_dt is None or isinstance(exec_dt, float):
            exec_time = self.data.datetime.date(0).isoformat()
        else:
            exec_time = exec_dt.date().isoformat()
        side = "buy" if order.isbuy() else "sell"
        if order.status == order.Completed:
            signed_qty = int(order.executed.size)  # buy 为正、sell 为负（backtrader 约定）
            price = float(order.executed.price)
            if side == "buy":
                raw_price = price / (1 + self.p.slippage_bps / 10000)
                amount = signed_qty * price
                commission = calculate_commission(amount, self.p.commission_rate, self.p.minimum_commission)
                tax = 0.0
                self.cash -= amount + commission
                self.position_qty += signed_qty
                abs_qty = signed_qty
            else:
                raw_price = price / (1 - self.p.slippage_bps / 10000)
                amount = -signed_qty * price
                commission = calculate_commission(amount, self.p.commission_rate, self.p.minimum_commission)
                tax = calculate_sell_tax(amount, self.p.sell_tax_rate)
                self.cash += amount - commission - tax
                self.position_qty += signed_qty
                abs_qty = -signed_qty
            self.trades.append({
                "time": exec_time,
                "side": side,
                "quantity": abs_qty,
                "rawPrice": round(raw_price, 4),
                "fillPrice": round(price, 4),
                "commission": commission,
                "tax": tax,
                "amount": round(amount, 4),
            })
        else:
            self.orders.append({"time": exec_time, "side": side, "quantity": 0, "status": order.getstatusname().lower()})

    def stop(self):
        if self.p.force_close_at_end:
            if self.position_qty > 0:
                price = float(self.data.close[0])
                amount = self.position_qty * price
                commission = calculate_commission(amount, self.p.commission_rate, self.p.minimum_commission)
                tax = calculate_sell_tax(amount, self.p.sell_tax_rate)
                self.cash += amount - commission - tax
                self.trades.append({
                    "time": self.data.datetime.date(0).isoformat(),
                    "side": "sell",
                    "quantity": self.position_qty,
                    "rawPrice": round(price, 4),
                    "fillPrice": round(price, 4),
                    "commission": commission,
                    "tax": tax,
                    "amount": round(amount, 4),
                    "forceClose": True,
                })
                self.orders.append({"time": self.data.datetime.date(0).isoformat(), "side": "sell", "quantity": self.position_qty, "status": "filled", "forceClose": True})
                self.position_qty = 0


class MoneyCommission(bt.CommInfoBase):
    """按金额百分比佣金 + 最低佣金，与 TS calculateCommission 对齐。"""

    params = (
        ("commission", 0.0003),
        ("minimum_commission", 5.0),
        ("stocklike", True),
        ("commtype", bt.CommInfoBase.COMM_PERC),
    )

    def _getcommission(self, size, price, pseudoexec):
        if not size:
            return 0.0
        amount = abs(size) * price
        return calculate_commission(amount, self.p.commission, self.p.minimum_commission)


def run(request: dict) -> dict:
    candles = request["candles"]
    strategy = request["strategy"]
    config = request["config"]

    cerebro = bt.Cerebro(stdstats=False)

    import pandas as pd

    df = pd.DataFrame({
        "open": [c["open"] for c in candles],
        "high": [c["high"] for c in candles],
        "low": [c["low"] for c in candles],
        "close": [c["close"] for c in candles],
        "volume": [c.get("volume", 100000) for c in candles],
    }, index=pd.to_datetime([c["time"] for c in candles]))
    data = bt.feeds.PandasData(dataname=df)
    cerebro.adddata(data)

    cerebro.addstrategy(
        DualMaStrategy,
        fast=strategy["fast"],
        slow=strategy["slow"],
        position_sizing=config["positionSizing"],
        commission_rate=config["commissionRate"],
        minimum_commission=config["minimumCommission"],
        sell_tax_rate=config["sellTaxRate"],
        slippage_bps=config["slippageBps"],
        force_close_at_end=config["forceCloseAtEnd"],
    )
    cerebro.broker.setcash(config["initialCapital"])
    cerebro.broker.addcommissioninfo(
        MoneyCommission(
            commission=config["commissionRate"],
            minimum_commission=config["minimumCommission"],
        )
    )
    # 滑点只作用于成交价（买入上浮、卖出下浮），与 TS applySlippage 一致
    cerebro.broker.set_slippage_perc(
        perc=config["slippageBps"] / 10000,
        slip_open=True,
        slip_match=False,
        slip_out=False,
    )

    results = cerebro.run()
    strat = results[0]

    # 与 TS 引擎 equityCurve 口径一致：现金 + 持仓 × 最后收盘价（强平后持仓为 0）
    final_equity = strat.cash + strat.position_qty * float(strat.data.close[0])

    return {
        "protocolVersion": "1.0",
        "runtime": "backtrader",
        "trades": strat.trades,
        "orders": strat.orders,
        "finalEquity": round(final_equity, 4),
    }


def main() -> None:
    request = json.load(sys.stdin)
    result = run(request)
    json.dump(result, sys.stdout)


if __name__ == "__main__":
    main()
