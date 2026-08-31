import { useState } from 'react';
import { Button, Empty, Spin } from 'antd';
import type { ResearchReport } from './types';
import { normalizeNewsUrl } from './newsUrl';

export default function MobileResearchReports({ reports, loading }: { reports: ResearchReport[]; loading: boolean }) {
  const [count, setCount] = useState(6);
  return <Spin spinning={loading}>
    {reports.length ? <>
      <ul className="mobile-report-list">{reports.slice(0, count).map(report => <li key={report.infoCode}>
        {report.pdfUrl ? <a href={normalizeNewsUrl(report.pdfUrl)} target="_blank" rel="noreferrer">{report.title}</a> : <strong>{report.title}</strong>}
        <div><span>{report.organization || '机构未提供'}</span><time>{report.publishDate}</time>{report.rating && <span>{report.rating}</span>}</div>
      </li>)}</ul>
      {count < reports.length && <Button block type="text" onClick={() => setCount(value => value + 6)}>查看更多研报（{reports.length - count}）</Button>}
    </> : <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description={loading ? '研报加载中' : '暂无机构研报'} />}
  </Spin>;
}
