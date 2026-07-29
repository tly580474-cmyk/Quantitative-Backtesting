import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { describe, expect, it } from 'vitest';
import PaperSecurityLink from './PaperSecurityLink';

describe('PaperSecurityLink', () => {
  it('links the security name to its market detail route and keeps the code visible', () => {
    render(
      <MemoryRouter>
        <PaperSecurityLink securityName="长城军工" securityCode="601606" />
      </MemoryRouter>,
    );

    const link = screen.getByRole('link', { name: '查看长城军工（601606）行情详情' });
    expect(link.getAttribute('href')).toBe('/market-detail/601606');
    expect(link.textContent).toBe('长城军工');
    expect(screen.getByText('601606')).toBeTruthy();
  });
});
