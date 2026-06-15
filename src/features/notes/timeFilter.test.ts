import { describe, it, expect } from "vitest";
import {
  parseDateFromTitle,
  getTimeFilterRange,
  filterNotesByTime,
  formatDate,
  getCurrentMonthName,
  getCurrentYearName,
} from "./timeFilter";
import type { NoteMetadata } from "./types";

function makeNote(title: string): NoteMetadata {
  return {
    id: title,
    title,
    fileName: `${title}.md`,
    category: "",
    tags: [],
    createdAt: "2026-01-01T00:00:00Z",
    updatedAt: "2026-01-01T00:00:00Z",
    wordCount: 10,
    preview: "test",
  };
}

// 固定参考时间：2026-06-15 (周一) 用于确定性测试
const refNow = new Date("2026-06-15T12:00:00");

describe("parseDateFromTitle", () => {
  it("解析 YYYY-MM-DD 标题", () => {
    const d = parseDateFromTitle("2026-06-15");
    expect(d).not.toBeNull();
    expect(d!.getFullYear()).toBe(2026);
    expect(d!.getMonth()).toBe(5); // 6月
    expect(d!.getDate()).toBe(15);
  });

  it("带空格的标题仍可解析", () => {
    const d = parseDateFromTitle("  2026-01-01  ");
    expect(d).not.toBeNull();
  });

  it("非法日期返回 null", () => {
    expect(parseDateFromTitle("2026-13-01")).toBeNull();
    expect(parseDateFromTitle("2026-02-30")).toBeNull();
    expect(parseDateFromTitle("hello")).toBeNull();
    expect(parseDateFromTitle("2026-1-1")).toBeNull(); // 需要两位
    expect(parseDateFromTitle("")).toBeNull();
  });
});

describe("getTimeFilterRange", () => {
  it("today", () => {
    const r = getTimeFilterRange({ mode: "today" }, refNow)!;
    expect(r).not.toBeNull();
    expect(formatDate(r.start)).toBe("2026-06-15");
    expect(formatDate(r.end)).toBe("2026-06-15");
  });

  it("thisWeek (周一~周日)", () => {
    const r = getTimeFilterRange({ mode: "thisWeek" }, refNow)!;
    expect(formatDate(r.start)).toBe("2026-06-15"); // 周一
    expect(formatDate(r.end)).toBe("2026-06-21"); // 周日
  });

  it("lastWeek", () => {
    const r = getTimeFilterRange({ mode: "lastWeek" }, refNow)!;
    expect(formatDate(r.start)).toBe("2026-06-08"); // 上周一
    expect(formatDate(r.end)).toBe("2026-06-14"); // 上周日
  });

  it("thisMonth", () => {
    const r = getTimeFilterRange({ mode: "thisMonth" }, refNow)!;
    expect(formatDate(r.start)).toBe("2026-06-01");
    expect(formatDate(r.end)).toBe("2026-06-30");
  });

  it("thisYear", () => {
    const r = getTimeFilterRange({ mode: "thisYear" }, refNow)!;
    expect(formatDate(r.start)).toBe("2026-01-01");
    expect(formatDate(r.end)).toBe("2026-12-31");
  });

  it("custom", () => {
    const r = getTimeFilterRange(
      { mode: "custom", customStart: "2026-03-01", customEnd: "2026-03-15" },
      refNow,
    )!;
    expect(formatDate(r.start)).toBe("2026-03-01");
    expect(formatDate(r.end)).toBe("2026-03-15");
  });

  it("custom 缺少参数返回 null", () => {
    expect(getTimeFilterRange({ mode: "custom" })).toBeNull();
    expect(getTimeFilterRange({ mode: "custom", customStart: "2026-01-01" })).toBeNull();
  });
});

describe("filterNotesByTime", () => {
  const notes = [
    makeNote("2026-06-15"),
    makeNote("2026-06-16"),
    makeNote("2026-06-10"),
    makeNote("普通笔记"),
    makeNote("会议纪要"),
  ];

  it("null filter 不过滤", () => {
    const r = filterNotesByTime(notes, null);
    expect(r).toHaveLength(5);
  });

  it("today 只保留今天日期的笔记", () => {
    const r = filterNotesByTime(notes, { mode: "today" }, refNow);
    const titles = r.map((n) => n.title);
    expect(titles).toContain("2026-06-15");
    expect(titles).not.toContain("2026-06-16");
    expect(titles).not.toContain("2026-06-10");
    expect(titles).not.toContain("普通笔记");
    expect(titles).not.toContain("会议纪要");
  });

  it("thisWeek 保留本周日期", () => {
    const r = filterNotesByTime(notes, { mode: "thisWeek" }, refNow);
    const titles = r.map((n) => n.title);
    expect(titles).toContain("2026-06-15");
    expect(titles).toContain("2026-06-16");
    expect(titles).not.toContain("2026-06-10"); // 上周
  });

  it("时间筛选激活时普通笔记不展示", () => {
    const r = filterNotesByTime(notes, { mode: "lastWeek" }, refNow);
    const titles = r.map((n) => n.title);
    expect(titles).not.toContain("普通笔记");
    expect(titles).not.toContain("会议纪要");
    expect(titles).toContain("2026-06-10");
  });
});

describe("getCurrentMonthName / getCurrentYearName", () => {
  it("返回当前月份名称", () => {
    expect(getCurrentMonthName(refNow)).toBe("6月");
  });

  it("返回当前年份名称", () => {
    expect(getCurrentYearName(refNow)).toBe("2026年");
  });
});
