import { Component, Fragment, type ErrorInfo, type ReactNode } from 'react';
import { Button, Result, Space } from 'antd';
import { HomeOutlined, ReloadOutlined } from '@ant-design/icons';

interface PageErrorBoundaryProps {
  children: ReactNode;
  resetKey: string;
  onBackHome: () => void;
}

interface PageErrorBoundaryState {
  error: Error | null;
  retryKey: number;
}

export function isDynamicImportError(error: Error): boolean {
  return /ChunkLoadError|Loading (?:CSS )?chunk|dynamically imported module|Importing a module script failed|Failed to fetch module script/i
    .test(`${error.name}: ${error.message}`);
}

export default class PageErrorBoundary extends Component<
  PageErrorBoundaryProps,
  PageErrorBoundaryState
> {
  state: PageErrorBoundaryState = {
    error: null,
    retryKey: 0,
  };

  static getDerivedStateFromError(error: Error): Partial<PageErrorBoundaryState> {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error('Page rendering failed', error, info.componentStack);
  }

  componentDidUpdate(previousProps: PageErrorBoundaryProps) {
    if (previousProps.resetKey !== this.props.resetKey && this.state.error) {
      this.setState((state) => ({ error: null, retryKey: state.retryKey + 1 }));
    }
  }

  private handleRetry = () => {
    if (this.state.error && isDynamicImportError(this.state.error)) {
      window.location.reload();
      return;
    }
    this.setState((state) => ({ error: null, retryKey: state.retryKey + 1 }));
  };

  render() {
    const { children, onBackHome } = this.props;
    const { error, retryKey } = this.state;

    if (error) {
      const resourceLoadFailed = isDynamicImportError(error);
      return (
        <div className="workspace-page-error" role="alert">
          <Result
            status="error"
            title={resourceLoadFailed ? '页面资源加载失败' : '页面暂时无法显示'}
            subTitle={resourceLoadFailed
              ? '网络可能发生了短暂波动，或系统刚刚更新。重新加载后即可获取最新页面资源。'
              : '页面运行时遇到了异常。你可以重试当前页面，或先返回市场数据。'}
            extra={(
              <Space wrap>
                <Button type="primary" icon={<ReloadOutlined />} onClick={this.handleRetry}>
                  {resourceLoadFailed ? '重新加载页面' : '重试当前页面'}
                </Button>
                <Button icon={<HomeOutlined />} onClick={onBackHome}>
                  返回市场数据
                </Button>
              </Space>
            )}
          />
        </div>
      );
    }

    return <Fragment key={retryKey}>{children}</Fragment>;
  }
}
