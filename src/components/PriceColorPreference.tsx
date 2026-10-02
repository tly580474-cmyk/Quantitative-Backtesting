import { Button, Popover, Radio } from 'antd';
import { SwapOutlined } from '@ant-design/icons';
import { priceColorLabel, type PriceColorMode } from '@/priceColors';
import { usePriceColorStore } from '@/stores/usePriceColorStore';

export default function PriceColorPreference({ block = false }: { block?: boolean }) {
  const mode = usePriceColorStore((state) => state.mode);
  const setMode = usePriceColorStore((state) => state.setMode);
  return <Popover trigger="click" title="涨跌配色" content={
    <Radio.Group value={mode} onChange={(event) => setMode(event.target.value as PriceColorMode)}>
      <div style={{ display: 'grid', gap: 8 }}>
        <Radio value="red-up">红涨绿跌</Radio>
        <Radio value="green-up">绿涨红跌</Radio>
      </div>
    </Radio.Group>
  }>
    <Button block={block} type={block ? 'default' : 'text'} icon={<SwapOutlined />}
      aria-label={`涨跌配色：${priceColorLabel(mode)}`} title={`涨跌配色：${priceColorLabel(mode)}`}
      style={block ? { minHeight: 44, marginTop: 12 } : undefined}>
      {block ? `涨跌配色：${priceColorLabel(mode)}` : null}
    </Button>
  </Popover>;
}
