import { useState, type ReactNode } from 'react';
import { Button, Layout, Menu, Tooltip, Typography } from 'antd';
import type { MenuProps } from 'antd';
import {
  MenuFoldOutlined,
  MenuUnfoldOutlined,
} from '@ant-design/icons';

const { Header, Sider, Content } = Layout;
const { Text } = Typography;

interface AppLayoutProps {
  activeKey: string;
  activeTitle: string;
  navigationItems: MenuProps['items'];
  onNavigate: (key: string) => void;
  topBar: ReactNode;
  leftPanel?: ReactNode;
  center: ReactNode;
  bottom?: ReactNode;
}

export default function AppLayout({
  activeKey,
  activeTitle,
  navigationItems,
  onNavigate,
  topBar,
  leftPanel,
  center,
  bottom,
}: AppLayoutProps) {
  const [collapsed, setCollapsed] = useState(false);

  return (
    <Layout className="app-shell">
      <Sider
        className="app-nav-sider"
        width={224}
        collapsedWidth={64}
        collapsible
        trigger={null}
        breakpoint="xl"
        collapsed={collapsed}
        onBreakpoint={setCollapsed}
      >
        <div className="app-brand">
          <div className="app-brand-mark" aria-hidden="true">
            Q
          </div>
          {!collapsed && (
            <div className="app-brand-copy">
              <Text strong>量化回测平台</Text>
              <Text type="secondary">Research Workbench</Text>
            </div>
          )}
        </div>
        <Menu
          className="app-nav-menu"
          mode="inline"
          selectedKeys={[activeKey]}
          items={navigationItems}
          inlineCollapsed={collapsed}
          onClick={({ key }) => onNavigate(key)}
        />
        <div className="app-nav-footer">
          <Tooltip title={collapsed ? '展开导航' : '收起导航'} placement="right">
            <Button
              aria-label={collapsed ? '展开导航' : '收起导航'}
              type="text"
              icon={collapsed ? <MenuUnfoldOutlined /> : <MenuFoldOutlined />}
              onClick={() => setCollapsed((value) => !value)}
            />
          </Tooltip>
        </div>
      </Sider>
      <Layout className="app-main-shell">
        <Header className="app-header">
          <div className="app-page-identity">
            <Text type="secondary">当前工作区</Text>
            <Text strong className="app-title">
              {activeTitle}
            </Text>
          </div>
          <div className="app-header-tools">
            {topBar}
          </div>
        </Header>
        <Layout className="app-workspace-shell">
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
          <Content className="app-content">
            <div className={bottom ? 'app-content-main has-bottom' : 'app-content-main'}>
              {center}
            </div>
            {bottom && (
              <div className="app-bottom-panel">
                {bottom}
              </div>
            )}
          </Content>
        </Layout>
      </Layout>
    </Layout>
  );
}
