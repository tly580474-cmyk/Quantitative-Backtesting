import type { Time } from 'lightweight-charts';

export function toChartTime(value: string): Time {
  if (!value.includes(' ')) return value as Time;
  const normalized = value.trim().replace(' ', 'T');
  const withSeconds = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(normalized)
    ? `${normalized}:00`
    : normalized;
  return Math.floor(new Date(`${withSeconds}+08:00`).getTime() / 1000) as Time;
}

export function chartTimeKey(value: Time): string {
  if (typeof value === 'string' || typeof value === 'number') return String(value);
  return `${value.year}-${String(value.month).padStart(2, '0')}-${String(value.day).padStart(2, '0')}`;
}
