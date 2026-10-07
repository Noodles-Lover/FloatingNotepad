import { useEffect } from "react";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { isSoundName, sounds } from "../lib/sounds";

/**
 * 弹出小窗的音效由主窗口代播：那些窗口从没被用户点过，
 * Chromium 会拦掉无用户交互的自动播放——这个判断属于音效自己。
 *
 * 播哪个声音由 Rust 的载荷决定（报时是钟声，任务提醒是通知音），
 * 载荷里的名字不认识就忽略。
 */
export function useNotificationSounds() {
  useEffect(() => {
    let cancelled = false;
    const unlisten: Promise<UnlistenFn> = listen<{ sound?: string }>(
      "popup-show",
      (ev) => {
        const name = ev.payload.sound;
        if (!cancelled && name && isSoundName(name)) sounds.play(name);
      },
    );
    return () => {
      cancelled = true;
      unlisten.then((fn) => fn()).catch(() => undefined);
    };
  }, []);
}