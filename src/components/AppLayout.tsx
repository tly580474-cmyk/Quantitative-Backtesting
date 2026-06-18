import type { ReactNode } from 'react';
import { Layout, Typography } from 'antd';

const { Header, Sider, Content } = Layout;
const { Text } = Typography;

interface AppLayoutProps {
  topBar: ReactNode;
  leftPanel: ReactNode;
  center: ReactNode;
  bottom: ReactNode;
}

export default function AppLayout({ topBar, leftPanel, center, bottom }: AppLayoutProps) {
  return (
    <Layout style={{ height: '100%' }}>
      <Header
        style={{
          background: '#fff',
          borderBottom: '1px solid #f0f0f0',
          padding: '0 16px',
          display: 'flex',
          alignItems: 'center',
          gap: 16,
          height: 48,
          lineHeight: '48px',
        }}
      >
        <Text strong style={{ fontSize: 16, whiteSpace: 'nowrap' }}>
          量化行情分析
        </Text>
        <div style={{ flex: 1, display: 'flex', alignItems: 'center', gap: 12 }}>
          {topBar}
        </div>
      </Header>
      <Layout style={{ flex: 1, overflow: 'hidden' }}>
        <Sider
          width={280}
          style={{
            background: '#fff',
            borderRight: '1px solid #f0f0f0',
            overflow: 'auto',
            padding: 12,
          }}
        >
          {leftPanel}
        </Sider>
        <Content
          style={{
            display: 'flex',
            flexDirection: 'column',
            minHeight: 0,
            overflowX: 'hidden',
            overflowY: 'auto',
            scrollbarGutter: 'stable',
            overscrollBehavior: 'contain',
          }}
        >
          <div
            style={{
              flex: bottom ? '0 0 75%' : '1 1 100%',
              minHeight: 0,
              overflow: 'hidden',
            }}
          >
            {center}
          </div>
          {bottom && (
            <div
              style={{
                flex: '0 0 25%',
                minHeight: 0,
                overflow: 'visible',
                background: '#fff',
                borderTop: '1px solid #f0f0f0',
              }}
            >
              {bottom}
            </div>
          )}
        </Content>
      </Layout>
    </Layout>
  );
}
