import { useState, useCallback, useEffect } from 'react';
import { Card, Button, Space, Typography, Alert, Steps, Progress, Popconfirm, message } from 'antd';
import {
  ExportOutlined, ImportOutlined, CheckCircleOutlined,
  DeleteOutlined, ReloadOutlined,
} from '@ant-design/icons';
import { exportAllTables, clearAllTables, type MigrationPayload } from '@/api/migrationExporter';
import { apiFetch, ApiError } from '@/api/client';

const { Text } = Typography;

interface ProgressMap {
  [key: string]: 'pending' | 'loading' | 'done' | 'error';
}

const MIGRATION_TIMEOUT = 300000; // 5 min for large datasets

function migrationFetch<T>(path: string, body: unknown): Promise<T> {
  return apiFetch<T>(path, {
    method: 'POST',
    body: JSON.stringify(body),
    timeoutMs: MIGRATION_TIMEOUT,
  });
}

export default function MigrationPanel() {
  const [step, setStep] = useState<'idle' | 'exported' | 'importing' | 'done'>('idle');
  const [payload, setPayload] = useState<MigrationPayload | null>(null);
  const [progress, setProgress] = useState<ProgressMap>({});
  const [error, setError] = useState<string | null>(null);
  const [apiOnline, setApiOnline] = useState<boolean | null>(null);

  // Check if API is available
  const checkApi = useCallback(async () => {
    try {
      const res = await apiFetch<{ db: string }>('/api/health');
      setApiOnline(res?.db === 'connected');
    } catch {
      setApiOnline(false);
    }
  }, []);

  useEffect(() => { checkApi(); }, [checkApi]);

  const handleExport = useCallback(async () => {
    setError(null);
    try {
      const data = await exportAllTables();
      setPayload(data);
      setStep('exported');
      message.success(`导出成功: ${data.summaries.reduce((a, b) => a + b.count, 0)} 条记录`);
    } catch (err) {
      setError(`导出失败: ${err instanceof Error ? err.message : String(err)}`);
    }
  }, []);

  const handleImport = useCallback(async () => {
    if (!payload) return;
    setStep('importing');
    setError(null);

    const tables = [
      { key: 'marketDatasets', label: '行情数据集', endpoint: '/api/migration/import-dataset' },
      { key: 'backtestResults', label: '回测结果', endpoint: '/api/migration/import-result' },
      { key: 'visualStrategies', label: '可视化策略', endpoint: '/api/migration/import-strategies' },
      { key: 'strategyConfigs', label: '策略配置', endpoint: '/api/migration/import-configs' },
    ];

    setProgress({ marketDatasets: 'pending', backtestResults: 'pending', visualStrategies: 'pending', strategyConfigs: 'pending' });

    for (const tbl of tables) {
      setProgress((p) => ({ ...p, [tbl.key]: 'loading' }));
      try {
        if (tbl.key === 'marketDatasets') {
          for (const ds of payload.tables.marketDatasets) {
            const dsCandles = payload.tables.candles.filter((c) => c.datasetId === ds.id);
            await migrationFetch(tbl.endpoint, { dataset: ds, candles: dsCandles });
          }
        } else if (tbl.key === 'backtestResults') {
          for (const r of payload.tables.backtestResults) {
            const pts = payload.tables.equityPoints.filter((p) => p.resultId === r.id);
            await migrationFetch(tbl.endpoint, { result: r, equityPoints: pts });
          }
        } else if (tbl.key === 'visualStrategies') {
          await migrationFetch(tbl.endpoint, {
            strategies: payload.tables.visualStrategies,
            versions: payload.tables.strategyVersions,
            drafts: payload.tables.strategyDrafts,
          });
        } else {
          await migrationFetch(tbl.endpoint, { configs: payload.tables.strategyConfigs });
        }
        setProgress((p) => ({ ...p, [tbl.key]: 'done' }));
      } catch (err) {
        setProgress((p) => ({ ...p, [tbl.key]: 'error' }));
        const msg = err instanceof ApiError ? err.message : String(err);
        setError(`${tbl.label} 导入失败: ${msg}`);
        return;
      }
    }

    message.success('数据已导入 MySQL，请验证后清除浏览器数据');
    setStep('done');
  }, [payload]);

  const handleClear = useCallback(async () => {
    await clearAllTables();
    message.success('浏览器数据已清除');
    setStep('idle');
    setPayload(null);
  }, []);

  const tableNames: Record<string, string> = {
    marketDatasets: '行情数据集',
    candles: 'K线数据',
    strategyConfigs: '策略配置',
    backtestResults: '回测结果',
    equityPoints: '权益曲线',
    visualStrategies: '可视化策略',
    strategyVersions: '策略版本',
    strategyDrafts: '策略草稿',
  };

  return (
    <Card size="small" title="数据迁移 (IndexedDB → MySQL)">
      {apiOnline === false && (
        <Alert
          type="warning"
          message="后端 MySQL 服务未连接"
          description="请确保 server 已启动且 MySQL 连接正常"
          showIcon
          action={<Button size="small" icon={<ReloadOutlined />} onClick={checkApi}>重试</Button>}
          style={{ marginBottom: 12 }}
        />
      )}

      {error && (
        <Alert type="error" message={error} closable onClose={() => setError(null)} style={{ marginBottom: 12 }} showIcon />
      )}

      <Steps
        size="small"
        current={step === 'idle' ? 0 : step === 'exported' ? 1 : step === 'importing' ? 2 : step === 'done' ? 3 : 0}
        style={{ marginBottom: 16 }}
        items={[
          { title: '导 出', description: '从 IndexedDB' },
          { title: '导 入', description: '写入 MySQL' },
          { title: '清 除', description: '清理浏览器缓存' },
        ]}
      />

      {step === 'idle' && (
        <Space>
          <Button type="primary" icon={<ExportOutlined />} onClick={handleExport} disabled={!apiOnline}>
            导出浏览器数据
          </Button>
          <Button icon={<ReloadOutlined />} onClick={checkApi} disabled={apiOnline !== false}>
            检查后端连接
          </Button>
        </Space>
      )}

      {step === 'exported' && payload && (
        <>
          <div style={{ marginBottom: 12 }}>
            <Text strong>已导出 {payload.summaries.reduce((a, b) => a + b.count, 0)} 条记录</Text>
          </div>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: '4px 16px', marginBottom: 12 }}>
            {payload.summaries.map((s) => (
              <Text key={s.name} type="secondary" style={{ fontSize: 12 }}>
                {tableNames[s.name] ?? s.name}: {s.count}
              </Text>
            ))}
          </div>
          <Space>
            <Button type="primary" icon={<ImportOutlined />} onClick={handleImport}>
              导入到 MySQL
            </Button>
            <Button onClick={() => { setStep('idle'); setPayload(null); }}>取消</Button>
          </Space>
        </>
      )}

      {step === 'importing' && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
          {Object.entries(progress).map(([key, status]) => (
            <div key={key} style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              {status === 'done' && <CheckCircleOutlined style={{ color: '#52C41A' }} />}
              {status === 'loading' && <Text style={{ color: '#1677FF' }}>⟳</Text>}
              {status === 'pending' && <Text type="secondary">○</Text>}
              {status === 'error' && <Text type="danger">✗</Text>}
              <Text>{tableNames[key] ?? key}</Text>
            </div>
          ))}
        </div>
      )}

      {step === 'done' && (
        <>
          <Alert type="success" message="数据导入完成" showIcon style={{ marginBottom: 12 }} />
          <Popconfirm
            title="清除浏览器数据"
            description="确认 MySQL 中数据完整后再执行。此操作不可逆。"
            onConfirm={handleClear}
            okText="确认清除"
            cancelText="取消"
            okButtonProps={{ danger: true }}
          >
            <Button danger icon={<DeleteOutlined />}>
              清除浏览器缓存数据
            </Button>
          </Popconfirm>
        </>
      )}
    </Card>
  );
}
