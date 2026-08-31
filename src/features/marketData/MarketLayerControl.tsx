import { cloneElement, useState } from 'react';
import type { ReactElement, ReactNode } from 'react';
import { Drawer, Popover } from 'antd';

export default function MarketLayerControl({ mobile, title, content, children }: {
  mobile: boolean; title: string; content: ReactNode;
  children: ReactElement<{ onClick?: () => void; disabled?: boolean }>;
}) {
  const [open, setOpen] = useState(false);
  if (!mobile) return <Popover placement="bottomRight" trigger="click" title={title} content={content}>{children}</Popover>;
  return <>
    {cloneElement(children, { onClick: () => {
      if (children.props.disabled) return;
      children.props.onClick?.();
      setOpen(true);
    } })}
    <Drawer title={title} placement="bottom" size="auto" open={open} onClose={() => setOpen(false)}
      rootClassName="mobile-detail-sheet">
      {content}
    </Drawer>
  </>;
}
