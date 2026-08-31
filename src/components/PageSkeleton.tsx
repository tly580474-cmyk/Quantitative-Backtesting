import { Skeleton } from 'antd';

export default function PageSkeleton() {
  return (
    <div className="workspace-skeleton" role="status" aria-label="正在加载工作区" aria-busy="true">
      <Skeleton active title={{ width: '24%' }} paragraph={{ rows: 1, width: '42%' }} />
      <div className="workspace-skeleton-metrics" aria-hidden="true">
        {[0, 1, 2].map((key) => <Skeleton key={key} active title={false} paragraph={{ rows: 2 }} />)}
      </div>
      <Skeleton active title={false} paragraph={{ rows: 6 }} />
    </div>
  );
}
