import { invoke } from "@tauri-apps/api/core";

/**
 * 穿透模式的解锁按钮（由独立的锁窗口渲染）。
 * 主窗口穿透时对系统整体穿透、收不到任何鼠标事件，因此解锁按钮
 * 必须放在这个自身不穿透的小窗口里；点击后统一走 Rust 的穿透切换。
 */
export default function LockView() {
  return (
    <button
      className="lock-btn"
      title="点击解锁穿透模式"
      onClick={() => {
        invoke("toggle_passthrough").catch((e) => console.error("[lock] 解锁失败:", e));
      }}
    >
      <svg
        viewBox="0 0 24 24"
        width="17"
        height="17"
        fill="none"
        stroke="currentColor"
        strokeWidth="2.2"
        strokeLinecap="round"
        strokeLinejoin="round"
        aria-hidden="true"
      >
        <rect width="18" height="11" x="3" y="11" rx="2" ry="2" />
        <path d="M7 11V7a5 5 0 0 1 10 0v4" />
      </svg>
    </button>
  );
}
