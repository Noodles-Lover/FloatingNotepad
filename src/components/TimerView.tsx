import { useEffect, useState } from "react";
import { formatElapsed, timerState, type TimerState } from "../lib/windowTimer";
import "./TimerView.css";

/**
 * 计时显示（由独立的计时窗口渲染，窗口常驻穿透）。
 *
 * 文字要落在挂件之外，而挂件窗口就那么大，所以由独立窗口承载：Rust 把窗口贴在
 * 挂件的另一侧，窗口高度约为挂件的六成，字号取 `45vh`——合起来约挂件高度的四分之一强。
 */
export default function TimerView() {
  const [state, setState] = useState<TimerState | null>(null);

  // 计时窗口不吃交互：屏蔽 WebView2 的默认右键菜单（上一页 / 重新加载 / 检查）。
  useEffect(() => {
    const block = (e: MouseEvent) => e.preventDefault();
    document.addEventListener("contextmenu", block);
    return () => document.removeEventListener("contextmenu", block);
  }, []);

  useEffect(() => {
    let alive = true;
    const tick = () => {
      timerState()
        .then((s) => {
          if (alive) setState(s);
        })
        .catch(() => {});
    };
    tick();
    const id = window.setInterval(tick, 1000);
    return () => {
      alive = false;
      window.clearInterval(id);
    };
  }, []);

  if (!state?.running) return null;
  return (
    <div className={`timer-view ${state.edge === "left" ? "align-left" : "align-right"}`}>
      {formatElapsed(state.elapsed_ms)}
    </div>
  );
}