//! 应用快捷栏：用户挑选的文件路径、系统图标提取与 ShellExecute 启动。
//! 列表以 JSON 存在 meta 表；图标每次读取时重新提取，不落盘、不需要 asset scope。

use serde::{Deserialize, Serialize};
use std::ffi::c_void;
use std::path::Path;
use windows::core::PCWSTR;
use windows::Win32::Foundation::{HANDLE, HWND};
use windows::Win32::Graphics::Gdi::{
    CreateCompatibleDC, CreateDIBSection, DeleteDC, DeleteObject, GetDC, ReleaseDC, SelectObject,
    BITMAPINFO, BITMAPINFOHEADER, BI_RGB, DIB_RGB_COLORS, HBRUSH,
};
use windows::Win32::Storage::FileSystem::FILE_ATTRIBUTE_NORMAL;
use windows::Win32::UI::Shell::{
    SHGetFileInfoW, ShellExecuteW, SHFILEINFOW, SHGFI_ICON, SHGFI_LARGEICON,
};
use windows::Win32::UI::WindowsAndMessaging::{
    DestroyIcon, DrawIconEx, DI_NORMAL, HICON, SW_SHOWNORMAL,
};

const ICON_SIZE: i32 = 32;
const META_KEY: &str = "launcher_items";

#[derive(Serialize, Deserialize, Clone)]
struct StoredItem {
    path: String,
    name: String,
}

#[derive(Serialize, Clone)]
pub struct LauncherItem {
    pub path: String,
    pub name: String,
    /// PNG 的 data URL；提取失败时为空串，前端显示文件名占位。
    pub icon: String,
}

fn wide(s: &str) -> Vec<u16> {
    s.encode_utf16().chain(std::iter::once(0)).collect()
}

fn load() -> Vec<StoredItem> {
    crate::db::meta_get(META_KEY)
        .and_then(|s| serde_json::from_str(&s).ok())
        .unwrap_or_default()
}

fn save(items: &[StoredItem]) {
    if let Ok(s) = serde_json::to_string(items) {
        crate::db::meta_set(META_KEY, &s);
    }
}

fn base64(data: &[u8]) -> String {
    const TABLE: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut out = String::with_capacity((data.len() + 2) / 3 * 4);
    for chunk in data.chunks(3) {
        let n = (chunk[0] as u32) << 16
            | (*chunk.get(1).unwrap_or(&0) as u32) << 8
            | *chunk.get(2).unwrap_or(&0) as u32;
        out.push(TABLE[((n >> 18) & 63) as usize] as char);
        out.push(TABLE[((n >> 12) & 63) as usize] as char);
        out.push(if chunk.len() > 1 {
            TABLE[((n >> 6) & 63) as usize] as char
        } else {
            '='
        });
        out.push(if chunk.len() > 2 {
            TABLE[(n & 63) as usize] as char
        } else {
            '='
        });
    }
    out
}

/// HICON → 32×32 RGBA → PNG data URL。DIB 是 32bpp、自下而上，需翻转并交换 R/B。
unsafe fn icon_data_url(hicon: HICON) -> String {
    let hwnd = HWND(std::ptr::null_mut());
    let screen_dc = GetDC(hwnd);
    let mem_dc = CreateCompatibleDC(screen_dc);
    let mut bmi = BITMAPINFO::default();
    bmi.bmiHeader = BITMAPINFOHEADER {
        biSize: std::mem::size_of::<BITMAPINFOHEADER>() as u32,
        biWidth: ICON_SIZE,
        biHeight: ICON_SIZE,
        biPlanes: 1,
        biBitCount: 32,
        biCompression: BI_RGB.0,
        ..Default::default()
    };
    let mut bits: *mut c_void = std::ptr::null_mut();
    let hbmp = match CreateDIBSection(
        mem_dc,
        &bmi,
        DIB_RGB_COLORS,
        &mut bits,
        HANDLE(std::ptr::null_mut()),
        0,
    ) {
        Ok(b) => b,
        Err(_) => {
            let _ = DeleteDC(mem_dc);
            ReleaseDC(hwnd, screen_dc);
            return String::new();
        }
    };
    let old = SelectObject(mem_dc, hbmp);
    let _ = DrawIconEx(
        mem_dc,
        0,
        0,
        hicon,
        ICON_SIZE,
        ICON_SIZE,
        0,
        HBRUSH(std::ptr::null_mut()),
        DI_NORMAL,
    );
    let w = ICON_SIZE as usize;
    let len = w * w * 4;
    let src = std::slice::from_raw_parts(bits as *const u8, len);
    let mut rgba = vec![0u8; len];
    for y in 0..w {
        for x in 0..w {
            let s = ((w - 1 - y) * w + x) * 4;
            let d = (y * w + x) * 4;
            rgba[d] = src[s + 2];
            rgba[d + 1] = src[s + 1];
            rgba[d + 2] = src[s];
            rgba[d + 3] = src[s + 3];
        }
    }
    SelectObject(mem_dc, old);
    let _ = DeleteObject(hbmp);
    let _ = DeleteDC(mem_dc);
    ReleaseDC(hwnd, screen_dc);

    let mut png = Vec::new();
    {
        let mut enc = png::Encoder::new(&mut png, ICON_SIZE as u32, ICON_SIZE as u32);
        enc.set_color(png::ColorType::Rgba);
        enc.set_depth(png::BitDepth::Eight);
        let Ok(mut writer) = enc.write_header() else {
            return String::new();
        };
        if writer.write_image_data(&rgba).is_err() {
            return String::new();
        }
    }
    format!("data:image/png;base64,{}", base64(&png))
}

fn icon_for(path: &str) -> String {
    unsafe {
        let w = wide(path);
        let mut sfi = SHFILEINFOW::default();
        let ok = SHGetFileInfoW(
            PCWSTR(w.as_ptr()),
            FILE_ATTRIBUTE_NORMAL,
            Some(&mut sfi as *mut _),
            std::mem::size_of::<SHFILEINFOW>() as u32,
            SHGFI_ICON | SHGFI_LARGEICON,
        );
        if ok == 0 || sfi.hIcon.is_invalid() {
            return String::new();
        }
        let url = icon_data_url(sfi.hIcon);
        let _ = DestroyIcon(sfi.hIcon);
        url
    }
}

pub fn list() -> Vec<LauncherItem> {
    load()
        .into_iter()
        .map(|it| {
            let icon = icon_for(&it.path);
            LauncherItem {
                path: it.path,
                name: it.name,
                icon,
            }
        })
        .collect()
}

pub fn add(path: String) -> Result<Vec<LauncherItem>, String> {
    let p = Path::new(&path);
    if !p.exists() {
        return Err("文件不存在".into());
    }
    let mut items = load();
    if items.iter().any(|it| it.path.eq_ignore_ascii_case(&path)) {
        return Ok(list());
    }
    let name = p
        .file_stem()
        .map(|s| s.to_string_lossy().into_owned())
        .unwrap_or_else(|| path.clone());
    items.push(StoredItem { path, name });
    save(&items);
    Ok(list())
}

pub fn rename(path: &str, name: &str) -> Vec<LauncherItem> {
    let trimmed = name.trim();
    let mut items = load();
    if let Some(it) = items.iter_mut().find(|it| it.path == path) {
        it.name = if trimmed.is_empty() {
            Path::new(path)
                .file_stem()
                .map(|s| s.to_string_lossy().into_owned())
                .unwrap_or_else(|| path.to_string())
        } else {
            trimmed.to_string()
        };
        save(&items);
    }
    list()
}

pub fn remove(path: &str) -> Vec<LauncherItem> {
    let mut items = load();
    items.retain(|it| it.path != path);
    save(&items);
    list()
}

/// 用系统默认方式打开（支持 exe、快捷方式、文件夹、文档）。
pub fn launch(path: &str) -> Result<(), String> {
    unsafe {
        let file = wide(path);
        let dir = Path::new(path)
            .parent()
            .map(|p| wide(&p.to_string_lossy()))
            .unwrap_or_default();
        let result = ShellExecuteW(
            HWND(std::ptr::null_mut()),
            PCWSTR::null(),
            PCWSTR(file.as_ptr()),
            PCWSTR::null(),
            PCWSTR(if dir.is_empty() {
                std::ptr::null()
            } else {
                dir.as_ptr()
            }),
            SW_SHOWNORMAL,
        );
        // ShellExecuteW 的返回值大于 32 才算成功，其余是错误码。
        if (result.0 as isize) > 32 {
            Ok(())
        } else {
            Err(format!("启动失败（错误码 {}）", result.0 as isize))
        }
    }
}
