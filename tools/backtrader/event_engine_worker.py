"""N1.2 事件驱动订单生命周期适配层：Backtrader 事件引擎运行时。

输入（stdin JSON）：
  {
    "protocolVersion": "1.0",
    "strategy": { "type": "dual_ma", "params": { "fast": 5, "slow": 20 } },
    "candles": [{ "time": "2025-01-02", "open": 100, "high": 101, "low": 99, "close": 100.5, "volume": 100000 }, ...],
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
    "authority": "screening_only",
    "publishable": false,
    "trades": [{ "time", "side", "quantity", "rawPrice", "fillPrice", "commission", "tax", "amount" }],
    "orders": [{ "time", "side", "quantity", "status" }],
    "finalEquity": number,
    "equityCurve": [{ "time", "equity" }]
  }

撮合口径与 TS 权威引擎（src/features/backtest/broker.ts + engine.ts）保持一致，
黄金样例一致性已由 backtraderGoldenParity.test.ts 锁定：
- T 日收盘生成信号，T+1 开盘成交
- 买入：数量 = 整手化(cash * positionSizing / 成交价)；循环减一手直到 amount+commission <= cash
- 卖出：按 positionSizing 比例卖出，剩余不足以成一手时全卖
- 佣金 = max(amount * commissionRate, minimumCommission)，4 位舍入
- 印花税 = amount * sellTaxRate（仅卖出），4 位舍入
- 滑点：买入 open*(1+slip)，卖出 open*(1-slip)

本运行时只产出事件驱动成交记录（screening_only），不产出可发布业绩。
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


class DualMaSignal:
    """双均线信号，与 TS dualMaStrategy 逻辑一致。"""

    def __init__(self, fast: int, slow: int):
        self.fast = fast
        self.slow = slow
        self.fast_ma = None
        self.slow_ma = None

    def warmup(self) -> int:
        return self.slow

    def init(self, strategy: bt.Strategy):
        self.fast_ma = bt.indicators.SimpleMovingAverage(strategy.data.close, period=self.fast)
        self.slow_ma = bt.indicators.SimpleMovingAverage(strategy.data.close, period=self.slow)

    def evaluate(self, strategy: bt.Strategy) -> str | None:
        prev_fast = self.fast_ma[-1]
        prev_slow = self.slow_ma[-1]
        curr_fast = self.fast_ma[0]
        curr_slow = self.slow_ma[0]
        if prev_fast is None or prev_slow is None or curr_fast is None or curr_slow is None:
            return None
        if prev_fast <= prev_slow and curr_fast > curr_slow:
            return "buy"
        if prev_fast >= prev_slow and curr_fast < curr_slow:
            return "sell"
        return None


def build_signal(strategy_type: str, params: dict):
    """白名单策略工厂：新增策略在此注册（N1.3）。"""
    if strategy_type == "dual_ma":
        fast = int(params.get("fast", 5))
        slow = int(params.get("slow", 20))
        if fast < 2 or slow <= fast:
            raise ValueError("moving-average windows require 2 <= fast < slow")
        return DualMaSignal(fast, slow)
    raise ValueError(f"unsupported strategy type: {strategy_type}")


class EventStrategy(bt.Strategy):
    params = (
        ("strategy_type", "dual_ma"),
        ("strategy_params", {}),
        ("position_sizing", 0.9),
        ("commission_rate", 0.0003),
        ("minimum_commission", 5.0),
        ("sell_tax_rate", 0.001),
        ("slippage_bps", 3),
        ("force_close_at_end", True),
        ("trading_unit_mode", "index"),
        ("minimum_trade_amount", 1.0),
    )

    def __init__(self):
        self.signal = build_signal(self.p.strategy_type, dict(self.p.strategy_params))
        self.signal.init(self)
        self.warmup_bars = self.signal.warmup()
        self.trades: list[dict] = []
        self.orders: list[dict] = []
        self.equity_curve: list[dict] = []
        self.cash: float = float(self.broker.getcash())
        self.position_qty: int = 0

    def next(self):
        # 记录每日权益（现金 + 持仓 × 收盘价），与 TS equityCurve 口径一致
        self.equity_curve.append({
            "time": self.data.datetime.date(0).isoformat(),
            "equity": round(self.cash + self.position_qty * float(self.data.close[0]), 4),
        })

        if len(self) < self.warmup_bars:
            return

        last_bar = len(self.data) == self.data.buflen() - 1
        signal = self.signal.evaluate(self)
        if signal is None or last_bar:
            return

        next_open = self.data.open[1]
        if next_open is None or not math.isfinite(next_open) or next_open <= 0:
            return

        if signal == "buy" and self.position_qty == 0:
            next_open_price = float(next_open)
            if self.p.trading_unit_mode == "index":
                # 指数/ETF：金额单位撮合，允许小数份额（与 TS broker.ts index 口径一致）
                fill_price = apply_slippage(next_open_price, "buy", self.p.slippage_bps)
                min_amount = max(1.0, float(self.p.minimum_trade_amount or 1))
                spend_limit = self.cash * self.p.position_sizing
                max_amount = math.floor(spend_limit / min_amount) * min_amount
                if max_amount < min_amount:
                    self.orders.append({"time": self.data.datetime.date(0).isoformat(), "side": "buy", "quantity": 0, "status": "rejected"})
                    return
                amount = max_amount
                commission = calculate_commission(amount, self.p.commission_rate, self.p.minimum_commission)
                if amount + commission > self.cash:
                    affordable = math.floor(min(self.cash - self.p.minimum_commission, self.cash / (1 + self.p.commission_rate)) / min_amount) * min_amount
                    if affordable < min_amount:
                        self.orders.append({"time": self.data.datetime.date(0).isoformat(), "side": "buy", "quantity": 0, "status": "rejected"})
                        return
                    amount = min(amount, affordable)
                    commission = calculate_commission(amount, self.p.commission_rate, self.p.minimum_commission)
                size = amount / fill_price
                if size <= 0:
                    self.orders.append({"time": self.data.datetime.date(0).isoformat(), "side": "buy", "quantity": 0, "status": "rejected"})
                    return
                self.buy(size=size)
                self.orders.append({"time": self.data.datetime.date(0).isoformat(), "side": "buy", "quantity": round(size, 4), "status": "submitted"})
            else:
                fill_price = apply_slippage(next_open_price, "buy", self.p.slippage_bps)
                spend_limit = self.cash * self.p.position_sizing
                size = normalize_stock_buy(spend_limit / fill_price)
                if size < 100:
                    self.orders.append({"time": self.data.datetime.date(0).isoformat(), "side": "buy", "quantity": 0, "status": "rejected"})
                    return
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
        elif signal == "sell" and self.position_qty > 0:
            requested = self.position_qty * self.p.position_sizing
            if self.p.trading_unit_mode == "index":
                # 指数/ETF：允许小数份额，尾仓按最小交易金额判定（与 TS engine.ts createSellOrder 一致）
                partial = requested if requested > 0 else 0.0
                remaining = self.position_qty - partial
                min_amount = max(1.0, float(self.p.minimum_trade_amount or 1))
                remaining_is_tradable = remaining * float(next_open) >= min_amount
                size = min(partial, self.position_qty) if remaining_is_tradable else self.position_qty
            else:
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
            signed_qty = float(order.executed.size)
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
        self.equity_curve.append({
            "time": self.data.datetime.date(0).isoformat(),
            "equity": round(self.cash + self.position_qty * float(self.data.close[0]), 4),
        })


class MoneyCommission(bt.CommInfoBase):
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
        EventStrategy,
        strategy_type=strategy["type"],
        strategy_params=strategy.get("params", {}),
        position_sizing=config["positionSizing"],
        commission_rate=config["commissionRate"],
        minimum_commission=config["minimumCommission"],
        sell_tax_rate=config["sellTaxRate"],
        slippage_bps=config["slippageBps"],
        force_close_at_end=config["forceCloseAtEnd"],
        trading_unit_mode=config.get("tradingUnitMode", "index"),
        minimum_trade_amount=config.get("minimumTradeAmount", 1),
    )
    cerebro.broker.setcash(config["initialCapital"])
    cerebro.broker.addcommissioninfo(
        MoneyCommission(
            commission=config["commissionRate"],
            minimum_commission=config["minimumCommission"],
        )
    )
    cerebro.broker.set_slippage_perc(
        perc=config["slippageBps"] / 10000,
        slip_open=True,
        slip_match=False,
        slip_out=False,
    )

    results = cerebro.run()
    strat = results[0]

    final_equity = strat.cash + strat.position_qty * float(strat.data.close[0])

    return {
        "protocolVersion": "1.0",
        "runtime": "backtrader",
        "authority": "screening_only",
        "publishable": False,
        "trades": strat.trades,
        "orders": strat.orders,
        "equityCurve": strat.equity_curve,
        "finalEquity": round(final_equity, 4),
    }


def main() -> None:
    request = json.load(sys.stdin)
    result = run(request)
    json.dump(result, sys.stdout)


if __name__ == "__main__":
    main()
