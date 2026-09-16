import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import "./ChimeView.css";

/** 与 Rust 的 `chime::Payload` 对应：时刻由 Rust 格式化，不透明度走 CSS。 */
type ChimePayload = { time: string; opacity: number };

/**
 * 整点报时小窗（由独立的 chime 窗口渲染）。
 *
 * 窗口常驻隐藏，显示不等于重新加载，所以内容靠 Rust 的 `chime-show` 事件刷新；
 * 挂载时还会主动取一次 `chime_state`——万一事件错过（webview 重建等），
 * 小窗也不会空白或停在启动时刻。
 *
 * 音效不在这里播：本窗口从没被用户点过，Chromium 会拦掉无用户交互的 audio，
 * 交由主窗口（已有用户交互）播放。
 */
export default function ChimeView() {
  const [info, setInfo] = useState<ChimePayload | null>(null);

  useEffect(() => {
    let cancelled = false;
    // 主动取一次；若期间已收到事件则以事件为准（函数式更新避免竞态）。
    invoke<ChimePayload>("chime_state")
      .then((s) => {
        if (!cancelled) setInfo((prev) => prev ?? s);
      })
      .catch((e) => console.error("[chime] 取状态失败:", e));
    const unlisten: Promise<UnlistenFn> = listen<ChimePayload>("chime-show", (ev) => {
      if (!cancelled) setInfo(ev.payload);
    });
    return () => {
      cancelled = true;
      unlisten.then((fn) => fn()).catch(() => undefined);
    };
  }, []);

  if (!info) return null;

  return (
    <div className="chime-card" style={{ opacity: info.opacity }}>
      <span className="chime-time">{info.time}</span>
    </div>
  );
}
