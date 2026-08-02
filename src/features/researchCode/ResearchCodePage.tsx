import { useCallback, useEffect, useState } from 'react';
import {
  CodeOutlined,
  PlayCircleOutlined,
  ReloadOutlined,
} from '@ant-design/icons';
import {
  Alert,
  Button,
  Card,
  Collapse,
  Descriptions,
  Input,
  Space,
  Table,
  Tag,
  Typography,
  message,
} from 'antd';
import type { ColumnsType } from 'antd/es/table';
import {
  listResearchCodeRuns,
  researchCodeStatusColor,
  researchCodeStatusLabel,
  submitResearchCode,
} from './api';
import type { ResearchCodeRun } from './api';

const { Text, Title, Paragraph } = Typography;
const { TextArea } = Input;

const DEFAULT_CODE = `# 阶段 C 示例：连接只读 MySQL 读取日频数据概览
# 可用环境变量：DB_HOST/DB_PORT/DB_USER/DB_PASSWORD/DB_NAME（只读账号 quant_research_ro）
#               RESEARCH_PARQUET=/data/research（DuckDB 日频快照，只读）
#               MINUTE_PARQUET=/data/minute（分钟数据 parquet 湖，只读）
# 结果恒标记 exploration_only，仅供参考研究。

import os

# 1) 读取 MySQL 全 A 日频数据（只读账号）
import pymysql

conn = pymysql.connect(
    host=os.environ["DB_HOST"], port=int(os.environ["DB_PORT"]),
    user=os.environ["DB_USER"], password=os.environ["DB_PASSWORD"],
    database=os.environ["DB_NAME"], charset="utf8mb4",
)
with conn.cursor() as cur:
    cur.execute("SELECT COUNT(*) AS n, COUNT(DISTINCT instrument_key) AS symbols FROM daily_bars_v2")
    row = cur.fetchone()
conn.close()

# 2) 读取 DuckDB 研究快照元数据（只读挂载）
import duckdb

con = duckdb.connect()
files = con.execute(
    "SELECT COUNT(*) FROM glob('" + os.environ["RESEARCH_PARQUET"] + "/**/*.parquet')"
).fetchone()[0]
con.close()

print({"mysql_rows": row[0], "mysql_symbols": row[1], "research_parquet_files": files})
`;

export default function ResearchCodePage() {
  const [code, setCode] = useState(DEFAULT_CODE);
  const [runs, setRuns] = useState<ResearchCodeRun[]>([]);
  const [loading, setLoading] = useState(false);
  const [submitting, setSubmitting] = useState(false);

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      setRuns(await listResearchCodeRuns());
    } catch (error) {
      message.error(error instanceof Error ? error.message : '加载运行历史失败');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const runCode = async () => {
    if (!code.trim()) {
      message.warning('请输入研究代码');
      return;
    }
    setSubmitting(true);
    try {
      const run = await submitResearchCode(code.trim());
      message.success(`已提交运行 ${run.id.slice(0, 8)}（${researchCodeStatusLabel(run.status)}）`);
      await refresh();
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      let display = detail;
      try {
        const parsed = JSON.parse(detail);
        display = parsed.details?.message ?? parsed.message ?? detail;
      } catch {
        // keep raw message
      }
      message.error(`执行失败：${display}`);
    } finally {
      setSubmitting(false);
    }
  };

  const columns: ColumnsType<ResearchCodeRun> = [
    {
      title: '状态',
      dataIndex: 'status',
      width: 90,
      render: (status: ResearchCodeRun['status']) => (
        <Tag color={researchCodeStatusColor(status)}>{researchCodeStatusLabel(status)}</Tag>
      ),
    },
    {
      title: '代码摘要',
      dataIndex: ['request', 'code'],
      ellipsis: true,
      render: (source: string) => {
        const firstLine = source.split('\n').find((line) => line.trim().length > 0) ?? '';
        return <Text style={{ fontFamily: 'monospace' }}>{firstLine.trim().slice(0, 80)}</Text>;
      },
    },
    {
      title: 'codeHash',
      dataIndex: 'codeHash',
      width: 130,
      render: (hash: string) => <Text type="secondary" style={{ fontFamily: 'monospace', fontSize: 12 }}>{hash.slice(0, 12)}…</Text>,
    },
    {
      title: '结果摘要',
      dataIndex: 'result',
      render: (result: unknown) => {
        if (result === null || result === undefined) return '—';
        const text = typeof result === 'string' ? result : JSON.stringify(result);
        return <Text style={{ fontFamily: 'monospace', fontSize: 12 }}>{text.slice(0, 120)}</Text>;
      },
    },
    {
      title: '执行时间',
      dataIndex: 'createdAt',
      width: 170,
      render: (value: string) => new Date(value).toLocaleString('zh-CN', { hour12: false }),
    },
  ];

  return (
    <div style={{ padding: 16, maxWidth: 1200, margin: '0 auto' }}>
      <Card>
        <Space direction="vertical" size={12} style={{ width: '100%' }}>
          <Title level={4} style={{ margin: 0 }}>
            <CodeOutlined /> 写代码研究（阶段 C）
          </Title>
          <Alert
            type="info"
            showIcon
            message="受控开放研究通道"
            description={
              <Paragraph style={{ margin: 0 }}>
                你的 Python 代码将在只读隔离沙箱中执行：可连接 MySQL 只读账号（全 A 日频数据、
                价值因子）与 DuckDB 研究快照/分钟数据（只读挂载）。运行结果恒标记
                <Text code>exploration_only</Text>，仅作研究参考，不会直接进入策略发布流程（ADR-05）。
              </Paragraph>
            }
          />
          <TextArea
            value={code}
            onChange={(event) => setCode(event.target.value)}
            rows={16}
            style={{ fontFamily: 'monospace', fontSize: 13 }}
            placeholder="# 在这里编写 Python 研究代码…"
          />
          <Space>
            <Button
              type="primary"
              icon={<PlayCircleOutlined />}
              loading={submitting}
              onClick={runCode}
            >
              运行研究代码
            </Button>
            <Button icon={<ReloadOutlined />} onClick={() => void refresh()}>
              刷新历史
            </Button>
          </Space>
        </Space>
      </Card>

      <Card style={{ marginTop: 16 }} title={`运行历史（${runs.length}）`}>
        <Table
          rowKey="id"
          size="small"
          loading={loading}
          columns={columns}
          dataSource={runs}
          pagination={{ pageSize: 10, showSizeChanger: false }}
          expandable={{
            expandedRowRender: (run) => (
              <Space direction="vertical" size={8} style={{ width: '100%' }}>
                <Descriptions size="small" column={2}>
                  <Descriptions.Item label="运行 ID">{run.id}</Descriptions.Item>
                  <Descriptions.Item label="authority">
                    <Tag color="orange">{run.authority}</Tag>
                    {run.publishable ? <Tag color="green">publishable</Tag> : <Tag>not publishable</Tag>}
                  </Descriptions.Item>
                  <Descriptions.Item label="resultHash">
                    <Text style={{ fontFamily: 'monospace', fontSize: 12 }}>{run.resultHash ?? '—'}</Text>
                  </Descriptions.Item>
                  <Descriptions.Item label="maxSeconds">{run.maxSeconds ?? '—'}</Descriptions.Item>
                </Descriptions>
                <Collapse
                  size="small"
                  items={[
                    {
                      key: 'code',
                      label: '代码',
                      children: <pre style={{ margin: 0, fontFamily: 'monospace', fontSize: 12, whiteSpace: 'pre-wrap' }}>{run.request.code}</pre>,
                    },
                    {
                      key: 'output',
                      label: '捕获输出（stdout）',
                      children: <pre style={{ margin: 0, fontFamily: 'monospace', fontSize: 12, whiteSpace: 'pre-wrap' }}>{run.capturedOutput ?? '（无输出）'}</pre>,
                    },
                    {
                      key: 'result',
                      label: '结果（JSON）',
                      children: <pre style={{ margin: 0, fontFamily: 'monospace', fontSize: 12, whiteSpace: 'pre-wrap' }}>{JSON.stringify(run.result, null, 2)}</pre>,
                    },
                    {
                      key: 'error',
                      label: '错误',
                      children: <pre style={{ margin: 0, fontFamily: 'monospace', fontSize: 12, whiteSpace: 'pre-wrap', color: '#cf1322' }}>{run.error ? JSON.stringify(run.error, null, 2) : '（无错误）'}</pre>,
                    },
                  ]}
                />
              </Space>
            ),
          }}
        />
      </Card>
    </div>
  );
}
