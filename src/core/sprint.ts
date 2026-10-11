const SPRINT = /Sprint\s+(\d+)\s*\|\s*(\d{1,2})\.(\d{1,2})\.?\s*-\s*(\d{1,2})\.(\d{1,2})/i;

// Date.UTC silently rolls invalid dates over (31.2 becomes 3.3), so check the calendar.
function utcDate(year: number, month: number, day: number, endOfDay: boolean): Date | null {
  const d = endOfDay
    ? new Date(Date.UTC(year, month - 1, day, 23, 59, 59, 999))
    : new Date(Date.UTC(year, month - 1, day));
  const valid = d.getUTCFullYear() === year && d.getUTCMonth() === month - 1 && d.getUTCDate() === day;
  return valid ? d : null;
}

// Sprint section names look like "Sprint 41 | 5.10 - 9.10" (day.month). Ranges are
// inclusive in UTC and may cross the new year. Anything invalid returns null.
export function parseSprintSection(name: string, year: number): { number: number; start: Date; end: Date } | null {
  const m = SPRINT.exec(name);
  if (!m) return null;
  const [sd, sm, ed, em] = [m[2], m[3], m[4], m[5]].map(Number);
  const endYear = em < sm ? year + 1 : year;
  const start = utcDate(year, sm, sd, false);
  const end = utcDate(endYear, em, ed, true);
  if (!start || !end || end < start) return null;
  return { number: Number(m[1]), start, end };
}

export function isCurrentSprint(name: string, now: Date): boolean {
  const year = now.getUTCFullYear();
  return [year, year - 1].some((y) => {
    const s = parseSprintSection(name, y);
    return !!s && now >= s.start && now <= s.end;
  });
}
