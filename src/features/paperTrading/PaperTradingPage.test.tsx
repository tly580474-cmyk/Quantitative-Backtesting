import { App as AntdApp, ConfigProvider } from 'antd';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { apiFetch } from '@/api/client';
import PaperTradingPage from './PaperTradingPage';

vi.mock('@/api/client', () => ({ apiFetch: vi.fn() }));

const mockedApiFetch = vi.mocked(apiFetch);

const account = {
  id: 'paper-1',
  name: '测试账户',
  initialCash: 100_000,
  cashBalance: 100_000,
  frozenCash: 0,
  availableCash: 100_000,
  marketValue: 0,
  totalEquity: 100_000,
  status: 'active',
};

const detail = {
  ...account,
  positions: [],
  orders: [],
  trades: [],
  ledger: [],
};

function mockMatchMedia() {
  Object.defineProperty(window, 'matchMedia', {
    configurable: true,
    value: vi.fn((media: string) => ({
      matches: false,
      media,
      onchange: null,
      addListener: vi.fn(),
      removeListener: vi.fn(),
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      dispatchEvent: vi.fn(),
    })),
  });
}

function renderPage() {
  return render(
    <ConfigProvider>
      <AntdApp>
        <PaperTradingPage />
      </AntdApp>
    </ConfigProvider>,
  );
}

function responseFor(path: string, options?: RequestInit) {
  if (path === '/api/paper-trading/accounts' && options?.method === 'POST') {
    return Promise.resolve(account);
  }
  if (path === '/api/paper-trading/accounts') return Promise.resolve([account]);
  if (path === `/api/paper-trading/accounts/${account.id}`) return Promise.resolve(detail);
  if (path === '/api/market-data/stocks/search') return Promise.resolve({ items: [] });
  if (path === '/api/paper-trading/orders/preview') {
    return Promise.resolve({
      instrument: { instrumentKey: 1, securityCode: '600519', securityName: '贵州茅台', market: 'SH' },
      quote: { price: 100, quoteTime: '2026-01-01T09:30:00Z', source: 'test' },
      lotSize: 100,
      availableCash: 100_000,
      availableQuantity: 0,
      estimatedPrice: 100,
      quickQuantities: { full: 100, half: 100, third: 100, fixedHundredLots: 100, fixedHundredLotsAvailable: true },
    });
  }
  return Promise.resolve({});
}

beforeEach(() => {
  mockMatchMedia();
  mockedApiFetch.mockImplementation((path, options) => responseFor(path, options));
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('PaperTradingPage workbench states', () => {
  it('keeps the account creation action disabled while pending and recovers after failure', async () => {
    let rejectCreate!: (error: Error) => void;
    const createPending = new Promise<never>((_, reject) => { rejectCreate = reject; });
    mockedApiFetch.mockImplementation((path, options) => {
      if (path === '/api/paper-trading/accounts' && options?.method === 'POST') return createPending;
      if (path === '/api/paper-trading/accounts') return Promise.resolve([]);
      return responseFor(path, options);
    });

    renderPage();
    await waitFor(() => expect(screen.getByText('暂无模拟账户，请先新建账户')).toBeTruthy());
    fireEvent.click(screen.getByRole('button', { name: /新建账户/ }));
    fireEvent.change(screen.getByPlaceholderText('例如：价值投资模拟账户'), { target: { value: '失败恢复测试' } });
    fireEvent.change(screen.getByPlaceholderText('请输入初始资金'), { target: { value: '100000' } });

    const confirm = screen.getByRole('button', { name: 'OK' });
    fireEvent.click(confirm);
    await waitFor(() => expect((confirm as HTMLButtonElement).disabled).toBe(true));
    rejectCreate(new Error('模拟创建失败'));
    await waitFor(() => expect((confirm as HTMLButtonElement).disabled).toBe(false));
  });

  it('keeps order submission disabled while pending and re-enables after failure', async () => {
    let rejectOrder!: (error: Error) => void;
    const orderPending = new Promise<never>((_, reject) => { rejectOrder = reject; });
    mockedApiFetch.mockImplementation((path, options) => {
      if (path === '/api/paper-trading/orders' && options?.method === 'POST') return orderPending;
      return responseFor(path, options);
    });

    renderPage();
    await waitFor(() => expect(screen.getByText('手工委托')).toBeTruthy());
    expect(document.querySelectorAll('.paper-stat-neutral').length).toBe(2);
    fireEvent.change(screen.getByLabelText('证券名称或代码'), { target: { value: '600519' } });
    const submit = screen.getByRole('button', { name: '提交模拟委托' });
    fireEvent.click(submit);
    await waitFor(() => expect((submit as HTMLButtonElement).disabled).toBe(true));
    rejectOrder(new Error('模拟委托失败'));
    await waitFor(() => expect((submit as HTMLButtonElement).disabled).toBe(false));
  });

  it('shows a detail retry state when an existing account has no detail yet', async () => {
    let detailAttempts = 0;
    mockedApiFetch.mockImplementation((path, options) => {
      if (path === `/api/paper-trading/accounts/${account.id}`) {
        detailAttempts += 1;
        return detailAttempts <= 2
          ? Promise.reject(new Error('详情暂不可用'))
          : Promise.resolve(detail);
      }
      return responseFor(path, options);
    });

    renderPage();
    await waitFor(() => expect(screen.getByText('账户详情加载失败')).toBeTruthy());
    expect(screen.queryByText('暂无模拟账户，请先新建账户')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: /重\s*试/ }));
    await waitFor(() => expect(detailAttempts).toBe(2));
    await waitFor(() => expect(screen.getByText('账户详情加载失败')).toBeTruthy());
    fireEvent.click(screen.getByRole('button', { name: /重\s*试/ }));
    await waitFor(() => expect(screen.getByText('手工委托')).toBeTruthy());
  });

  it('keeps an account-list retry failure handled and allows another retry', async () => {
    let attempts = 0;
    mockedApiFetch.mockImplementation((path, options) => {
      if (path === '/api/paper-trading/accounts' && !options?.method) {
        attempts += 1;
        return attempts <= 2 ? Promise.reject(new Error('目录暂不可用')) : Promise.resolve([]);
      }
      return responseFor(path, options);
    });

    renderPage();
    await waitFor(() => expect(screen.getByText('模拟账户加载失败')).toBeTruthy());
    fireEvent.click(screen.getByRole('button', { name: /重\s*试/ }));
    await waitFor(() => expect(attempts).toBe(2));
    await waitFor(() => expect(screen.getByText('模拟账户加载失败')).toBeTruthy());
    fireEvent.click(screen.getByRole('button', { name: /重\s*试/ }));
    await waitFor(() => expect(screen.getByText('暂无模拟账户，请先新建账户')).toBeTruthy());
  });
});
