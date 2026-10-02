import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, expect, it } from 'vitest';
import { usePriceColorStore, PRICE_COLOR_KEY } from '@/stores/usePriceColorStore';
import PriceColorPreference from './PriceColorPreference';

afterEach(() => { cleanup(); usePriceColorStore.getState().setMode('red-up'); localStorage.removeItem(PRICE_COLOR_KEY); });

it('offers both conventions and shares the selected preference with another settings control', async () => {
  render(<><PriceColorPreference /><PriceColorPreference block /></>);
  fireEvent.click(screen.getAllByRole('button', { name: '涨跌配色：红涨绿跌' })[0]);
  const green = await screen.findByRole('radio', { name: '绿涨红跌' });
  expect(screen.getByRole('radio', { name: '红涨绿跌' })).toBeTruthy();
  fireEvent.click(green);
  expect(screen.getAllByRole('button', { name: '涨跌配色：绿涨红跌' })).toHaveLength(2);
  expect(localStorage.getItem(PRICE_COLOR_KEY)).toBe('green-up');
  fireEvent.click(screen.getByRole('radio', { name: '红涨绿跌' }));
  expect(screen.getAllByRole('button', { name: '涨跌配色：红涨绿跌' })).toHaveLength(2);
});
