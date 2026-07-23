import type { ChanAnalysis, ChanCenter, ChanPen, ChanSegment } from './types';

interface ChanStructurePanelProps {
  analysis: ChanAnalysis;
}

function statusText(status: 'candidate' | 'confirmed'): string {
  return status === 'confirmed' ? '已确认' : '候选';
}

function centerText(center: ChanCenter | undefined): string {
  if (!center) return '尚未形成';
  const lifecycle = center.lifecycle === 'forming'
    ? '形成中'
    : center.lifecycle === 'active' ? '延伸中' : '已完成';
  return `[${center.zd}, ${center.zg}] · ${lifecycle}${center.expanded ? ' · 已扩展' : ''}`;
}

function StructureRow({ label, value, detail }: { label: string; value: string; detail?: string }) {
  return (
    <div className="chan-structure-row">
      <span>{label}</span>
      <strong>{value}</strong>
      {detail && <small>{detail}</small>}
    </div>
  );
}

export default function ChanStructurePanel({ analysis }: ChanStructurePanelProps) {
  const pen: ChanPen | undefined = analysis.pens[analysis.pens.length - 1];
  const segment: ChanSegment | undefined = analysis.segments[analysis.segments.length - 1];
  const penCenter = analysis.penCenters[analysis.penCenters.length - 1];
  const segmentCenter = analysis.segmentCenters[analysis.segmentCenters.length - 1];

  return (
    <div className="chan-structure-panel" aria-label="缠论当前结构摘要">
      <div className="chan-structure-meta">
        <span>{analysis.config.algorithmVersion}</span>
        <code>{analysis.fingerprint.fingerprint}</code>
        <span>截止 {analysis.current.asOf ?? '--'}</span>
      </div>
      <StructureRow
        label="当前笔"
        value={pen ? `${pen.direction === 'up' ? '向上' : '向下'} · ${statusText(pen.status)}` : '尚未形成'}
        detail={pen ? `${pen.startTime} → ${pen.endTime}；确认 ${pen.confirmedAt ?? '等待'}` : undefined}
      />
      <StructureRow
        label="当前线段"
        value={segment ? `${segment.direction === 'up' ? '向上' : '向下'} · ${statusText(segment.status)}` : '尚未形成'}
        detail={segment
          ? `${segment.startTime} → ${segment.endTime}；${segment.confirmationKind ?? '等待确认'}；特征元素 ${segment.featureElements.length}`
          : undefined}
      />
      <StructureRow
        label="最近笔中枢"
        value={centerText(penCenter)}
        detail={penCenter ? `结构 ${penCenter.componentIds.length}；确认 ${penCenter.confirmedAt ?? '等待'}；完成 ${penCenter.completedAt ?? '等待'}` : undefined}
      />
      <StructureRow
        label="最近段中枢"
        value={centerText(segmentCenter)}
        detail={segmentCenter ? `结构 ${segmentCenter.componentIds.length}；确认 ${segmentCenter.confirmedAt ?? '等待'}；完成 ${segmentCenter.completedAt ?? '等待'}` : undefined}
      />
      <p className="chan-structure-note">候选结构仅用于观察；内置回测策略只消费带确认时点的中枢完成事件。</p>
    </div>
  );
}
