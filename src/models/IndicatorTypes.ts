export interface IndicatorParam {
  name: string;
  label: string;
  defaultValue: number;
  min: number;
  max: number;
  step: number;
}

export interface IndicatorDefinition {
  id: string;
  name: string;
  params: IndicatorParam[];
  display: IndicatorDisplay;
}

export interface IndicatorDisplay {
  pane: 'overlay' | 'separate';
  series: IndicatorSeriesConfig[];
}

export interface IndicatorSeriesConfig {
  type: 'line' | 'histogram';
  color: string;
  key: string;
  label: string;
  priceScale?: 'price' | 'volume';
}

export type IndicatorPaneType = 'overlay' | 'separate';

export interface ActiveIndicator {
  id: string;
  definition: IndicatorDefinition;
  paramValues: Record<string, number>;
  visible: boolean;
}

export interface IndicatorResult {
  id: string;
  series: Record<string, (number | null)[]>;
}
