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

/** 读取当天的使用统计（后端只统计当天，无需传日期）。 */
export const loadUsage = (): Promise<UsageDay> => invoke<UsageDay>("load_usage");

/** 同步「记录应用使用时间」开关给 Rust 采样器。 */
export const setUsageTracking = (enabled: boolean): Promise<void> =>
  invoke<void>("set_usage_tracking", { enabled });
