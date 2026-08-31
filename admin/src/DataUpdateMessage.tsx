export function DataUpdateMessage({ message, updatedAt }: { message: string | null; updatedAt: string | null }) {
  const timestamp = updatedAt ? new Date(updatedAt).toLocaleString('zh-CN', { hour12: false }) : null;
  if (!message && !timestamp) return null;
  if (message && message.length > 260) {
    return (
      <details className="data-update-error-details">
        <summary>{message.slice(0, 260)}… · 展开详情{timestamp ? ` · ${timestamp}` : ''}</summary>
        <pre>{message}</pre>
      </details>
    );
  }
  return <p>{message ?? '进度已更新'}{timestamp ? ` · ${timestamp}` : ''}</p>;
}
