import { invoke } from "@tauri-apps/api/core";

/** 候选窗口（可计时目标）。 */
export interface WindowInfo {
  hwnd: number;
  title: string;
  /** 所属进程名（如 `Code.exe`）；同一进程可能有多个窗口。 */
  process: string;
}

/** 计时状态：running 为 true 时前端每秒刷新 elapsed_ms。 */
export interface TimerState {
  running: boolean;
  title: string;
  process: string;
  elapsed_ms: number;
  /** 挂件停靠侧（`left` / `right`）：计时窗口贴在另一侧，文字据此靠边对齐。 */
  edge: string;
}

export const listWindows = (): Promise<WindowInfo[]> => invoke<WindowInfo[]>("list_windows");

export const startTimer = (hwnd: number): Promise<TimerState> =>
  invoke<TimerState>("start_timer", { hwnd });

export const stopTimer = (): Promise<TimerState> => invoke<TimerState>("stop_timer");

export const timerState = (): Promise<TimerState> => invoke<TimerState>("timer_state");

/** 毫秒 → 「M:SS」；超过一小时则是「H:MM:SS」。 */
export function formatElapsed(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const mm = h > 0 ? String(m).padStart(2, "0") : String(m);
  return `${h > 0 ? `${h}:` : ""}${mm}:${String(s).padStart(2, "0")}`;
}
