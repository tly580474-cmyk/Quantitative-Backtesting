import { Spin } from 'antd';

export default function PageSkeleton() {
  return (
    <div style={{
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'center',
      height: '100%',
      minHeight: 200,
    }}>
      <Spin size="large" />
    </div>
  );
}
