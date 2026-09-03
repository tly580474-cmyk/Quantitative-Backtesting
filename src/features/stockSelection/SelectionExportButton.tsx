import { Button, Dropdown, type MenuProps } from 'antd';
import { DownOutlined, DownloadOutlined, FileExcelOutlined, FileMarkdownOutlined } from '@ant-design/icons';
import type { SelectionExportFormat } from './selectionExport';

interface SelectionExportButtonProps {
  disabled?: boolean;
  onExport: (format: SelectionExportFormat) => void;
}

export default function SelectionExportButton({ disabled = false, onExport }: SelectionExportButtonProps) {
  const items: MenuProps['items'] = [
    { key: 'md', icon: <FileMarkdownOutlined />, label: 'Markdown（.md）' },
    { key: 'xlsx', icon: <FileExcelOutlined />, label: 'Excel（.xlsx）' },
  ];

  return <Dropdown
    disabled={disabled}
    trigger={['click']}
    menu={{ items, onClick: ({ key }) => onExport(key as SelectionExportFormat) }}
  >
    <Button
      className="selection-export-button"
      icon={<DownloadOutlined />}
      disabled={disabled}
      aria-label="导出选股结果，选择 Markdown 或 Excel 格式"
    >
      导出结果 <DownOutlined className="selection-export-chevron" />
    </Button>
  </Dropdown>;
}
