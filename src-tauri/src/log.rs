//! 诊断留痕：把运行时事实写进 `<数据目录>/logs/app-YYYY-MM-DD.log`。
//!
//! 有些问题读代码定不了论——窗口「可见」却看不见、通知没出现在屏幕上、进程「静默
//! 退出」不留任何痕迹，这些都得靠运行时事实去对。留一行日志成本极低，却能省下大量
//! 来回猜测。
//!
//! 日志按天分文件，启动时清掉 [`LOG_KEEP_DAYS`] 天前的旧文件；单个文件超过
//! [`LOG_MAX_BYTES`] 就从头写，避免一天内无限增长。刻意不依赖数据库与第三方日期库：
//! 数据库若起不来，日志反而更该写得出来。

use std::io::Write;
use std::path::PathBuf;
use std::time::{Duration, SystemTime};

use tauri::{AppHandle, Manager};

/// 单个日志文件的上限，超过就从头写，避免一天内无限增长。
const LOG_MAX_BYTES: u64 = 256 * 1024;
/// 日志保留天数：启动时删除修改时间早于「此刻减该天数」的旧文件。
const LOG_KEEP_DAYS: u64 = 7;

/// 记一行日志（带本地时间戳，同时打到 stderr）。
pub fn write(app: &AppHandle, tag: &str, msg: &str) {
    let line = format!("[{}] [{tag}] {msg}", stamp());
    eprintln!("{line}");
    let Ok(dir) = logs_dir(app) else {
        return;
    };
    let path = dir.join(format!("floatingnotepad-{}.log", day()));
    if std::fs::metadata(&path).map(|m| m.len()).unwrap_or(0) > LOG_MAX_BYTES {
        let _ = std::fs::remove_file(&path);
    }
    if let Ok(mut file) = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(&path)
    {
        let _ = writeln!(file, "{line}");
    }
}

/// 启动时清掉保留期之外的日志文件。
pub fn prune(app: &AppHandle) {
    let Ok(dir) = logs_dir(app) else {
        return;
    };
    let Some(cutoff) =
        SystemTime::now().checked_sub(Duration::from_secs(LOG_KEEP_DAYS * 24 * 60 * 60))
    else {
        return;
    };
    let Ok(entries) = std::fs::read_dir(&dir) else {
        return;
    };
    for entry in entries.flatten() {
        let stale = entry
            .metadata()
            .and_then(|m| m.modified())
            .map(|t| t < cutoff)
            .unwrap_or(false);
        if stale {
            let _ = std::fs::remove_file(entry.path());
        }
    }
}

/// 安装 panic 钩子：崩溃前先把 panic 信息落进日志。
///
/// release 构建用 `panic = "abort"`，进程会直接终止、不留界面提示；钩子仍会在 abort
/// 之前执行，是「静默关闭」时唯一能留下的线索。
pub fn install_panic_hook(app: AppHandle) {
    std::panic::set_hook(Box::new(move |info| {
        write(&app, "panic", &info.to_string());
    }));
}

/// 日志目录 `<数据目录>/logs`，不存在则创建。
fn logs_dir(app: &AppHandle) -> Result<PathBuf, ()> {
    let dir = app.path().app_data_dir().map_err(|_| ())?.join("logs");
    std::fs::create_dir_all(&dir).map_err(|_| ())?;
    Ok(dir)
}

/// 本地日期 `YYYY-MM-DD`。
fn day() -> String {
    let (y, mo, d, ..) = local_now();
    format!("{y:04}-{mo:02}-{d:02}")
}

/// 本地时刻 `HH:MM:SS`。
fn stamp() -> String {
    let (_, _, _, h, mi, s) = local_now();
    format!("{h:02}:{mi:02}:{s:02}")
}

/// 本地时间（年, 月, 日, 时, 分, 秒）。
#[cfg(target_os = "windows")]
fn local_now() -> (u16, u16, u16, u16, u16, u16) {
    use windows::Win32::System::SystemInformation::GetLocalTime;
    let t = unsafe { GetLocalTime() };
    (t.wYear, t.wMonth, t.wDay, t.wHour, t.wMinute, t.wSecond)
}

/// 非 Windows 平台留空实现（本项目只在 Windows 发布），保证可编译。
#[cfg(not(target_os = "windows"))]
fn local_now() -> (u16, u16, u16, u16, u16, u16) {
    (0, 0, 0, 0, 0, 0)
}
