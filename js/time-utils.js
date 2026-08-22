// Timestamps are stored in UTC by Supabase. All user-facing dates and hours
// are deliberately rendered in the operation's official time zone.
export const NICARAGUA_TIME_ZONE = 'America/Managua';

function asValidDate(value) {
  if (value === null || value === undefined || value === '') return null;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

export function formatNicaraguaDateTime(value, fallback = '—') {
  const date = asValidDate(value);
  if (!date) return fallback;
  return new Intl.DateTimeFormat('es-NI', {
    timeZone: NICARAGUA_TIME_ZONE,
    dateStyle: 'medium',
    timeStyle: 'medium',
    hourCycle: 'h23'
  }).format(date);
}

export function formatNicaraguaDate(value, fallback = '—') {
  const date = asValidDate(value);
  if (!date) return fallback;
  return new Intl.DateTimeFormat('es-NI', {
    timeZone: NICARAGUA_TIME_ZONE,
    year: 'numeric',
    month: 'long',
    day: 'numeric'
  }).format(date);
}

export function getNicaraguaDateKey(value = new Date()) {
  const date = asValidDate(value);
  if (!date) return null;
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: NICARAGUA_TIME_ZONE,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit'
  }).formatToParts(date);
  const values = Object.fromEntries(parts.map(part => [part.type, part.value]));
  return `${values.year}-${values.month}-${values.day}`;
}
