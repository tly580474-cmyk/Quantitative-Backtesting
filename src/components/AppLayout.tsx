import type { ReactNode } from 'react';
import { Layout, Typography } from 'antd';

const { Header, Sider, Content } = Layout;
const { Text } = Typography;

interface AppLayoutProps {
  topBar: ReactNode;
  tabBar?: ReactNode;
  leftPanel: ReactNode;
  center: ReactNode;
  bottom?: ReactNode;
}

export default function AppLayout({ topBar, tabBar, leftPanel, center, bottom }: AppLayoutProps) {
  return (
    <Layout className="app-shell">
      <Header
        className="app-header"
        style={{
          background: '#fff',
          borderBottom: '1px solid #f0f0f0',
        }}
      >
        <Text strong className="app-title">
          量化行情分析
        </Text>
        <div className="app-header-tools">
          {topBar}
        </div>
      </Header>
      {tabBar && (
        <div className="app-tabs">
          {tabBar}
        </div>
      )}
      <Layout style={{ flex: 1, overflow: 'hidden' }}>
        {leftPanel && (
          <Sider
            width={280}
            breakpoint="lg"
            collapsedWidth={0}
            className="app-sidebar"
          >
            {leftPanel}
          </Sider>
        )}
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
