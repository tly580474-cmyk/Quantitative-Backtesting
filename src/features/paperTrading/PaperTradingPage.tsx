import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  AutoComplete,
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
  Spin,
  Statistic,
  Alert,
  Skeleton,
  Table,
  Tabs,
  Tag,
  Typography,
  message,
} from 'antd';
import {
  DeleteOutlined,
  PlusOutlined,
  ReloadOutlined,
  SafetyCertificateOutlined,
  SearchOutlined,
  SwapOutlined,
} from '@ant-design/icons';
import { apiFetch } from '@/api/client';
import type { StockSearchItem } from '@/features/marketData/types';
import PaperSecurityLink from './PaperSecurityLink';
import { useMobileLayout } from '@/components/mobile/useMobileLayout';
import { financialTone } from '@/components/WorkspacePrimitives';
import './paperTrading.workbench.css';

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

interface PaperOrderPreview {
  instrument: {
    instrumentKey: number;
    securityCode: string;
    securityName: string;
    market: string;
  };
  quote: {
    price: number;
    quoteTime: string;
    source: string;
  };
  lotSize: number;
  availableCash: number;
  availableQuantity: number;
  estimatedPrice: number;
  quickQuantities: {
    full: number;
    half: number;
    third: number;
    fixedHundredLots: number;
    fixedHundredLotsAvailable: boolean;
  };
}

const ACTIVE_ORDER_STATUSES = new Set(['accepted', 'partially_filled']);

function isFormValidationError(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'errorFields' in error;
}

export default function PaperTradingPage() {
  const mobileLayout = useMobileLayout();
  const [mobileView, setMobileView] = useState<'account' | 'order'>('account');
  const [accounts, setAccounts] = useState<PaperAccountSummary[]>([]);
  const [selectedAccountId, setSelectedAccountId] = useState<string>();
  const [detail, setDetail] = useState<PaperAccountDetail | null>(null);
  const [loading, setLoading] = useState(false);
  const [accountsLoading, setAccountsLoading] = useState(true);
  const [accountsError, setAccountsError] = useState<string | null>(null);
  const [detailError, setDetailError] = useState<string | null>(null);
  const [accountModalOpen, setAccountModalOpen] = useState(false);
  const [creatingAccount, setCreatingAccount] = useState(false);
  const [deletingAccount, setDeletingAccount] = useState(false);
  const [securityOptions, setSecurityOptions] = useState<StockSearchItem[]>([]);
  const [securitySearching, setSecuritySearching] = useState(false);
  const [orderPreview, setOrderPreview] = useState<PaperOrderPreview | null>(null);
  const [previewLoading, setPreviewLoading] = useState(false);
  const [submittingOrder, setSubmittingOrder] = useState(false);
  const securitySearchSequence = useRef(0);
  const [accountForm] = Form.useForm();
  const [orderForm] = Form.useForm();
  const orderType = Form.useWatch('orderType', orderForm) ?? 'market';
  const orderSide = Form.useWatch('side', orderForm) ?? 'buy';
  const securityQuery = Form.useWatch('securityCode', orderForm) ?? '';
  const limitPrice = Form.useWatch('limitPrice', orderForm);
  const selectedAccount = useMemo(
    () => accounts.find((item) => item.id === selectedAccountId),
    [accounts, selectedAccountId],
  );

  const loadAccounts = useCallback(async (preserveSelection = true) => {
    setAccountsLoading(true);
    setAccountsError(null);
    try {
      const items = await apiFetch<PaperAccountSummary[]>('/api/paper-trading/accounts');
      setAccounts(items);
      setSelectedAccountId((current) => {
        if (preserveSelection && current && items.some((item) => item.id === current)) {
          return current;
        }
        return items[0]?.id;
      });
    } catch (error) {
      setAccountsError(error instanceof Error ? error.message : '加载模拟账户失败');
      throw error;
    } finally {
      setAccountsLoading(false);
    }
  }, []);

  const loadDetail = useCallback(async (accountId: string, showLoading = true) => {
    if (showLoading) setLoading(true);
    setDetailError(null);
    try {
      setDetail(await apiFetch<PaperAccountDetail>(
        `/api/paper-trading/accounts/${accountId}`,
      ));
    } catch (error) {
      setDetailError(error instanceof Error ? error.message : '加载账户详情失败');
      throw error;
    } finally {
      if (showLoading) setLoading(false);
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
      setDetailError(null);
    }
  }, [loadDetail, selectedAccountId]);

  useEffect(() => {
    if (!selectedAccountId) return undefined;
    const timer = window.setInterval(() => {
      if (document.visibilityState !== 'visible') return;
      void loadDetail(selectedAccountId, false).catch(() => {
        // Keep the last successful valuation and retry on the next interval.
      });
    }, 15_000);
    return () => window.clearInterval(timer);
  }, [loadDetail, selectedAccountId]);

  const createAccount = async () => {
    if (creatingAccount) return;
    setCreatingAccount(true);
    try {
      const values = await accountForm.validateFields();
      await apiFetch('/api/paper-trading/accounts', {
        method: 'POST',
        body: JSON.stringify(values),
      });
      message.success('模拟账户已创建');
      setAccountModalOpen(false);
      accountForm.resetFields();
      await loadAccounts(false);
    } catch (error) {
      if (!isFormValidationError(error)) {
        message.error(error instanceof Error ? error.message : '创建模拟账户失败');
      }
    } finally {
      setCreatingAccount(false);
    }
  };

  const deleteAccount = async () => {
    if (!selectedAccountId) return;
    setDeletingAccount(true);
    try {
      await apiFetch(`/api/paper-trading/accounts/${selectedAccountId}`, {
        method: 'DELETE',
      });
      message.success('模拟账户及其交易记录已删除');
      setDetail(null);
      setSelectedAccountId(undefined);
      setOrderPreview(null);
      await loadAccounts(false);
    } catch (error) {
      message.error(error instanceof Error ? error.message : '删除模拟账户失败');
    } finally {
      setDeletingAccount(false);
    }
  };

  const searchSecurities = useCallback(async (value: string) => {
    const query = value.trim();
    const sequence = securitySearchSequence.current + 1;
    securitySearchSequence.current = sequence;
    setOrderPreview(null);
    if (!query) {
      setSecurityOptions([]);
      return;
    }
    setSecuritySearching(true);
    try {
      const result = await apiFetch<{ items: StockSearchItem[] }>(
        `/api/market-data/stocks/search?q=${encodeURIComponent(query)}`,
      );
      if (sequence === securitySearchSequence.current) {
        setSecurityOptions(result.items ?? []);
      }
    } catch {
      if (sequence === securitySearchSequence.current) setSecurityOptions([]);
    } finally {
      if (sequence === securitySearchSequence.current) setSecuritySearching(false);
    }
  }, []);

  useEffect(() => {
    if (
      !selectedAccountId
      || !securityQuery.trim()
      || (orderType === 'limit' && !(Number(limitPrice) > 0))
    ) {
      setOrderPreview(null);
      return;
    }
    const controller = new AbortController();
    const timer = window.setTimeout(async () => {
      setPreviewLoading(true);
      try {
        const preview = await apiFetch<PaperOrderPreview>(
          '/api/paper-trading/orders/preview',
          {
            method: 'POST',
            body: JSON.stringify({
              accountId: selectedAccountId,
              securityQuery: securityQuery.trim(),
              side: orderSide,
              orderType,
              limitPrice: orderType === 'limit' ? Number(limitPrice) : null,
            }),
            signal: controller.signal,
          },
        );
        setOrderPreview(preview);
      } catch (error) {
        if (!controller.signal.aborted) setOrderPreview(null);
      } finally {
        if (!controller.signal.aborted) setPreviewLoading(false);
      }
    }, 350);
    return () => {
      window.clearTimeout(timer);
      controller.abort();
    };
  }, [limitPrice, orderSide, orderType, securityQuery, selectedAccountId]);

  const applyQuickQuantity = (quantityShares: number) => {
    if (quantityShares <= 0) return;
    orderForm.setFieldValue('quantityLots', quantityShares / 100);
    void orderForm.validateFields(['quantityLots']);
  };

  const submitOrder = async () => {
    if (!selectedAccountId || submittingOrder) return;
    setSubmittingOrder(true);
    try {
      const values = await orderForm.validateFields();
      const result = await apiFetch<{ matched: boolean; order: PaperOrder }>(
        '/api/paper-trading/orders',
        {
          method: 'POST',
          body: JSON.stringify({
            ...values,
            accountId: selectedAccountId,
            clientOrderId: crypto.randomUUID(),
            securityCode: orderPreview?.instrument.securityCode ?? values.securityCode,
            quantity: Number(values.quantityLots) * 100,
            limitPrice: values.orderType === 'limit' ? values.limitPrice : null,
            quantityLots: undefined,
          }),
        },
      );
      message.success(result.matched ? '委托已模拟成交' : '委托已受理');
      orderForm.resetFields(['securityCode', 'quantityLots', 'limitPrice']);
      orderForm.setFieldValue('quantityLots', 1);
      setOrderPreview(null);
      setSecurityOptions([]);
      await refresh();
    } catch (error) {
      if (!isFormValidationError(error)) {
        message.error(error instanceof Error ? error.message : '提交模拟委托失败');
      }
    } finally {
      setSubmittingOrder(false);
    }
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

  const returnValue = detail ? detail.totalEquity - detail.initialCash : null;
  const returnTone = financialTone(returnValue);
  const pageContent = accountsLoading ? (
    <Card className="paper-empty-card paper-loading-card" aria-label="正在加载模拟账户">
      <Skeleton active paragraph={{ rows: 3 }} />
    </Card>
  ) : accountsError ? (
    <Alert
      type="error"
      showIcon
      title="模拟账户加载失败"
      description={accountsError}
      action={<Button onClick={() => void loadAccounts(false).catch(() => undefined)}>重试</Button>}
    />
  ) : !selectedAccountId || !selectedAccount ? (
    <Card className="paper-empty-card">
      <Empty description="暂无模拟账户，请先新建账户" />
    </Card>
  ) : loading && !detail ? (
    <Card className="paper-empty-card paper-loading-card" aria-label="正在加载账户详情">
      <Skeleton active paragraph={{ rows: 3 }} />
    </Card>
  ) : detailError && !detail ? (
    <Alert
      type="error"
      showIcon
      title="账户详情加载失败"
      description={detailError}
      action={<Button onClick={() => void loadDetail(selectedAccountId).catch(() => undefined)}>重试</Button>}
    />
  ) : !detail ? (
    <Card className="paper-empty-card paper-loading-card" aria-label="正在准备账户详情">
      <Skeleton active paragraph={{ rows: 3 }} />
    </Card>
  ) : (
    <>
          <Row gutter={[16, 16]} className="paper-trading-statistics" style={mobileLayout && mobileView !== 'account' ? { display: 'none' } : undefined}>
            <Col xs={24} sm={12} xl={8} xxl={4}><Card className="paper-stat-card"><Statistic title="总权益" value={detail.totalEquity} precision={2} suffix="元" /></Card></Col>
            <Col xs={24} sm={12} xl={8} xxl={4}><Card className="paper-stat-card"><Statistic title="可用现金" value={detail.availableCash} precision={2} suffix="元" /></Card></Col>
            <Col xs={24} sm={12} xl={8} xxl={4}><Card className="paper-stat-card paper-stat-risk"><Statistic title="冻结资金" value={detail.frozenCash} precision={2} suffix="元" /></Card></Col>
            <Col xs={24} sm={12} xl={8} xxl={4}><Card className="paper-stat-card"><Statistic title="持仓市值" value={detail.marketValue} precision={2} suffix="元" /></Card></Col>
            <Col xs={24} sm={12} xl={8} xxl={4}><Card className={`paper-stat-card paper-stat-${returnTone}`}><Statistic title="累计收益" value={detail.totalEquity - detail.initialCash} precision={2} suffix="元" /></Card></Col>
            <Col xs={24} sm={12} xl={8} xxl={4}><Card className={`paper-stat-card paper-stat-${financialTone(returnValue)}`}><Statistic title="收益率" value={(detail.totalEquity / detail.initialCash - 1) * 100} precision={2} suffix="%" /></Card></Col>
          </Row>

          <Card title={<Space><SwapOutlined />手工委托</Space>} className="paper-trading-order-card paper-workbench-card"
            style={mobileLayout && mobileView !== 'order' ? { display: 'none' } : undefined}>
            <Form
              form={orderForm}
              layout="vertical"
              initialValues={{ side: 'buy', orderType: 'market', quantityLots: 1 }}
              onFinish={() => void submitOrder()}
            >
              <div className="paper-trading-order-grid">
                <Form.Item
                  name="securityCode"
                  label="证券（名称/代码）"
                  rules={[{ required: true, message: '请输入证券名称或代码' }]}
                >
                  <AutoComplete
                    options={securityOptions.map((item) => ({
                      value: item.code,
                      label: (
                        <div className="paper-security-option">
                          <span><strong>{item.name}</strong> <Text type="secondary">{item.code}</Text></span>
                          <Tag>{item.market}</Tag>
                        </div>
                      ),
                    }))}
                    onSearch={(value) => void searchSecurities(value)}
                    onSelect={(code) => {
                      const item = securityOptions.find((option) => option.code === code);
                      orderForm.setFieldValue('securityCode', item?.code ?? code);
                    }}
                    notFoundContent={securitySearching
                      ? <Spin size="small" />
                      : <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="输入名称、代码或拼音" />}
                  >
                    <Input
                      prefix={<SearchOutlined />}
                      placeholder="例如：贵州茅台、600519、茅台"
                      aria-label="证券名称或代码"
                    />
                  </AutoComplete>
                </Form.Item>
                <Form.Item name="side" label="方向" rules={[{ required: true }]}>
                  <Select options={[{ label: '买入', value: 'buy' }, { label: '卖出', value: 'sell' }]} />
                </Form.Item>
                <Form.Item name="orderType" label="类型" rules={[{ required: true }]}>
                  <Select options={[{ label: '市价', value: 'market' }, { label: '限价', value: 'limit' }]} />
                </Form.Item>
                {orderType === 'limit' && (
                  <Form.Item name="limitPrice" label="委托价（元）" rules={[{ required: true }]}>
                    <InputNumber min={0.01} precision={2} style={{ width: '100%' }} />
                  </Form.Item>
                )}
                <Form.Item
                  name="quantityLots"
                  label="数量（手）"
                  extra="1 手 = 100 股；卖出全部持仓时可包含零股"
                  rules={[
                    { required: true, message: '请输入委托手数' },
                    {
                      validator: (_, value) => {
                        const lots = Number(value);
                        if (!Number.isFinite(lots) || lots <= 0) {
                          return Promise.reject(new Error('委托手数必须大于 0'));
                        }
                        if (orderSide === 'buy' && !Number.isInteger(lots)) {
                          return Promise.reject(new Error('买入必须按整手提交'));
                        }
                        return Promise.resolve();
                      },
                    },
                  ]}
                >
                  <InputNumber
                    min={orderSide === 'buy' ? 1 : 0.01}
                    step={1}
                    precision={orderSide === 'buy' ? 0 : 2}
                    style={{ width: '100%' }}
                  />
                </Form.Item>
              </div>

              <div className="paper-trading-order-preview" aria-live="polite">
                <div className="paper-trading-preview-summary">
                  {previewLoading ? (
                    <Space><Spin size="small" /><Text type="secondary">正在读取本地优先行情…</Text></Space>
                  ) : orderPreview ? (
                    <Space wrap>
                      <Tag color="blue">
                        {orderPreview.instrument.securityName} {orderPreview.instrument.securityCode}
                      </Tag>
                      <Text>参考价 <strong>{orderPreview.estimatedPrice.toFixed(2)} 元</strong></Text>
                      <Text type="secondary">
                        {orderSide === 'buy'
                          ? `可用现金 ${money(orderPreview.availableCash)} 元`
                          : `可卖 ${(orderPreview.availableQuantity / 100).toFixed(2)} 手`}
                      </Text>
                    </Space>
                  ) : (
                    <Text type="secondary">选择证券后可使用快捷仓位</Text>
                  )}
                </div>
                <Space wrap className="paper-trading-quick-actions">
                  <Text type="secondary">快捷数量</Text>
                  <Button
                    disabled={!orderPreview || orderPreview.quickQuantities.full <= 0}
                    onClick={() => applyQuickQuantity(orderPreview?.quickQuantities.full ?? 0)}
                  >
                    全仓
                  </Button>
                  <Button
                    disabled={!orderPreview || orderPreview.quickQuantities.half <= 0}
                    onClick={() => applyQuickQuantity(orderPreview?.quickQuantities.half ?? 0)}
                  >
                    半仓
                  </Button>
                  <Button
                    disabled={!orderPreview || orderPreview.quickQuantities.third <= 0}
                    onClick={() => applyQuickQuantity(orderPreview?.quickQuantities.third ?? 0)}
                  >
                    1/3 仓
                  </Button>
                  <Button
                    disabled={!orderPreview?.quickQuantities.fixedHundredLotsAvailable}
                    onClick={() => applyQuickQuantity(
                      orderPreview?.quickQuantities.fixedHundredLots ?? 0,
                    )}
                  >
                    100 手
                  </Button>
                </Space>
              </div>

              <Form.Item className="paper-trading-submit">
                <Button type="primary" htmlType="submit" size="large" loading={submittingOrder} disabled={submittingOrder}>
                  提交模拟委托
                </Button>
              </Form.Item>
            </Form>
          </Card>

          <Card className="paper-trading-records-card paper-workbench-card" style={mobileLayout && mobileView !== 'account' ? { display: 'none' } : undefined}>
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
                      {
                        title: '证券',
                        render: (_, row) => (
                          <PaperSecurityLink
                            securityName={row.securityName}
                            securityCode={row.securityCode}
                          />
                        ),
                      },
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
                      {
                        title: '证券',
                        render: (_, row) => (
                          <PaperSecurityLink
                            securityName={row.securityName}
                            securityCode={row.securityCode}
                          />
                        ),
                      },
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
                      {
                        title: '证券',
                        render: (_, row) => (
                          <PaperSecurityLink
                            securityName={String(row.security_name ?? '')}
                            securityCode={String(row.security_code ?? '')}
                          />
                        ),
                      },
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
  );

  return (
    <div className="paper-trading-page" aria-label="模拟交易工作台">
      <div className="paper-trading-header">
        <div className="paper-trading-heading">
          <Space align="center">
            <Title level={3}>模拟交易</Title>
            <Tag color="blue" icon={<SafetyCertificateOutlined />}>仅模拟，不连接真实资金</Tag>
          </Space>
          <Text type="secondary">
            本地分钟数据优先 · A 股 T+1 · 订单与账本持久化
          </Text>
        </div>
        <Space className="paper-trading-header-actions">
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
          <Button icon={<ReloadOutlined />} loading={loading || accountsLoading} onClick={() => void refresh()}>
            刷新
          </Button>
          <Popconfirm
            title={`删除账户“${selectedAccount?.name ?? ''}”？`}
            description="账户、持仓、委托、成交和资金流水将永久删除，无法恢复。"
            okText="永久删除"
            cancelText="取消"
            okButtonProps={{ danger: true, loading: deletingAccount }}
            disabled={!selectedAccount}
            onConfirm={() => void deleteAccount()}
          >
            <Button
              danger
              icon={<DeleteOutlined />}
              disabled={!selectedAccount}
              loading={deletingAccount}
            >
              删除账户
            </Button>
          </Popconfirm>
          <Button type="primary" icon={<PlusOutlined />} onClick={() => setAccountModalOpen(true)}>
            新建账户
          </Button>
        </Space>
      </div>

      {mobileLayout && detail && <nav className="mobile-paper-tabs" aria-label="模拟交易视图">
        <Button type={mobileView === 'account' ? 'primary' : 'default'} aria-pressed={mobileView === 'account'}
          onClick={() => setMobileView('account')}>账户与记录</Button>
        <Button type={mobileView === 'order' ? 'primary' : 'default'} aria-pressed={mobileView === 'order'}
          onClick={() => setMobileView('order')}>模拟委托</Button>
      </nav>}

      {pageContent}

      <Modal
        title="新建模拟账户"
        open={accountModalOpen}
        onCancel={() => setAccountModalOpen(false)}
        onOk={() => void createAccount()}
        okButtonProps={{ loading: creatingAccount, disabled: creatingAccount }}
        destroyOnHidden
      >
        <Form form={accountForm} layout="vertical">
          <Form.Item name="name" label="账户名称" rules={[{ required: true }]}>
            <Input placeholder="例如：价值投资模拟账户" />
          </Form.Item>
          <Form.Item
            name="initialCash"
            label="初始资金（元）"
            extra="初始资金仅在创建时确定，创建后不能直接修改。"
            rules={[{ required: true, message: '请自定义账户初始资金' }]}
          >
            <InputNumber
              min={10_000}
              max={1_000_000_000_000}
              precision={2}
              placeholder="请输入初始资金"
              style={{ width: '100%' }}
            />
          </Form.Item>
          <Space wrap className="paper-account-cash-presets">
            <Text type="secondary">快捷金额</Text>
            {[100_000, 500_000, 1_000_000, 5_000_000].map((amount) => (
              <Button key={amount} onClick={() => accountForm.setFieldValue('initialCash', amount)}>
                {amount / 10_000} 万
              </Button>
            ))}
          </Space>
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
  return <Text
    className={number > 0 ? 'paper-value-positive' : number < 0 ? 'paper-value-negative' : undefined}
    type={number > 0 ? 'danger' : number < 0 ? 'success' : undefined}
  >{number.toFixed(2)}</Text>;
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
