import type { NoteMetadata } from "./types";

/**
 * 时间筛选模式
 */
export type TimeFilterMode =
  | "today"
  | "thisWeek"
  | "lastWeek"
  | "thisMonth"
  | "thisYear"
  | "custom";

export interface TimeFilter {
  mode: TimeFilterMode;
  /** 自定义起始日期 (YYYY-MM-DD)，仅 custom 模式使用 */
  customStart?: string;
  /** 自定义结束日期 (YYYY-MM-DD)，仅 custom 模式使用 */
  customEnd?: string;
}

/**
 * 匹配 YYYY-MM-DD 格式的标题
 */
const DATE_TITLE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;

/**
 * 尝试从笔记标题中解析出日期
 */
export function parseDateFromTitle(title: string): Date | null {
  const m = title.trim().match(DATE_TITLE_RE);
  if (!m) return null;
  const year = parseInt(m[1], 10);
  const month = parseInt(m[2], 10);
  const day = parseInt(m[3], 10);
  // 月份 1-12，日期 1-31
  if (month < 1 || month > 12 || day < 1 || day > 31) return null;
  const d = new Date(year, month - 1, day);
  if (d.getFullYear() !== year || d.getMonth() !== month - 1 || d.getDate() !== day) return null;
  return d;
}

/**
 * 获取某天的起始时间 (00:00:00.000)
 */
function startOfDay(d: Date): Date {
  const r = new Date(d);
  r.setHours(0, 0, 0, 0);
  return r;
}

/**
 * 获取某天的结束时间 (23:59:59.999)
 */
function endOfDay(d: Date): Date {
  const r = new Date(d);
  r.setHours(23, 59, 59, 999);
  return r;
}

/**
 * 获取本周一
 */
function startOfWeek(d: Date): Date {
  const r = new Date(d);
  const day = r.getDay();
  const diff = day === 0 ? -6 : 1 - day; // 周一为每周第一天
  r.setDate(r.getDate() + diff);
  return startOfDay(r);
}

/**
 * 获取本周日
 */
function endOfWeek(d: Date): Date {
  const r = new Date(d);
  const day = r.getDay();
  const diff = day === 0 ? 0 : 7 - day;
  r.setDate(r.getDate() + diff);
  return endOfDay(r);
}

/**
 * 获取当月第一天
 */
function startOfMonth(d: Date): Date {
  return startOfDay(new Date(d.getFullYear(), d.getMonth(), 1));
}

/**
 * 获取当月最后一天
 */
function endOfMonth(d: Date): Date {
  return endOfDay(new Date(d.getFullYear(), d.getMonth() + 1, 0));
}

/**
 * 获取当年第一天
 */
function startOfYear(d: Date): Date {
  return startOfDay(new Date(d.getFullYear(), 0, 1));
}

/**
 * 获取当年最后一天
 */
function endOfYear(d: Date): Date {
  return endOfDay(new Date(d.getFullYear(), 11, 31));
}

/**
 * 格式化日期为 YYYY-MM-DD
 */
export function formatDate(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

/**
 * 根据筛选模式计算日期范围 [start, end]
 * @param now 参考时间，默认当前时间
 */
export function getTimeFilterRange(
  filter: TimeFilter,
  now: Date = new Date(),
): { start: Date; end: Date } | null {
  switch (filter.mode) {
    case "today":
      return { start: startOfDay(now), end: endOfDay(now) };
    case "thisWeek":
      return { start: startOfWeek(now), end: endOfWeek(now) };
    case "lastWeek": {
      const last = new Date(now);
      last.setDate(last.getDate() - 7);
      return { start: startOfWeek(last), end: endOfWeek(last) };
    }
    case "thisMonth":
      return { start: startOfMonth(now), end: endOfMonth(now) };
    case "thisYear":
      return { start: startOfYear(now), end: endOfYear(now) };
    case "custom": {
      if (!filter.customStart || !filter.customEnd) return null;
      const s = new Date(filter.customStart + "T00:00:00");
      const e = new Date(filter.customEnd + "T23:59:59.999");
      if (isNaN(s.getTime()) || isNaN(e.getTime())) return null;
      return { start: s, end: e };
    }
    default:
      return null;
  }
}

/**
 * 按时间筛选笔记
 * - 标题为 YYYY-MM-DD 的笔记，按日期比较
 * - 标题非日期格式的笔记，仅在无时间筛选（filter 为 null）时展示
 */
export function filterNotesByTime(
  notes: NoteMetadata[],
  filter: TimeFilter | null,
  now: Date = new Date(),
): NoteMetadata[] {
  if (!filter) return notes;

  const range = getTimeFilterRange(filter, now);
  if (!range) return notes;

  return notes.filter((note) => {
    const d = parseDateFromTitle(note.title);
    if (!d) return false; // 非日期标题在时间筛选激活时不展示
    return d >= range.start && d <= range.end;
  });
}

/**
 * 获取当前月份名称（用于显示 X月）
 */
export function getCurrentMonthName(now: Date = new Date()): string {
  return `${now.getMonth() + 1}月`;
}

/**
 * 获取当前年份名称（用于显示 X年）
 */
export function getCurrentYearName(now: Date = new Date()): string {
  return `${now.getFullYear()}年`;
}
