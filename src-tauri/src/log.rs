//! 诊断留痕：把运行时事实写进 `<数据目录>/app.log`。
//!
//! 有些问题读代码定不了论——窗口「可见」却看不见、系统通知没出现在屏幕上，
//! 这些都是运行时事实（位置、可见性、系统是否接受通知）。留一行日志的成本极低，
//! 排查时能省下大量来回猜测。日志超过 `LOG_MAX_BYTES` 就重头写，不会无限增长。

use std::io::Write;

use tauri::{AppHandle, Manager};

const LOG_MAX_BYTES: u64 = 128 * 1024;

/// 记一行日志（同时打到 stderr）。
pub fn write(app: &AppHandle, tag: &str, msg: &str) {
    eprintln!("[{tag}] {msg}");
    let Ok(dir) = app.path().app_data_dir() else {
        return;
    };
    let path = dir.join("app.log");
    if std::fs::metadata(&path).map(|m| m.len()).unwrap_or(0) > LOG_MAX_BYTES {
        let _ = std::fs::remove_file(&path);
    }
    if let Ok(mut file) = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(&path)
    {
        let _ = writeln!(file, "[{tag}] {msg}");
    }
}
