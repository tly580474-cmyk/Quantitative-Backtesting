import type { ReactNode } from 'react';
import { Button, Drawer } from 'antd';
import type { DrawerProps } from 'antd';
import { CloseOutlined } from '@ant-design/icons';

interface WorkbenchPanelProps {
  title: ReactNode;
  subtitle?: ReactNode;
  children: ReactNode;
  className?: string;
  closeLabel?: string;
  onClose?: () => void;
}

export function WorkbenchPanel({
  title,
  subtitle,
  children,
  className,
  closeLabel = '收起面板',
  onClose,
}: WorkbenchPanelProps) {
  return (
    <div className={className ? `workbench-panel ${className}` : 'workbench-panel'}>
      <div className="workbench-panel-head">
        <div>
          <strong>{title}</strong>
          {subtitle && <span>{subtitle}</span>}
        </div>
        {onClose && (
          <Button
            aria-label={closeLabel}
            type="text"
            size="small"
            icon={<CloseOutlined />}
            onClick={onClose}
          />
        )}
      </div>
      {children}
    </div>
  );
}

interface WorkbenchDrawerProps extends Omit<DrawerProps, 'children'> {
  children: ReactNode;
}

type DrawerStyles = Exclude<DrawerProps['styles'], (...args: any[]) => unknown>;
type DrawerStylesResolver = Extract<NonNullable<DrawerProps['styles']>, (...args: any[]) => unknown>;
type DrawerStyleInfo = Parameters<DrawerStylesResolver>[0];

export function WorkbenchDrawer({
  children,
  placement = 'right',
  size = 'default',
  styles,
  destroyOnHidden = true,
  ...props
}: WorkbenchDrawerProps) {
  const getDrawerStyles = (baseStyles?: DrawerProps['styles']) => {
    const resolveStyles = (resolvedStyles?: DrawerStyles) => ({
      ...resolvedStyles,
      body: {
        padding: 10,
        background: '#f8fafc',
        ...resolvedStyles?.body,
      },
    });

    if (typeof baseStyles === 'function') {
      return (info: DrawerStyleInfo) => resolveStyles(baseStyles(info));
    }

    return resolveStyles(baseStyles);
  };

  return (
    <Drawer
      placement={placement}
      size={size}
      styles={getDrawerStyles(styles)}
      destroyOnHidden={destroyOnHidden}
      {...props}
    >
      {children}
    </Drawer>
  );
}
