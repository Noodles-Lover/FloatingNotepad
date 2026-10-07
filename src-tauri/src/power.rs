//! 系统电源与关机事件的留痕。
//!
//! 休眠/唤醒（WM_POWERBROADCAST）与关机/注销（WM_ENDSESSION）是广播消息，
//! 只会发给顶层窗口——message-only 窗口收不到。所以这里建一个
//! 不可见、不进任务栏的 0 尺寸顶层窗口，专职接系统广播。
//!
//! 运行在线程里：Win32 消息循环是阻塞的，绝不能占主线程。

use std::sync::OnceLock;

use tauri::AppHandle;
use windows::core::{w, PCWSTR};
use windows::Win32::Foundation::{HINSTANCE, HWND, LPARAM, LRESULT, WPARAM};
use windows::Win32::System::LibraryLoader::GetModuleHandleW;
use windows::Win32::UI::WindowsAndMessaging::{
    CreateWindowExW, DefWindowProcW, DispatchMessageW, GetMessageW, RegisterClassExW,
    TranslateMessage, MSG, WINDOW_STYLE, WNDCLASSEXW, WS_EX_TOOLWINDOW,
};

use crate::log;

// 这几个常量 crate 没提供，值取自 Win32 头文件。
const WM_POWERBROADCAST: u32 = 0x0218;
const WM_ENDSESSION: u32 = 0x0016;
const PBT_APMSUSPEND: u32 = 0x0004;
const PBT_APMRESUMEAUTOMATIC: u32 = 0x0012;

static APP: OnceLock<AppHandle> = OnceLock::new();

/// 留痕；句柄尚未就绪的极早期消息直接丢弃。
fn say(msg: &str) {
    if let Some(app) = APP.get() {
        log::write(app, "power", msg);
    }
}

unsafe extern "system" fn wndproc(hwnd: HWND, msg: u32, wparam: WPARAM, lparam: LPARAM) -> LRESULT {
    match msg {
        WM_POWERBROADCAST => {
            match wparam.0 as u32 {
                PBT_APMSUSPEND => say("电脑进入休眠"),
                // RESUMEAUTOMATIC 在任何唤醒后必发一次；只记它，避免与 RESUMESUSPEND 双写。
                PBT_APMRESUMEAUTOMATIC => say("电脑从休眠唤醒"),
                _ => {}
            }
            LRESULT(1) // 按约定返回 TRUE，表示已处理
        }
        WM_ENDSESSION => {
            if wparam.0 != 0 {
                // 系统关机/注销时进程会被强制终止，这是最后一次留痕机会。
                say("系统关机或注销");
            }
            LRESULT(0)
        }
        _ => DefWindowProcW(hwnd, msg, wparam, lparam),
    }
}

/// 启动监听线程（setup 阶段调用一次）。
pub fn start(app: &AppHandle) {
    let _ = APP.set(app.clone());
    let _ = std::thread::Builder::new()
        .name("power-listen".into())
        .spawn(|| unsafe { message_loop() });
}

unsafe fn message_loop() {
    // GetModuleHandleW 返回 HMODULE，注册类与建窗要的是同一句柄的 HINSTANCE 形态。
    let Ok(hmodule) = GetModuleHandleW(PCWSTR::null()) else {
        return;
    };
    let hinstance: HINSTANCE = hmodule.into();
    let class_name = w!("floating_notepad_power");

    let mut wc = WNDCLASSEXW::default();
    wc.cbSize = std::mem::size_of::<WNDCLASSEXW>() as u32;
    wc.lpfnWndProc = Some(wndproc);
    wc.hInstance = hinstance;
    wc.lpszClassName = class_name;
    RegisterClassExW(&wc);

    // 不带 WS_VISIBLE、尺寸 0，加 TOOLWINDOW：不可见、不进任务栏、不被 Alt-Tab 看到。
    if CreateWindowExW(
        WS_EX_TOOLWINDOW,
        class_name,
        PCWSTR::null(),
        WINDOW_STYLE(0),
        0,
        0,
        0,
        0,
        None,
        None,
        hinstance,
        None,
    )
    .is_err()
    {
        return;
    }

    let mut msg = MSG::default();
    while GetMessageW(&mut msg, None, 0, 0).as_bool() {
        let _ = TranslateMessage(&msg);
        DispatchMessageW(&msg);
    }
}
