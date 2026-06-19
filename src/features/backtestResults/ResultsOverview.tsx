import { Card, Row, Col, Statistic, Typography } from 'antd';
import type { BacktestMetrics } from '@/models';

const { Text } = Typography;

function pct(val: number): string {
  return `${(val * 100).toFixed(2)}%`;
}

function num(val: number, decimals = 2): string {
  return val.toFixed(decimals);
}

interface Props {
  metrics: BacktestMetrics;
  name: string;
  color?: string;
}

export default function ResultsOverview({ metrics, name, color }: Props) {
  return (
    <Card size="small" title={name} style={color ? { borderColor: color, borderWidth: 2 } : undefined}>
      <Row gutter={[16, 12]}>
        <Col span={8}>
          <Statistic title="累计投入" value={num(metrics.netContributions ?? metrics.initialCapital)} prefix="¥" />
        </Col>
        <Col span={8}>
          <Statistic title="期末权益" value={num(metrics.finalEquity)} prefix="¥" />
        </Col>
        <Col span={8}>
          <Statistic
            title="累计收益率"
            value={pct(metrics.totalReturn)}
            valueStyle={{ color: metrics.totalReturn >= 0 ? '#3f8600' : '#cf1322' }}
          />
        </Col>
        <Col span={8}>
          <Statistic title="年化收益率" value={pct(metrics.annualizedReturn)} />
        </Col>
        <Col span={8}>
          <Statistic title="年化波动率" value={pct(metrics.annualizedVolatility)} />
        </Col>
        <Col span={8}>
          <Statistic title="夏普比率" value={num(metrics.sharpeRatio)} />
        </Col>
        <Col span={8}>
          <Statistic
            title="最大回撤"
            value={pct(metrics.maxDrawdown)}
            valueStyle={{ color: '#cf1322' }}
          />
        </Col>
        <Col span={8}>
          <Statistic title="交易次数" value={metrics.tradeCount} />
        </Col>
        <Col span={8}>
          <Statistic title="胜率" value={pct(metrics.winRate)} />
        </Col>
        <Col span={8}>
          <Statistic title="盈亏比" value={num(metrics.profitFactor)} />
        </Col>
        <Col span={8}>
          <Statistic title="平均持仓天数" value={num(metrics.avgHoldingDays, 1)} suffix="天" />
        </Col>
        <Col span={8}>
          <Statistic title="总手续费" value={num(metrics.totalCommission)} prefix="¥" />
        </Col>
        <Col span={8}>
          <Statistic title="总印花税" value={num(metrics.totalTax)} prefix="¥" />
        </Col>
        <Col span={12}>
          <Text type="secondary">
            基准收益: {pct(metrics.benchmarkReturn)} | 超额收益: {pct(metrics.excessReturn)}
          </Text>
        </Col>
      </Row>
    </Card>
  );
}
