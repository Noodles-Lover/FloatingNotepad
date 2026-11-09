//! 主窗口在任务栏中的显隐：开启「不在任务栏显示」后，应用只剩托盘图标。
//!
//! 窗口样式由 Rust 维护，前端只同步开关。锁窗口、计时窗口与弹窗在建窗时
//! 就已经 `skip_taskbar(true)`，因此这里只需处理 label "main" 的主窗口。

use std::sync::atomic::{AtomicBool, Ordering};

use tauri::{AppHandle, Manager};

/// 当前显隐状态：只在开关变化时才动窗口，避免每次配置同步都调用一次 COM。
pub struct TaskbarState {
    hidden: AtomicBool,
}

impl TaskbarState {
    pub fn new() -> Self {
        Self {
            hidden: AtomicBool::new(false),
        }
    }
}

/// 应用开关（由 `set_hide_taskbar` 命令调用，目标窗口在函数内部按 label 解析）。
///
/// 必须走 Tauri 的 `set_skip_taskbar`：Windows 上它调用 ITaskbarList 的
/// DeleteTab / AddTab 立即增删任务栏按钮，并在 Explorer 重启后自动重新应用。
/// 运行时改 `WS_EX_TOOLWINDOW` 只对**新建**窗口有效，撤销不了已注册的按钮。
pub fn apply(app: &AppHandle, hidden: bool) {
    let state = app.state::<TaskbarState>();
    if state.hidden.swap(hidden, Ordering::SeqCst) == hidden {
        return;
    }
    let Some(window) = app.get_webview_window("main") else {
        crate::log::write(app, "taskbar", "主窗口尚未创建，跳过任务栏显隐设置");
        return;
    };
    if let Err(e) = window.set_skip_taskbar(hidden) {
        crate::log::write(app, "taskbar", &format!("设置任务栏显隐失败: {e}"));
    } else {
        crate::log::write(
            app,
            "taskbar",
            &format!("主窗口任务栏按钮: {}", if hidden { "隐藏" } else { "显示" }),
        );
    }
}
