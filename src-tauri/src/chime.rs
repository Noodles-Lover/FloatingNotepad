//! 整点报时：每个整点提示一次当前时刻。
//!
//! 只负责「什么时候报」；怎么显示、音效怎么放都交给通用的 [`crate::popup`]——
//! 面板没开时弹小窗，面板开着时由主窗口在面板内显示。

use std::sync::atomic::{AtomicBool, Ordering};
use std::thread;
use std::time::Duration;

use tauri::{AppHandle, Manager};

use crate::{db, popup};

/// 报时的运行时状态。
pub struct ChimeState {
    /// 功能开关（功能面板控制）。关闭时到点不弹窗。
    pub enabled: AtomicBool,
}

impl ChimeState {
    pub fn new() -> Self {
        Self {
            enabled: AtomicBool::new(false),
        }
    }
}

/// 启动报时线程：睡到下一个整点，弹窗后再睡到下一个整点。
pub fn start(app: AppHandle) {
    thread::spawn(move || loop {
        // 睡到整点：即使功能关闭也要走时钟，否则重新开启后要等很久才第一次响。
        thread::sleep(Duration::from_millis(ms_until_next_hour()));
        if !app.state::<ChimeState>().enabled.load(Ordering::SeqCst) {
            continue;
        }
        if let Err(e) = ring(&app) {
            crate::log::write(&app, "chime", &format!("显示失败: {e}"));
        }
    });
}

/// 立刻弹一次报时（挂件右键菜单「试一下报时」调用）：与到点报时同一条路径。
pub fn ring(app: &AppHandle) -> Result<(), String> {
    popup::show(app, now_hhmm(), None)
}

/// 写入开关与不透明度（功能面板在加载配置与改动时调用）。
pub fn apply(app: &AppHandle, enabled: bool, opacity: f64) {
    app.state::<ChimeState>()
        .enabled
        .store(enabled, Ordering::SeqCst);
    popup::set_opacity(app, opacity);
}

/// 本地时刻的「HH:MM」。
pub fn now_hhmm() -> String {
    db::local_time().0
}

/// 距下一个整点还有多少毫秒（末尾多等 250ms，免得到点前就弹）。
fn ms_until_next_hour() -> u64 {
    let (_, minute, second) = db::local_time();
    ((60 - minute) * 60 - second).max(0) as u64 * 1000 + 250
}
