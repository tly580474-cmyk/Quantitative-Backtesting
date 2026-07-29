import { Typography } from 'antd';
import { Link } from 'react-router-dom';

const { Text } = Typography;

interface PaperSecurityLinkProps {
  securityCode: string;
  securityName: string;
}

export default function PaperSecurityLink({
  securityCode,
  securityName,
}: PaperSecurityLinkProps) {
  const code = securityCode.trim();
  const name = securityName.trim() || code;

  return (
    <span className="paper-trading-security">
      <Link
        className="paper-trading-security-link"
        to={`/market-detail/${encodeURIComponent(code)}`}
        aria-label={`查看${name}（${code}）行情详情`}
        title={`查看${name}行情详情`}
      >
        {name}
      </Link>
      {name !== code && <Text type="secondary">{code}</Text>}
    </span>
  );
}
