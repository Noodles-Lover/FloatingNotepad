import { invoke } from "@tauri-apps/api/core";

/**
 * 关键 UI 操作留痕：日志文件由 Rust 统一管理，这里只把事件上报过去。
 *
 * 只用于低频事件（面板开合、隐藏挂件等）——高频行为（鼠标靠近滑出、光标轮询）
 * 不记，避免把日志淹掉。上报失败静默：留痕本身不该反过来影响功能。
 */
export function logEvent(tag: string, msg: string): void {
  invoke("log_event", { tag, msg }).catch(() => undefined);
}
