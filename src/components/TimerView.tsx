import { useEffect, useState } from "react";
import { formatElapsed, timerState, type TimerState } from "../lib/windowTimer";
import { useBlockedContextMenu } from "../hooks/useBlockedContextMenu";
/** 组件样式：体量小（不足百行），直接跟在组件里，不再单独建 css 文件。
    窗口高度在 Rust 侧按挂件定一次（封顶 40px），`40vh` 即窗口高的 40%。 */
const styles = `
/* 计时窗口的文字样式：深墨字 + 纸色字形描边
   （-webkit-text-stroke 描在字形轮廓上，不是画框），
   不铺底色也没有外框：桌面上不留任何色块与线条。
   描边会向内吃一点字面，所以字重给到 700，笔画才不显得细。 */
.timer-view {
  height: 100%;
  display: flex;
  align-items: center;
  font-size: 40vh;
  font-weight: 700;
  color: var(--ink);
  -webkit-text-stroke: 2px var(--paper);
  opacity: 0.95;
  font-variant-numeric: tabular-nums;
  overflow: hidden;
  user-select: none;
  -webkit-user-select: none;
}
`;

/**
 * 计时显示（由独立的计时窗口渲染，窗口常驻穿透）。
 *
 * 文字要落在挂件之外，而挂件窗口就那么大，所以由独立窗口承载：Rust 把窗口贴在
 * 挂件的另一侧，窗口高度约为挂件的六成，字号取 `45vh`——合起来约挂件高度的四分之一强。
 */
export default function TimerView() {
  const [state, setState] = useState<TimerState | null>(null);

  // 纯展示窗口：屏蔽默认右键菜单，交互由 Rust 侧穿透处理。
  useBlockedContextMenu();

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
      <style>{styles}</style>
      {formatElapsed(state.elapsed_ms)}
    </div>
  );
}