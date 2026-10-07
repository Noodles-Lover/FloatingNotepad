import { useCallback, useEffect, useState } from "react";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import type { Mode } from "./useViewState";

export interface PopupToastState {
  text: string;
  sub: string | null;
  leaving: boolean;
  /** 停留时长（毫秒），来自 Rust 载荷：报时与任务提醒各给各的。 */
  visibleMs: number;
}

/** 载荷里没带时长时的兜底（毫秒）。 */
const TOAST_VISIBLE_FALLBACK = 5000;
/** 消失动画时长（毫秒）。 */
const TOAST_LEAVE_ANIM = 180;

/**
 * 面板展开时的顶部提示：只在面板内显示（面板未展开时由独立小窗负责）。
 * 状态在收起后保留——下次打开若还没过停留时长，它还在。
 */
export function usePopupToast(modeRef: { current: Mode }) {
  const [popupToast, setPopupToast] = useState<PopupToastState | null>(null);

  /** 关掉提示：先播消失动画，动画结束再卸载（直接卸载就看不到动画了）。 */
  const dismissToast = useCallback(() => {
    setPopupToast((prev) => (prev ? { ...prev, leaving: true } : null));
    window.setTimeout(() => setPopupToast(null), TOAST_LEAVE_ANIM);
  }, []);

  useEffect(() => {
    const unlisten: Promise<UnlistenFn> = listen<{
      text: string;
      sub: string | null;
      visible_ms?: number;
    }>(
      "popup-show",
      (ev) => {
        if (modeRef.current !== "expanded") return; // 没开面板时看独立小窗
        setPopupToast({
          text: ev.payload.text,
          sub: ev.payload.sub,
          leaving: false,
          visibleMs: ev.payload.visible_ms ?? TOAST_VISIBLE_FALLBACK,
        });
      },
    );
    return () => {
      unlisten.then((fn) => fn()).catch(() => undefined);
    };
  }, [modeRef]);

  useEffect(() => {
    if (!popupToast || popupToast.leaving) return;
    const timer = window.setTimeout(dismissToast, popupToast.visibleMs);
    return () => window.clearTimeout(timer);
  }, [popupToast, dismissToast]);

  return { popupToast, dismissToast };
}
