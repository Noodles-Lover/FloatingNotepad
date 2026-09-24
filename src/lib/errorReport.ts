import { logEvent } from "./log";

/**
 * 把未捕获的前端错误上报到 Rust 日志。
 *
 * 前端出问题时界面往往只是空白，控制台输出在发布版里看不到——只有落到 Rust 日志
 * 才能在事后对齐运行时事实（与 src-tauri/src/log.rs 的目的相同）。
 */
export function installErrorReporting(): void {
  window.addEventListener("error", (e) => {
    const err = e.error as Error | undefined;
    const where = e.filename ? ` @ ${e.filename}:${e.lineno}:${e.colno}` : "";
    logEvent("ui-error", `${e.message}${where}${err?.stack ? ` | ${err.stack}` : ""}`);
  });
  window.addEventListener("unhandledrejection", (e) => {
    const r = e.reason;
    const msg = r instanceof Error ? `${r.message} | ${r.stack ?? ""}` : String(r);
    logEvent("ui-error", `unhandled rejection: ${msg}`);
  });
}
