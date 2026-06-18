import { Upload, Button } from 'antd';
import { UploadOutlined } from '@ant-design/icons';
import type { UploadProps } from 'antd';

interface FileUploaderProps {
  onImport: (file: File) => void;
  loading: boolean;
}

export default function FileUploader({ onImport, loading }: FileUploaderProps) {
  const props: UploadProps = {
    accept: '.xlsx',
    maxCount: 1,
    showUploadList: false,
    beforeUpload: (file) => {
      onImport(file);
      return false; // Prevent auto-upload
    },
  };

  return (
    <Upload {...props}>
      <Button icon={<UploadOutlined />} loading={loading}>
        导入 Excel
      </Button>
    </Upload>
  );
}
