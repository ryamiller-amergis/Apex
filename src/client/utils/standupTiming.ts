export function parseScheduleTime(time: string): { hour12: number; minute: number; period: 'AM' | 'PM' } {
  const [h24 = 9, m = 0] = time.split(':').map(Number);
  return {
    hour12: h24 % 12 || 12,
    minute: m,
    period: h24 >= 12 ? 'PM' : 'AM',
  };
}

export function toScheduleTime(hour12: number, minute: number, period: 'AM' | 'PM'): string {
  let h24 = hour12 % 12;
  if (period === 'PM') h24 += 12;
  return `${String(h24).padStart(2, '0')}:${String(minute).padStart(2, '0')}`;
}

export function formatDurationLabel(minutes: number): string {
  if (minutes < 60) return `${minutes} min`;
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return m === 0 ? `${h} hr` : `${h} hr ${m} min`;
}

export const MINUTE_OPTIONS = Array.from({ length: 12 }, (_, i) => i * 5);

export function minuteOptionsForValue(minute: number): number[] {
  return MINUTE_OPTIONS.includes(minute)
    ? MINUTE_OPTIONS
    : [...MINUTE_OPTIONS, minute].sort((a, b) => a - b);
}
