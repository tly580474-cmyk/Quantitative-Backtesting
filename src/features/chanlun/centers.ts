import type {
  ChanCenter,
  ChanCenterLevel,
  ChanDirection,
  ChanPen,
  ChanSegment,
  ChanStructureStatus,
} from './types';

type CenterComponent = ChanPen | ChanSegment;

interface ComponentView {
  id: string;
  startSourceIndex: number;
  endSourceIndex: number;
  startTime: string;
  endTime: string;
  high: number;
  low: number;
  status: ChanStructureStatus;
  confirmedAtIndex: number | null;
  confirmedAt: string | null;
}

function view(component: CenterComponent): ComponentView {
  return {
    id: component.id,
    startSourceIndex: component.startSourceIndex,
    endSourceIndex: component.endSourceIndex,
    startTime: component.startTime,
    endTime: component.endTime,
    high: Math.max(component.startPrice, component.endPrice),
    low: Math.min(component.startPrice, component.endPrice),
    status: component.status,
    confirmedAtIndex: component.confirmedAtIndex,
    confirmedAt: component.confirmedAt,
  };
}

function hasPositiveOverlap(low: number, high: number, zd: number, zg: number): boolean {
  return Math.max(low, zd) < Math.min(high, zg);
}

function isConfirmed(component: ComponentView): boolean {
  return component.status === 'confirmed'
    && component.confirmedAtIndex != null
    && component.confirmedAt != null;
}

function getBreakoutDirection(component: ComponentView, zd: number, zg: number): ChanDirection | null {
  if (component.low > zg) return 'up';
  if (component.high < zd) return 'down';
  return null;
}

/**
 * 从同级、连续结构提取标准中枢。核心区由前三个结构确定，后续只延伸时间和
 * 极值，不回写 ZD/ZG；候选结构不能确认形成或离开，以保证任一历史前缀可复算。
 */
export function buildCenters(
  components: readonly CenterComponent[],
  level: ChanCenterLevel,
): ChanCenter[] {
  const items = components.map(view);
  const centers: ChanCenter[] = [];
  let cursor = 0;

  while (cursor + 2 < items.length) {
    const seed = items.slice(cursor, cursor + 3);
    const zd = Math.max(...seed.map((component) => component.low));
    const zg = Math.min(...seed.map((component) => component.high));
    if (zd >= zg) {
      cursor += 1;
      continue;
    }

    const third = seed[2];
    const confirmed = isConfirmed(third);
    let endComponentIndex = cursor + 2;
    let gg = Math.max(...seed.map((component) => component.high));
    let dd = Math.min(...seed.map((component) => component.low));
    let lifecycle: ChanCenter['lifecycle'] = confirmed ? 'active' : 'forming';
    let breakout: ChanDirection | null = null;
    let completedAtIndex: number | null = null;
    let completedAt: string | null = null;
    let nextCursor = cursor + 1;

    for (let index = cursor + 3; index < items.length; index += 1) {
      const component = items[index];
      if (hasPositiveOverlap(component.low, component.high, zd, zg)) {
        endComponentIndex = index;
        gg = Math.max(gg, component.high);
        dd = Math.min(dd, component.low);
        continue;
      }

      const direction = getBreakoutDirection(component, zd, zg);
      if (direction && confirmed && isConfirmed(component)) {
        lifecycle = 'completed';
        breakout = direction;
        completedAtIndex = component.confirmedAtIndex;
        completedAt = component.confirmedAt;
        nextCursor = index;
      }
      break;
    }

    const end = items[endComponentIndex];
    const componentIds = items
      .slice(cursor, endComponentIndex + 1)
      .map((component) => component.id);
    centers.push({
      id: `${level}-center:${seed[0].startSourceIndex}->${third.endSourceIndex}:${zd}:${zg}`,
      level,
      startComponentIndex: cursor,
      endComponentIndex,
      startSourceIndex: seed[0].startSourceIndex,
      endSourceIndex: end.endSourceIndex,
      startTime: seed[0].startTime,
      endTime: end.endTime,
      zd,
      zg,
      gg,
      dd,
      status: confirmed ? 'confirmed' : 'candidate',
      lifecycle,
      expanded: componentIds.length >= 9,
      componentIds,
      extensionCount: Math.max(0, componentIds.length - 3),
      breakoutDirection: breakout,
      confirmedAtIndex: confirmed ? third.confirmedAtIndex : null,
      confirmedAt: confirmed ? third.confirmedAt : null,
      completedAtIndex,
      completedAt,
    });

    if (lifecycle !== 'completed') break;
    cursor = nextCursor;
  }

  return centers;
}
