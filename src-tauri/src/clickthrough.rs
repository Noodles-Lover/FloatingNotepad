//! 窗口级点击穿透：让纯展示的小窗（计时窗口、通用弹窗）不吃任何鼠标消息。
//!
//! 三层一起做才彻底：
//!
//! 1. 顶层窗口加 `WS_EX_TRANSPARENT`；
//! 2. 全部后代窗口（WebView2 的渲染窗口）逐个加 `WS_EX_TRANSPARENT`；
//! 3. 改写窗口过程，`WM_NCHITTEST` 恒答 `HTTRANSPARENT`。
//!
//! 只做第 1 层时右键仍会弹出 WebView2 的默认菜单（命中测试落在子窗口上），
//! 所以第 3 层是主力，前两层是补漏。

use std::collections::HashMap;
use std::sync::Mutex;
use std::sync::OnceLock;

use windows::Win32::Foundation::{BOOL, HWND, LPARAM, LRESULT, WPARAM};
use windows::Win32::UI::WindowsAndMessaging::{
    CallWindowProcW, DefWindowProcW, EnumChildWindows, GetWindowLongPtrW, SetWindowLongPtrW,
    GWLP_WNDPROC, GWL_EXSTYLE, WS_EX_TRANSPARENT,
};

type WndProc = unsafe extern "system" fn(HWND, u32, WPARAM, LPARAM) -> LRESULT;

/// `WM_NCHITTEST`：命中测试消息，答 `HTTRANSPARENT` 即「不参与命中」。
const WM_NCHITTEST: u32 = 0x0084;
/// `HTTRANSPARENT`：把命中交给下面的窗口。
const HTTRANSPARENT: LRESULT = LRESULT(-1);

/// 各窗口的原窗口过程：hwnd → 原过程。多个窗口各记各的。
fn originals() -> &'static Mutex<HashMap<isize, usize>> {
    static MAP: OnceLock<Mutex<HashMap<isize, usize>>> = OnceLock::new();
    MAP.get_or_init(|| Mutex::new(HashMap::new()))
}

unsafe extern "system" fn pass_through_proc(
    hwnd: HWND,
    msg: u32,
    wparam: WPARAM,
    lparam: LPARAM,
) -> LRESULT {
    if msg == WM_NCHITTEST {
        return HTTRANSPARENT;
    }
    let prev = originals()
        .lock()
        .ok()
        .and_then(|map| map.get(&(hwnd.0 as isize)).copied());
    // 查不到原过程（未登记过）就走默认处理，绝不转发给未知地址。
    let Some(prev) = prev else {
        return DefWindowProcW(hwnd, msg, wparam, lparam);
    };
    let prev: WndProc = std::mem::transmute(prev);
    CallWindowProcW(Some(prev), hwnd, msg, wparam, lparam)
}

/// 让窗口彻底不吃鼠标消息（含右键）。
///
/// wry 初始化 webview 时可能把窗口过程换回它自己的，因此每次显示窗口前都应
/// 再调一次；重复调用是安全的。
pub fn enable(hwnd: HWND) {
    let ours = pass_through_proc as *const () as usize;
    unsafe {
        let current = GetWindowLongPtrW(hwnd, GWLP_WNDPROC) as usize;
        // 原过程只记一次：重复调用时当前过程已经是自己，
        // 再存一遍就变成自己调自己，栈溢出。
        if current != ours {
            if let Ok(mut map) = originals().lock() {
                map.insert(hwnd.0 as isize, current);
            }
            SetWindowLongPtrW(hwnd, GWLP_WNDPROC, ours as isize);
        }
        // EnumChildWindows 遍历全部后代（不只是直接子窗口）；重复设置无害。
        let _ = EnumChildWindows(hwnd, Some(make_transparent_child), LPARAM(0));
    }
}

/// 给子窗口（Chromium 渲染窗口等）加 `WS_EX_TRANSPARENT`。
unsafe extern "system" fn make_transparent_child(hwnd: HWND, _lparam: LPARAM) -> BOOL {
    let ex = GetWindowLongPtrW(hwnd, GWL_EXSTYLE);
    SetWindowLongPtrW(hwnd, GWL_EXSTYLE, ex | (WS_EX_TRANSPARENT.0 as isize));
    true.into()
}