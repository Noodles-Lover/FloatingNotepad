import { useEffect } from "react";

/**
 * 屏蔽 WebView2 的默认右键菜单（上一页 / 重新加载 / 检查）。
 *
 * 纯展示的小窗（计时、弹出通知）由 Rust 侧接管命中测试做穿透，
 * 但菜单仍可能从 webview 冒出来——这一层是兜底，两个窗口共用。
 */
export function useBlockedContextMenu() {
  useEffect(() => {
    const block = (e: MouseEvent) => e.preventDefault();
    document.addEventListener("contextmenu", block);
    return () => document.removeEventListener("contextmenu", block);
  }, []);
}