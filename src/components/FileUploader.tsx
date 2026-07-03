import { Upload, Button } from 'antd';
import { UploadOutlined } from '@ant-design/icons';
import type { UploadProps } from 'antd';

interface FileUploaderProps {
  onImport: (files: File[]) => void;
  loading: boolean;
}

export default function FileUploader({ onImport, loading }: FileUploaderProps) {
  const props: UploadProps = {
    accept: '.xlsx,.xls,.csv',
    multiple: true,
    showUploadList: false,
    beforeUpload: (file, fileList) => {
      if (file.uid === fileList[0]?.uid) onImport(fileList as File[]);
      return false;
    },
  };

  return (
    <Upload {...props}>
      <Button icon={<UploadOutlined />} loading={loading}>
        批量导入 Excel / CSV
      </Button>
    </Upload>
  );
}
