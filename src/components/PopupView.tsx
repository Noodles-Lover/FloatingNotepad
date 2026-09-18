import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import "./PopupView.css";

/** 与 Rust 的 `popup::Payload` 对应：内容由 Rust 下发，不透明度也由它决定。 */
type PopupPayload = { text: string; sub: string | null; opacity: number };

/**
 * 通用弹出小窗（由独立的 popup 窗口渲染）。
 *
 * 只认「一段内容」：谁弹的、为什么弹它不关心。窗口常驻隐藏，显示不等于重新加载，
 * 所以内容靠 Rust 的 `popup-show` 事件下发；挂载时还会主动取一次 `popup_state`，
 * 万一事件错过也不会空白。停留时长与收起时机由 Rust 决定，这里只负责画。
 *
 * 音效不在这里播：本窗口从没被用户点过，Chromium 会拦掉无用户交互的 audio，
 * 交由主窗口播放。
 */
export default function PopupView() {
  const [info, setInfo] = useState<PopupPayload | null>(null);

  useEffect(() => {
    let cancelled = false;
    // 主动取一次；若期间已收到事件则以事件为准（函数式更新避免竞态）。
    invoke<PopupPayload>("popup_state")
      .then((s) => {
        if (!cancelled) setInfo((prev) => prev ?? s);
      })
      .catch((e) => console.error("[popup] 取内容失败:", e));
    const unlisten: Promise<UnlistenFn> = listen<PopupPayload>("popup-show", (ev) => {
      if (!cancelled) setInfo(ev.payload);
    });
    return () => {
      cancelled = true;
      unlisten.then((fn) => fn()).catch(() => undefined);
    };
  }, []);

  if (!info) return null;

  return (
    <div className={`popup-card ${info.sub ? "wide" : ""}`} style={{ opacity: info.opacity }}>
      <div className="popup-body">
        {info.text.split("\n").map((line, i) => (
          <span className="popup-line" key={i}>
            {line}
          </span>
        ))}
        {info.sub && <span className="popup-sub">{info.sub}</span>}
      </div>
    </div>
  );
}
