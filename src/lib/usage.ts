import { invoke } from "@tauri-apps/api/core";

/** 一段连续使用某个应用的区间（Unix 毫秒）。 */
export interface UsageSession {
  app: string;
  start: number;
  end: number;
}

/** 某个应用当天的累计使用时长。 */
export interface UsageTotal {
  app: string;
  ms: number;
}

/** 一天的使用数据：sessions 画时间线，totals 画饼图。 */
export interface UsageDay {
  day: string;
  sessions: UsageSession[];
  totals: UsageTotal[];
}

/** 全部历史范围内各应用的总时长（时间线始终只看当天）。 */
export interface UsageTotals {
  totals: UsageTotal[];
  /** 有记录的首 / 末日期；无记录时为空串。 */
  from_day: string;
  to_day: string;
}

/** 读取当天的使用统计（后端只统计当天，无需传日期）。 */
export const loadUsage = (): Promise<UsageDay> => invoke<UsageDay>("load_usage");

/** 读取全部历史的各应用总时长与日期范围。 */
export const loadUsageAll = (): Promise<UsageTotals> => invoke<UsageTotals>("load_usage_all");

/** 同步「记录应用使用时间」开关给 Rust 采样器。 */
export const setUsageTracking = (enabled: boolean): Promise<void> =>
  invoke<void>("set_usage_tracking", { enabled });
