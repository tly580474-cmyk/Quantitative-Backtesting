import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  Button,
  Card,
  Col,
  Empty,
  Form,
  Input,
  InputNumber,
  Modal,
  Popconfirm,
  Row,
  Select,
  Space,
  Statistic,
  Table,
  Tabs,
  Tag,
  Typography,
  message,
} from 'antd';
import {
  PlusOutlined,
  ReloadOutlined,
  SafetyCertificateOutlined,
  SwapOutlined,
} from '@ant-design/icons';
import { apiFetch } from '@/api/client';

const { Text, Title } = Typography;

interface PaperAccountSummary {
  id: string;
  name: string;
  initialCash: number;
  cashBalance: number;
  frozenCash: number;
  availableCash: number;
  marketValue: number;
  totalEquity: number;
  status: string;
}

interface PaperPosition {
  instrumentKey: number;
  securityCode: string;
  securityName: string;
  market: string;
  totalQuantity: number;
  availableQuantity: number;
  frozenQuantity: number;
  averageCost: number;
  lastPrice: number | null;
  marketValue: number;
  realizedPnl: number;
  unrealizedPnl: number | null;
}

interface PaperOrder {
  id: string;
  accountId: string;
  securityCode: string;
  securityName: string;
  market: string;
  side: 'buy' | 'sell';
  orderType: 'market' | 'limit';
  quantity: number;
  limitPrice: number | null;
  status: string;
  filledQuantity: number;
  averageFillPrice: number | null;
  frozenCash: number;
  frozenQuantity: number;
  submittedAt: string;
}

interface PaperAccountDetail extends PaperAccountSummary {
  positions: PaperPosition[];
  orders: PaperOrder[];
  trades: Array<Record<string, unknown>>;
  ledger: Array<Record<string, unknown>>;
}

const ACTIVE_ORDER_STATUSES = new Set(['accepted', 'partially_filled']);

export default function PaperTradingPage() {
  const [accounts, setAccounts] = useState<PaperAccountSummary[]>([]);
  const [selectedAccountId, setSelectedAccountId] = useState<string>();
  const [detail, setDetail] = useState<PaperAccountDetail | null>(null);
  const [loading, setLoading] = useState(false);
  const [accountModalOpen, setAccountModalOpen] = useState(false);
  const [accountForm] = Form.useForm();
  const [orderForm] = Form.useForm();
  const orderType = Form.useWatch('orderType', orderForm) ?? 'market';
  const selectedAccount = useMemo(
    () => accounts.find((item) => item.id === selectedAccountId),
    [accounts, selectedAccountId],
  );

  const loadAccounts = useCallback(async (preserveSelection = true) => {
    const items = await apiFetch<PaperAccountSummary[]>('/api/paper-trading/accounts');
    setAccounts(items);
    setSelectedAccountId((current) => {
      if (preserveSelection && current && items.some((item) => item.id === current)) {
        return current;
      }
      return items[0]?.id;
    });
  }, []);

  const loadDetail = useCallback(async (accountId: string) => {
    setLoading(true);
    try {
      setDetail(await apiFetch<PaperAccountDetail>(
        `/api/paper-trading/accounts/${accountId}`,
      ));
    } finally {
      setLoading(false);
    }
  }, []);

  const refresh = useCallback(async () => {
    try {
      await loadAccounts();
      if (selectedAccountId) await loadDetail(selectedAccountId);
    } catch (error) {
      message.error(error instanceof Error ? error.message : '加载模拟账户失败');
    }
  }, [loadAccounts, loadDetail, selectedAccountId]);

  useEffect(() => {
    void loadAccounts(false).catch((error) => {
      message.error(error instanceof Error ? error.message : '加载模拟账户失败');
    });
  }, [loadAccounts]);

  useEffect(() => {
    if (selectedAccountId) {
      void loadDetail(selectedAccountId).catch((error) => {
        message.error(error instanceof Error ? error.message : '加载账户详情失败');
      });
    } else {
      setDetail(null);
    }
  }, [loadDetail, selectedAccountId]);

  const createAccount = async () => {
    const values = await accountForm.validateFields();
    await apiFetch('/api/paper-trading/accounts', {
      method: 'POST',
      body: JSON.stringify(values),
    });
    message.success('模拟账户已创建');
    setAccountModalOpen(false);
    accountForm.resetFields();
    await loadAccounts(false);
  };

  const submitOrder = async () => {
    if (!selectedAccountId) return;
    const values = await orderForm.validateFields();
    const result = await apiFetch<{ matched: boolean; order: PaperOrder }>(
      '/api/paper-trading/orders',
      {
        method: 'POST',
        body: JSON.stringify({
          ...values,
          accountId: selectedAccountId,
          clientOrderId: crypto.randomUUID(),
          limitPrice: values.orderType === 'limit' ? values.limitPrice : null,
        }),
      },
    );
    message.success(result.matched ? '委托已模拟成交' : '委托已受理');
    orderForm.resetFields(['securityCode', 'quantity', 'limitPrice']);
    await refresh();
  };

  const cancelOrder = async (order: PaperOrder) => {
    await apiFetch(`/api/paper-trading/orders/${order.id}/cancel`, {
      method: 'POST',
      body: JSON.stringify({ accountId: order.accountId }),
    });
    message.success('委托已撤销，冻结资产已释放');
    await refresh();
  };

  const matchOrder = async (order: PaperOrder) => {
    const result = await apiFetch<{ matched: boolean }>(
      `/api/paper-trading/orders/${order.id}/match`,
      { method: 'POST' },
    );
    message.success(result.matched ? '撮合完成' : '当前行情或时段未满足成交条件');
    await refresh();
  };

  return (
    <div className="paper-trading-page">
      <div className="paper-trading-header">
        <div>
          <Space align="center">
            <Title level={3}>模拟交易</Title>
            <Tag color="blue" icon={<SafetyCertificateOutlined />}>仅模拟，不连接真实资金</Tag>
          </Space>
          <Text type="secondary">
            本地分钟数据优先 · A 股 T+1 · 订单与账本持久化
          </Text>
        </div>
        <Space>
          <Select
            value={selectedAccountId}
            placeholder="选择模拟账户"
            style={{ width: 220 }}
            options={accounts.map((account) => ({
              label: account.name,
              value: account.id,
            }))}
            onChange={setSelectedAccountId}
          />
          <Button icon={<ReloadOutlined />} loading={loading} onClick={() => void refresh()}>
            刷新
          </Button>
          <Button type="primary" icon={<PlusOutlined />} onClick={() => setAccountModalOpen(true)}>
            新建账户
          </Button>
        </Space>
      </div>

      {!selectedAccount || !detail ? (
        <Card><Empty description="请先创建模拟账户" /></Card>
      ) : (
        <>
          <Row gutter={[16, 16]} className="paper-trading-statistics">
            <Col xs={24} sm={12} xl={8} xxl={4}><Card><Statistic title="总权益" value={detail.totalEquity} precision={2} suffix="元" /></Card></Col>
            <Col xs={24} sm={12} xl={8} xxl={4}><Card><Statistic title="可用现金" value={detail.availableCash} precision={2} suffix="元" /></Card></Col>
            <Col xs={24} sm={12} xl={8} xxl={4}><Card><Statistic title="冻结资金" value={detail.frozenCash} precision={2} suffix="元" /></Card></Col>
            <Col xs={24} sm={12} xl={8} xxl={4}><Card><Statistic title="持仓市值" value={detail.marketValue} precision={2} suffix="元" /></Card></Col>
            <Col xs={24} sm={12} xl={8} xxl={4}><Card><Statistic title="累计收益" value={detail.totalEquity - detail.initialCash} precision={2} suffix="元" /></Card></Col>
            <Col xs={24} sm={12} xl={8} xxl={4}><Card><Statistic title="收益率" value={(detail.totalEquity / detail.initialCash - 1) * 100} precision={2} suffix="%" /></Card></Col>
          </Row>

          <Card title={<Space><SwapOutlined />手工委托</Space>} className="paper-trading-order-card">
            <Form
              form={orderForm}
              layout="inline"
              initialValues={{ side: 'buy', orderType: 'market' }}
              onFinish={() => void submitOrder()}
            >
              <Form.Item name="securityCode" label="证券代码" rules={[{ required: true }, { pattern: /^(?:SH|SZ|BJ)?\d{6}$/i, message: '请输入 6 位 A 股代码' }]}>
                <Input placeholder="例如 600519" style={{ width: 150 }} />
              </Form.Item>
              <Form.Item name="side" label="方向" rules={[{ required: true }]}>
                <Select style={{ width: 100 }} options={[{ label: '买入', value: 'buy' }, { label: '卖出', value: 'sell' }]} />
              </Form.Item>
              <Form.Item name="orderType" label="类型" rules={[{ required: true }]}>
                <Select style={{ width: 110 }} options={[{ label: '市价', value: 'market' }, { label: '限价', value: 'limit' }]} />
              </Form.Item>
              {orderType === 'limit' && (
                <Form.Item name="limitPrice" label="委托价" rules={[{ required: true }]}>
                  <InputNumber min={0.01} precision={2} />
                </Form.Item>
              )}
              <Form.Item name="quantity" label="数量（股）" rules={[{ required: true }]}>
                <InputNumber min={100} step={100} precision={0} />
              </Form.Item>
              <Form.Item>
                <Button type="primary" htmlType="submit">提交模拟委托</Button>
              </Form.Item>
            </Form>
          </Card>

          <Card>
            <Tabs
              items={[
                {
                  key: 'positions',
                  label: `持仓 ${detail.positions.length}`,
                  children: <Table
                    rowKey="instrumentKey"
                    pagination={false}
                    dataSource={detail.positions}
                    columns={[
                      { title: '证券', render: (_, row) => `${row.securityName} ${row.securityCode}` },
                      { title: '持仓', dataIndex: 'totalQuantity' },
                      { title: '可卖', dataIndex: 'availableQuantity' },
                      { title: '冻结', dataIndex: 'frozenQuantity' },
                      { title: '成本', dataIndex: 'averageCost', render: money },
                      { title: '现价', dataIndex: 'lastPrice', render: money },
                      { title: '市值', dataIndex: 'marketValue', render: money },
                      { title: '浮动盈亏', dataIndex: 'unrealizedPnl', render: pnl },
                      { title: '已实现盈亏', dataIndex: 'realizedPnl', render: pnl },
                    ]}
                  />,
                },
                {
                  key: 'orders',
                  label: `委托 ${detail.orders.length}`,
                  children: <Table
                    rowKey="id"
                    dataSource={detail.orders}
                    pagination={{ pageSize: 20 }}
                    columns={[
                      { title: '时间', dataIndex: 'submittedAt' },
                      { title: '证券', render: (_, row) => `${row.securityName} ${row.securityCode}` },
                      { title: '方向', dataIndex: 'side', render: sideTag },
                      { title: '类型', render: (_, row) => row.orderType === 'market' ? '市价' : `限价 ${row.limitPrice}` },
                      { title: '委托/成交', render: (_, row) => `${row.quantity} / ${row.filledQuantity}` },
                      { title: '成交均价', dataIndex: 'averageFillPrice', render: money },
                      { title: '状态', dataIndex: 'status', render: statusTag },
                      {
                        title: '操作',
                        render: (_, row) => ACTIVE_ORDER_STATUSES.has(row.status) ? (
                          <Space>
                            <Button size="small" onClick={() => void matchOrder(row)}>撮合</Button>
                            <Popconfirm title="确认撤销该模拟委托？" onConfirm={() => void cancelOrder(row)}>
                              <Button size="small" danger>撤单</Button>
                            </Popconfirm>
                          </Space>
                        ) : '—',
                      },
                    ]}
                  />,
                },
                {
                  key: 'trades',
                  label: `成交 ${detail.trades.length}`,
                  children: <Table
                    rowKey={(row) => String(row.id)}
                    dataSource={detail.trades}
                    pagination={{ pageSize: 20 }}
                    columns={[
                      { title: '时间', dataIndex: 'created_at' },
                      { title: '证券', render: (_, row) => `${row.security_name} ${row.security_code}` },
                      { title: '方向', dataIndex: 'side', render: sideTag },
                      { title: '数量', dataIndex: 'quantity' },
                      { title: '成交价', dataIndex: 'fill_price', render: money },
                      { title: '金额', dataIndex: 'amount', render: money },
                      { title: '佣金', dataIndex: 'commission', render: money },
                      { title: '税费', dataIndex: 'tax', render: money },
                      { title: '行情来源', dataIndex: 'quote_source' },
                    ]}
                  />,
                },
              ]}
            />
          </Card>
        </>
      )}

      <Modal
        title="新建模拟账户"
        open={accountModalOpen}
        onCancel={() => setAccountModalOpen(false)}
        onOk={() => void createAccount()}
        destroyOnHidden
      >
        <Form form={accountForm} layout="vertical" initialValues={{ initialCash: 1_000_000 }}>
          <Form.Item name="name" label="账户名称" rules={[{ required: true }]}>
            <Input placeholder="例如：价值投资模拟账户" />
          </Form.Item>
          <Form.Item name="initialCash" label="初始资金（元）" rules={[{ required: true }]}>
            <InputNumber min={10_000} max={1_000_000_000_000} precision={2} style={{ width: '100%' }} />
          </Form.Item>
          <Text type="secondary">
            默认佣金万分之三、最低 5 元；卖出印花税按当前配置千分之零点五计算。
          </Text>
        </Form>
      </Modal>
    </div>
  );
}

function money(value: unknown) {
  const number = Number(value);
  return Number.isFinite(number) ? number.toFixed(2) : '—';
}

function pnl(value: unknown) {
  const number = Number(value);
  if (!Number.isFinite(number)) return '—';
  return <Text type={number > 0 ? 'danger' : number < 0 ? 'success' : undefined}>{number.toFixed(2)}</Text>;
}

function sideTag(value: unknown) {
  return value === 'buy' ? <Tag color="red">买入</Tag> : <Tag color="green">卖出</Tag>;
}

function statusTag(value: unknown) {
  const labels: Record<string, string> = {
    accepted: '已受理',
    partially_filled: '部分成交',
    filled: '已成交',
    rejected: '已拒绝',
    cancelled: '已撤销',
    expired: '已过期',
  };
  const color = value === 'filled'
    ? 'success'
    : value === 'accepted' || value === 'partially_filled'
      ? 'processing'
      : 'default';
  return <Tag color={color}>{labels[String(value)] ?? String(value)}</Tag>;
}
