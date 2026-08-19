import { useState, type ReactNode } from 'react';
import { Button, Drawer, Layout, Menu, Tooltip, Typography } from 'antd';
import type { MenuProps } from 'antd';
import {
  ArrowLeftOutlined,
  CloseOutlined,
  MenuFoldOutlined,
  MenuUnfoldOutlined,
  MoonOutlined,
  SunOutlined,
} from '@ant-design/icons';
import { BrandLogo } from './BrandLogo';
import type { ColorMode } from '../theme';

const { Header, Sider, Content } = Layout;
const { Text } = Typography;

interface AppLayoutProps {
  activeKey: string;
  activeTitle: string;
  navigationItems: MenuProps['items'];
  onNavigate: (key: string) => void;
  onBack?: () => void;
  topBar: ReactNode;
  headerNav?: ReactNode;
  navigationContext?: ReactNode;
  hidePageIdentity?: boolean;
  leftPanel?: ReactNode;
  center: ReactNode;
  bottom?: ReactNode;
  colorMode: ColorMode;
  onToggleColorMode: () => void;
}

export default function AppLayout({
  activeKey,
  activeTitle,
  navigationItems,
  onNavigate,
  onBack,
  topBar,
  headerNav,
  navigationContext,
  hidePageIdentity = false,
  leftPanel,
  center,
  bottom,
  colorMode,
  onToggleColorMode,
}: AppLayoutProps) {
  const [collapsed, setCollapsed] = useState(false);
  const [mobileNavOpen, setMobileNavOpen] = useState(false);

  const handleNavigate = (key: string) => {
    onNavigate(key);
    setMobileNavOpen(false);
  };

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
          <BrandLogo className="app-brand-mark" />
          {!collapsed && (
            <div className="app-brand-copy">
              <Text strong>量化回测平台</Text>
              <Text type="secondary">Research Workbench</Text>
            </div>
          )}
        </div>
        {navigationContext && (
          <div className="app-nav-context">
            {navigationContext}
          </div>
        )}
        <Menu
          className="app-nav-menu"
          mode="inline"
          selectedKeys={[activeKey]}
          items={navigationItems}
          inlineCollapsed={collapsed}
          onClick={({ key }) => handleNavigate(key)}
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
          <Tooltip
            title={colorMode === 'dark' ? '切换为亮色模式' : '切换为暗色模式'}
            placement="right"
          >
            <Button
              className="app-theme-toggle"
              aria-label={colorMode === 'dark' ? '切换为亮色模式' : '切换为暗色模式'}
              aria-pressed={colorMode === 'dark'}
              type="text"
              icon={colorMode === 'dark' ? <SunOutlined /> : <MoonOutlined />}
              onClick={onToggleColorMode}
            />
          </Tooltip>
        </div>
      </Sider>
      <Layout className="app-main-shell">
        <Header className="app-header">
          <Button
            className="app-mobile-nav-trigger"
            type="text"
            icon={<MenuUnfoldOutlined />}
            aria-label="打开主导航"
            aria-expanded={mobileNavOpen}
            onClick={() => setMobileNavOpen(true)}
          />
          {!hidePageIdentity && (
            <div className="app-page-identity">
              <Text type="secondary">当前工作区</Text>
              <Text strong className="app-title">
                {activeTitle}
              </Text>
              {onBack && (
                <Button
                  size="small"
                  icon={<ArrowLeftOutlined />}
                  onClick={onBack}
                  aria-label="返回上一级"
                  style={{ marginLeft: 8, backgroundColor: '#e6f4ff', color: '#5e91e0', borderColor: 'transparent' }}
                >
                  返回
                </Button>
              )}
            </div>
          )}
          {headerNav}
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
      <Drawer
        className="app-mobile-nav-drawer"
        placement="left"
        width={304}
        open={mobileNavOpen}
        closable={false}
        onClose={() => setMobileNavOpen(false)}
        styles={{ body: { padding: 0 } }}
      >
        <nav className="app-mobile-nav" aria-label="主导航">
          <div className="app-mobile-nav-brand">
            <BrandLogo className="app-brand-mark" />
            <div className="app-brand-copy">
              <Text strong>量化回测平台</Text>
              <Text type="secondary">Research Workbench</Text>
            </div>
            <Button
              type="text"
              icon={<CloseOutlined />}
              aria-label="关闭主导航"
              onClick={() => setMobileNavOpen(false)}
            />
          </div>
          {navigationContext && (
            <div className="app-nav-context">
              {navigationContext}
            </div>
          )}
          <Menu
            className="app-nav-menu"
            mode="inline"
            selectedKeys={[activeKey]}
            items={navigationItems}
            onClick={({ key }) => handleNavigate(key)}
          />
          <div className="app-mobile-nav-footer">
            <Button
              block
              icon={colorMode === 'dark' ? <SunOutlined /> : <MoonOutlined />}
              onClick={onToggleColorMode}
            >
              {colorMode === 'dark' ? '切换为亮色模式' : '切换为暗色模式'}
            </Button>
          </div>
        </nav>
      </Drawer>
    </Layout>
  );
}
