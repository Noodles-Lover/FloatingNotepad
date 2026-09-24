//! 为系统通知准备 AppUserModelID。
//!
//! Windows 的 toast 要求调用方的 AppUserModelID 在开始菜单里有对应快捷方式，
//! 否则通知会被系统**直接丢掉**（`tauri-winrt-notification` 的原话：程序若未安装，
//! 请先用 `POWERSHELL_APP_ID`）。安装版由安装器建快捷方式，但开发/绿色版没有——
//! 于是这里自己建一个：开始菜单放一个指向当前 exe 的 .lnk，并把它的
//! AppUserModelID 写成应用标识（`tauri.conf.json` 的 identifier）。
//!
//! **只在需要时才写**：快捷方式缺失、或已失效（目标不再指向当前 exe，例如 exe 被
//! 移动过）时才重写。安全软件（如 360）对「修改快捷方式」逐次弹窗，每次启动都写
//! 会让用户天天应付，得不偿失。

use std::path::{Path, PathBuf};

use tauri::AppHandle;
use windows::core::{Interface, GUID, HSTRING, PROPVARIANT};
use windows::Win32::System::Com::{
    CoCreateInstance, CoInitializeEx, IPersistFile, CLSCTX_INPROC_SERVER, COINIT_APARTMENTTHREADED,
    STGM_READ,
};
use windows::Win32::UI::Shell::PropertiesSystem::{IPropertyStore, PROPERTYKEY};
use windows::Win32::UI::Shell::{IShellLinkW, ShellLink, SLGP_RAWPATH};

/// 快捷方式里的 AppUserModelID 属性（PKEY_AppUserModel_ID）：
/// {9F4C2855-9F79-4B39-A8D0-E1D42DE1D5F3}, 5。windows crate 没生成这个键，手写。
const PKEY_APP_USER_MODEL_ID: PROPERTYKEY = PROPERTYKEY {
    fmtid: GUID::from_u128(0x9f4c2855_9f79_4b39_a8d0_e1d42de1d5f3),
    pid: 5,
};

/// 确保开始菜单里存在指向当前 exe、且带 AppUserModelID 的快捷方式。
/// 已存在且仍有效时不写，避免触发安全软件的「修改快捷方式」提示。
pub fn ensure(app: &AppHandle) -> Result<PathBuf, String> {
    let exe = std::env::current_exe().map_err(|e| format!("取当前 exe 路径失败: {e}"))?;
    let dir = start_menu_dir().ok_or("找不到开始菜单程序目录")?;
    let name = app
        .config()
        .product_name
        .clone()
        .unwrap_or_else(|| "FloatingNotepad".to_string());
    let lnk = dir.join(format!("{name}.lnk"));
    let app_id = app.config().identifier.clone();

    if lnk.exists() && shortcut_target(&lnk).is_some_and(|t| same_path(&t, &exe)) {
        return Ok(lnk);
    }

    unsafe {
        // 已初始化过会返回 S_FALSE，忽略即可（本函数可能被调用多次）。
        let _ = CoInitializeEx(None, COINIT_APARTMENTTHREADED);
        let link: IShellLinkW = CoCreateInstance(&ShellLink, None, CLSCTX_INPROC_SERVER)
            .map_err(|e| format!("创建 IShellLink 失败: {e}"))?;
        link.SetPath(&HSTRING::from(exe.to_string_lossy().as_ref()))
            .map_err(|e| format!("设置快捷方式目标失败: {e}"))?;

        // AppUserModelID 存在快捷方式的属性里，必须通过 IPropertyStore 写。
        // PROPVARIANT 自带 Drop（内部会 PropVariantClear），不要再手动清一次。
        let store: IPropertyStore = link
            .cast()
            .map_err(|e| format!("取属性存储失败: {e}"))?;
        let value = PROPVARIANT::from(app_id.as_str());
        store
            .SetValue(&PKEY_APP_USER_MODEL_ID, &value)
            .map_err(|e| format!("写入应用标识失败: {e}"))?;
        store.Commit().map_err(|e| format!("提交属性失败: {e}"))?;

        let file: IPersistFile = link.cast().map_err(|e| format!("取 IPersistFile 失败: {e}"))?;
        file.Save(&HSTRING::from(lnk.to_string_lossy().as_ref()), true)
            .map_err(|e| format!("保存快捷方式失败: {e}"))?;
    }
    Ok(lnk)
}

/// 读取 .lnk 指向的目标路径；读不出来（损坏等）返回 None，由调用方决定是否重写。
fn shortcut_target(lnk: &Path) -> Option<PathBuf> {
    unsafe {
        // 已初始化过会返回 S_FALSE，忽略即可。
        let _ = CoInitializeEx(None, COINIT_APARTMENTTHREADED);
        let link: IShellLinkW = CoCreateInstance(&ShellLink, None, CLSCTX_INPROC_SERVER).ok()?;
        let file: IPersistFile = link.cast().ok()?;
        file.Load(&HSTRING::from(lnk.to_string_lossy().as_ref()), STGM_READ)
            .ok()?;
        let mut buf = [0u16; 260]; // MAX_PATH
        link.GetPath(&mut buf, std::ptr::null_mut(), SLGP_RAWPATH.0 as u32)
            .ok()?;
        let len = buf.iter().position(|c| *c == 0)?;
        Some(PathBuf::from(String::from_utf16_lossy(&buf[..len])))
    }
}

/// Windows 路径大小写不敏感，安装器写入的大小写与 current_exe 返回的可能不一致。
fn same_path(a: &Path, b: &Path) -> bool {
    a.to_string_lossy().to_lowercase() == b.to_string_lossy().to_lowercase()
}

/// 当前用户的开始菜单「程序」目录（每用户，不需要管理员权限）。
fn start_menu_dir() -> Option<PathBuf> {
    let appdata = std::env::var_os("APPDATA")?;
    let dir = PathBuf::from(appdata).join("Microsoft\\Windows\\Start Menu\\Programs");
    std::fs::create_dir_all(&dir).ok()?;
    Some(dir)
}
