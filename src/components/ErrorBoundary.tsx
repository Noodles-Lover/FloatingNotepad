import { Component, type ErrorInfo, type ReactNode } from "react";
import { logEvent } from "../lib/log";

interface Props {
  children: ReactNode;
}

interface State {
  error: Error | null;
}

/**
 * 顶层错误边界。
 *
 * React 18 里，渲染期未捕获的异常会让整棵根树卸载——表现就是「界面永久空白、
 * 所有事件失效」，用户无从恢复。这里兜底：把错误写进 Rust 日志，并给出一个可点的
 * 「重新加载」，把不可恢复的空白变成一个可自愈的界面。
 */
export default class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    logEvent(
      "ui-error",
      `${error.message} | ${error.stack ?? ""} | componentStack:${info.componentStack ?? ""}`,
    );
  }

  private reload = (): void => {
    window.location.reload();
  };

  render(): ReactNode {
    if (!this.state.error) return this.props.children;
    return (
      <div
        style={{
          position: "fixed",
          inset: 0,
          display: "flex",
          flexDirection: "column",
          alignItems: "center",
          justifyContent: "center",
          gap: 8,
          padding: 16,
          font: "13px/1.5 system-ui, sans-serif",
          color: "#333",
          background: "rgba(255,255,255,0.92)",
          textAlign: "center",
        }}
      >
        <div>界面出现异常，已记录。</div>
        <div style={{ color: "#888", wordBreak: "break-all" }}>{this.state.error.message}</div>
        <button onClick={this.reload} style={{ marginTop: 4, padding: "4px 12px" }}>
          重新加载
        </button>
      </div>
    );
  }
}
