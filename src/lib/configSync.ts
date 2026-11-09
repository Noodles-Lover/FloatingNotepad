import { invoke } from "@tauri-apps/api/core";
import { setPlanNotify } from "./plans";
import { logEvent } from "./log";
import type { AppConfig } from "./config";

/**
 * 配置 → Rust 的单向桥接：前端只管把用户设置同步过去，
 * Rust 侧才是这些开关（穿透锁延时、全屏穿透、使用采样、报时、任务提醒、任务栏显隐）的实际消费方。
 * 收拢在一处，避免散落在改动入口里各写一遍、漏同步。
 */

/** 把「自动收起延时」同步给 Rust：穿透解锁锁的自动隐藏用同一节奏。 */
export function syncLockDelay(delayMs: number): void {
  invoke("set_lock_hide_delay", { delayMs }).catch((e) =>
    console.error("[lock] 同步收起延时失败:", e),
  );
}

/** 把「全屏自动穿透」开关同步给 Rust。 */
export function syncFullscreenPassthrough(enabled: boolean): void {
  invoke("set_fullscreen_passthrough", { enabled }).catch((e) =>
    console.error("[fullscreen] 同步开关失败:", e),
  );
}

/** 把「记录应用使用时间」开关同步给 Rust 采样器。 */
export function syncUsageTracking(enabled: boolean): void {
  invoke("set_usage_tracking", { enabled }).catch((e) =>
    console.error("[usage] 同步开关失败:", e),
  );
}

/** 把「整点报时」开关与闲置透明度同步给 Rust（小窗按此透明度显示）。 */
export function syncChime(enabled: boolean, opacity: number): void {
  invoke("set_chime", { enabled, opacity }).catch((e) =>
    console.error("[chime] 同步失败:", e),
  );
}

/** 同步「任务提醒」总开关给 Rust（到点由它弹小窗）。 */
export function syncPlanNotify(enabled: boolean): void {
  setPlanNotify(enabled).catch((e) => console.error("[plans] 同步开关失败:", e));
}

/** 把「不在任务栏显示」开关同步给 Rust（主窗口样式由 Rust 维护）。 */
export function syncHideTaskbar(hidden: boolean): void {
  invoke("set_hide_taskbar", { hidden }).catch((e) =>
    console.error("[taskbar] 同步开关失败:", e),
  );
}

/**
 * 把面板形态同步给 Rust：报时 / 任务提醒据此决定弹独立小窗还是广播给面板内提示条。
 * 形态的真相源是 `useViewState`，所有展开/收起入口都收敛到 `view.mode`，所以只需在
 * App 里监听它变化并调这里，不在各入口各写一遍。
 *
 * 同步失败必须留痕：Rust 状态停在旧值时表现是「有内容但看不见」，只打 console 查不到，
 * 因此同时写进 Rust 管理的日志文件。
 */
export function syncPanelExpanded(expanded: boolean): void {
  invoke("set_panel_expanded", { expanded }).catch((e) => {
    console.error("[popup] 同步面板形态失败:", e);
    logEvent("popup", `同步面板形态失败: ${String(e)}`);
  });
}

/** 一次把配置里所有需要 Rust 感知的开关同步过去。 */
export function applyConfigToRust(cfg: AppConfig): void {
  syncLockDelay(cfg.autoCloseDelay);
  syncFullscreenPassthrough(cfg.fullscreenPassthrough);
  syncUsageTracking(cfg.usageTracking);
  syncChime(cfg.chime, cfg.idleOpacity);
  syncPlanNotify(cfg.planNotify);
  syncHideTaskbar(cfg.hideTaskbar);
}
