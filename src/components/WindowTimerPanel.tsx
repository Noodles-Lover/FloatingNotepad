import { useEffect, useState } from "react";
import { formatElapsed, listWindows, type TimerState, type WindowInfo } from "../lib/windowTimer";

interface Props {
  /** 计时状态（来自 App 上的 useWindowTimer，与挂件显示同源）。 */
  state: TimerState;
  /** 开始计时：按窗口句柄，时长清零重算。 */
  onStart: (hwnd: number) => void;
  /** 停止计时并清空显示。 */
  onStop: () => void;
  onClose: () => void;
}

/**
 * 窗口计时选择面板（覆盖层）：挑一个窗口开始计时，或停止当前计时。
 *
 * 列表在打开时取一次——窗口随时会开关，需要时点「刷新」。
 */
export default function WindowTimerPanel({ state, onStart, onStop, onClose }: Props) {
  const [windows, setWindows] = useState<WindowInfo[]>([]);
  const [msg, setMsg] = useState("");

  const refresh = () => {
    listWindows()
      .then(setWindows)
      .catch((e) => setMsg(`读取窗口失败：${e}`));
  };

  useEffect(refresh, []);

  return (
    <div className="skin-overlay" onClick={onClose}>
      <div className="skin-panel" onClick={(e) => e.stopPropagation()}>
        <div className="skin-head">
          <span>窗口计时</span>
          <span className="skin-x" onClick={onClose} title="关闭">
            ×
          </span>
        </div>
        <div className="skin-body">
          <div className="skin-group-title">当前</div>
          {state.running ? (
            <div className="set-row">
              <div className="set-label">
                <span>
                  {state.process} · {state.title}
                </span>
                <span className="set-val">{formatElapsed(state.elapsed_ms)}</span>
              </div>
              <div className="set-actions">
                <button className="set-btn" onClick={onStop}>
                  停止计时
                </button>
              </div>
            </div>
          ) : (
            <div className="skin-empty">未在计时。选一个窗口开始：只有它在前台时才累计。</div>
          )}

          <div className="skin-group-title">可选窗口</div>
          {windows.length === 0 ? (
            <div className="skin-empty">没有可选窗口（当前没有可见的其它应用窗口）。</div>
          ) : (
            <div className="win-list">
              {windows.map((w) => (
                <button
                  key={w.hwnd}
                  className="win-item"
                  onClick={() => {
                    onStart(w.hwnd);
                    onClose();
                  }}
                >
                  <span className="win-proc">{w.process}</span>
                  <span className="win-title">{w.title}</span>
                </button>
              ))}
            </div>
          )}

          <div className="set-actions">
            <button className="set-btn" onClick={refresh}>
              刷新窗口
            </button>
          </div>
          {msg && <div className="set-hint">{msg}</div>}
        </div>
      </div>
    </div>
  );
}
