import { Button } from 'antd';
import { useLocation, useNavigate } from 'react-router-dom';

const destinations = [
  ['/agent', '研究会话'],
  ['/agent-runs', '运行记录'],
  ['/agent-reports', '研究报告'],
] as const;

export default function AgentWorkspaceNav() {
  const { pathname } = useLocation();
  const navigate = useNavigate();
  return <nav className="agent-context-nav" aria-label="智研工作区">
    {destinations.map(([path, label]) => <Button key={path} type="text"
      aria-current={pathname === path ? 'page' : undefined} onClick={() => navigate(path)}>
      {label}
    </Button>)}
  </nav>;
}
