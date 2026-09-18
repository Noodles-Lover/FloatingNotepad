//! 系统通知：把一段文字交给 Windows 通知中心（任务提醒用它）。
//!
//! 自己画弹窗在全屏/游戏里打扰不打扰用户，得自己判断；系统通知把这层交给系统——
//! 它知道当前是不是全屏、要不要静默、进不进通知中心。
//!
//! **Windows 的额外要求**：通知只对「已安装」的应用生效——系统要求调用方的
//! AppUserModelID 在开始菜单里有对应快捷方式，没有的话通知会被直接丢掉
//! （`tauri-winrt-notification` 的原话：程序若未安装，请先用 `POWERSHELL_APP_ID`）。
//! 安装版由安装器建快捷方式，开发/绿色版没有，所以 [`prepare`] 启动时用
//! [`crate::shortcut`] 自己补一个。

use tauri::AppHandle;
use tauri_plugin_notification::NotificationExt;

use crate::{log, shortcut};

/// 发一条通知。标题由调用方给（通知中心里显示的第一行）。
pub fn send(app: &AppHandle, title: &str, body: &str) -> Result<(), String> {
    let result = app.notification().builder().title(title).body(body).show();
    // 留痕：「发出去了但没显示」和「根本没发出去」在界面上看不出区别。
    match &result {
        Ok(()) => log::write(app, "notify", &format!("已发送: {body}")),
        Err(e) => log::write(app, "notify", &format!("发送失败: {e}")),
    }
    result.map_err(|e| format!("发送系统通知失败: {e}"))
}

/// 启动时准备通知环境：确保应用标识有对应的开始菜单快捷方式（见模块注释）。
pub fn prepare(app: &AppHandle) {
    match shortcut::ensure(app) {
        Ok(path) => log::write(
            app,
            "notify",
            &format!("开始菜单快捷方式就绪: {}", path.display()),
        ),
        Err(e) => log::write(
            app,
            "notify",
            &format!("创建开始菜单快捷方式失败（系统通知可能不显示）: {e}"),
        ),
    }
}
