import { useEffect } from "react";
import { sounds } from "../lib/sounds";

/**
 * 弹窗与任务提醒的音效由主窗口代播：那些窗口从没被用户点过，
 * Chromium 会拦掉无用户交互的自动播放——这个判断在 sounds.playOnEvent 里。
 * 弹出（目前是报时）用专门的钟声，任务提醒用通用提示音。
 */
export function useNotificationSounds() {
  useEffect(() => sounds.playOnEvent("popup-show", "bell"), []);
  useEffect(() => sounds.playOnEvent("plan-due", "notification"), []);
}
