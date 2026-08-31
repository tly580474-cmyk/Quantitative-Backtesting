import { useLayoutEffect, useRef, useState } from 'react';
import { Button, Drawer, Menu } from 'antd';
import { AppstoreOutlined, ArrowLeftOutlined, BarChartOutlined, DotChartOutlined, MoreOutlined,
  MoonOutlined, RobotOutlined, StarOutlined, SunOutlined } from '@ant-design/icons';
import { useLocation, useNavigate, useNavigationType } from 'react-router-dom';
import type { AppLayoutProps } from '../AppLayout';

const TABS = [
  { key: '/market-data', label: '行情', icon: <BarChartOutlined /> },
  { key: '/watchlist', label: '自选', icon: <StarOutlined /> },
  { key: '/factors', label: '研究', icon: <DotChartOutlined /> },
  { key: '/agent', label: '智研', icon: <RobotOutlined /> },
];
const RESEARCH_PATHS = new Set(['/factors', '/factor-mining', '/backtest', '/results', '/studio']);
const CANVAS_PATHS = new Set(['/agent', '/analysis', '/backtest', '/market-sense-training']);

/** Phone navigation and scroll ownership are independent of the desktop shell. */
export default function MobileAppLayout({ activeKey, activeTitle, navigationItems,
  onNavigate, onBack, colorMode, onToggleColorMode, topBar, headerNav,
  leftPanel, center, bottom }: AppLayoutProps) {
  const location = useLocation();
  const navigate = useNavigate();
  const navigationType = useNavigationType();
  const [moreOpen, setMoreOpen] = useState(false);
  const [toolsOpen, setToolsOpen] = useState(false);
  const scroller = useRef<HTMLDivElement>(null);
  const scrollPositions = useRef(new Map<string, number>());
  const detailSource = useRef('/market-data');
  const path = location.pathname;
  const isMarketDetail = path.startsWith('/market-detail/');
  const canvas = CANVAS_PATHS.has(path);
  const selectedTab = RESEARCH_PATHS.has(path) ? '/factors'
    : path.startsWith('/agent') ? '/agent'
    : path === '/' || path.startsWith('/market-detail/') ? '/market-data' : activeKey;
  const title = path === '/factor-mining' ? '自动因子挖掘' : activeTitle;
  const detailReturnPath = detailSource.current;
  const detailReturnLabel = detailReturnPath === '/watchlist' ? '返回自选'
    : detailReturnPath === '/market-data' || detailReturnPath === '/' ? '返回行情' : '返回上一级';

  useLayoutEffect(() => {
    document.body.classList.add('mobile-layout-active');
    const viewport = window.visualViewport;
    const updateViewport = () => {
      const height = viewport?.scale === 1 ? viewport.height : window.innerHeight;
      document.documentElement.style.setProperty('--mobile-viewport-height', `${height}px`);
      document.body.classList.toggle('mobile-keyboard-open', window.innerHeight - height > 140);
    };
    updateViewport();
    window.addEventListener('resize', updateViewport);
    viewport?.addEventListener('resize', updateViewport);
    return () => {
      document.body.classList.remove('mobile-layout-active', 'mobile-keyboard-open');
      document.documentElement.style.removeProperty('--mobile-viewport-height');
      window.removeEventListener('resize', updateViewport);
      viewport?.removeEventListener('resize', updateViewport);
    };
  }, []);

  useLayoutEffect(() => {
    const element = scroller.current;
    if (!element) return;
    if (!path.startsWith('/market-detail/')) detailSource.current = path;
    const savedTop = scrollPositions.current.get(path) ?? 0;
    // Lazy pages may not have their content height yet. Restore as it loads,
    // stopping as soon as the user interacts so we never fight their scroll.
    let restoring = navigationType === 'POP' || savedTop > 0;
    const restore = () => { if (restoring) element.scrollTop = savedTop; };
    element.scrollTop = restoring ? savedTop : 0;
    const stopRestoring = () => { restoring = false; };
    const observer = new ResizeObserver(restore);
    if (element.firstElementChild) observer.observe(element.firstElementChild);
    element.addEventListener('pointerdown', stopRestoring, { passive: true });
    element.addEventListener('wheel', stopRestoring, { passive: true });
    const save = () => { if (!restoring || element.scrollTop >= savedTop) scrollPositions.current.set(path, element.scrollTop); };
    element.addEventListener('scroll', save, { passive: true });
    setMoreOpen(false);
    setToolsOpen(false);
    return () => {
      observer.disconnect();
      element.removeEventListener('pointerdown', stopRestoring);
      element.removeEventListener('wheel', stopRestoring);
      element.removeEventListener('scroll', save);
    };
  }, [path, navigationType]);

  const handleBack = () => {
    if (isMarketDetail) navigate(detailReturnPath);
    else onBack?.();
  };

  return (
    <div className={`mobile-app-shell${isMarketDetail ? ' mobile-app-shell--detail' : ''}`} data-page={path}>
      <header className="mobile-app-header">
        {(onBack || isMarketDetail) && <Button type="text" icon={<ArrowLeftOutlined />} aria-label={isMarketDetail ? detailReturnLabel : '返回列表'} title={isMarketDetail ? detailReturnLabel : '返回列表'} onClick={handleBack} />}
        <strong>{title}</strong>
        {topBar && <Button type="text" onClick={() => setToolsOpen(true)}>导入数据</Button>}
        <Button type="text" icon={isMarketDetail ? <AppstoreOutlined /> : <MoreOutlined />} aria-label="打开全部功能" title="全部功能" onClick={() => setMoreOpen(true)} />
      </header>
      {headerNav && <div className="mobile-header-nav">{headerNav}</div>}
      <div ref={scroller} className={`mobile-app-scroll${canvas ? ' mobile-app-scroll--canvas' : ''}`}>
        <div className={`mobile-page-content${canvas ? ' mobile-page-content--canvas' : ''}`}>
          {leftPanel && <details className="mobile-inline-panel"><summary>页面设置</summary>{leftPanel}</details>}
          {center}
          {bottom}
        </div>
      </div>
      {!isMarketDetail && <nav className="mobile-bottom-nav" aria-label="移动主导航">
        {TABS.map(tab => <button key={tab.key} type="button" aria-label={tab.label}
          aria-current={!moreOpen && selectedTab === tab.key ? 'page' : undefined}
          onClick={() => onNavigate(tab.key)}>{tab.icon}<span>{tab.label}</span></button>)}
        <button type="button" aria-label="更多功能" aria-expanded={moreOpen}
          aria-current={moreOpen || !TABS.some(tab => tab.key === selectedTab) ? 'page' : undefined}
          onClick={() => setMoreOpen(true)}><MoreOutlined /><span>更多</span></button>
      </nav>}
      <Drawer title="全部功能" placement="bottom" size="85dvh" open={moreOpen}
        onClose={() => setMoreOpen(false)} rootClassName="mobile-navigation-sheet">
        <Menu mode="inline" selectedKeys={[activeKey]} items={navigationItems}
          onClick={({ key }) => { setMoreOpen(false); onNavigate(key); }} />
        <Button block icon={colorMode === 'dark' ? <SunOutlined /> : <MoonOutlined />}
          onClick={onToggleColorMode}>{colorMode === 'dark' ? '切换为亮色模式' : '切换为暗色模式'}</Button>
      </Drawer>
      <Drawer title="导入与数据工具" placement="bottom" size="85dvh" open={toolsOpen}
        onClose={() => setToolsOpen(false)} rootClassName="mobile-tools-sheet">
        <div className="mobile-import-tools">{topBar}</div>
      </Drawer>
    </div>
  );
}
