import { useCallback, useEffect, useState } from "react";
import { startTimer, stopTimer, timerState, type TimerState } from "../lib/windowTimer";

const IDLE: TimerState = {
  running: false,
  title: "",
  process: "",
  elapsed_ms: 0,
  edge: "right",
};

/**
 * 指定窗口的使用计时：累计在 Rust 侧（见 timer.rs），这里只取状态显示。
 * 只在计时中轮询，空闲时零开销；实例挂在 App 上，面板与挂件共用同一份状态。
 */
export function useWindowTimer() {
  const [state, setState] = useState<TimerState>(IDLE);

  // 挂载时取一次：面板收起、应用重载后都能接上正在跑的计时。
  useEffect(() => {
    timerState()
      .then(setState)
      .catch((e) => console.error("[timer] 读取状态失败:", e));
  }, []);

  useEffect(() => {
    if (!state.running) return;
    const id = window.setInterval(() => {
      timerState()
        .then(setState)
        .catch(() => {});
    }, 1000);
    return () => window.clearInterval(id);
  }, [state.running]);

  const start = useCallback(
    (hwnd: number) =>
      startTimer(hwnd)
        .then(setState)
        .catch((e) => {
          throw e instanceof Error ? e : new Error(String(e));
        }),
    [],
  );
  const stop = useCallback(() => stopTimer().then(setState), []);

  return { ...state, start, stop };
}
