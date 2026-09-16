import React from "react";
import ReactDOM from "react-dom/client";
import { getCurrentWindow } from "@tauri-apps/api/window";
import App from "./App";
import LockView from "./components/LockView";
import ChimeView from "./components/ChimeView";
// 样式按组件拆分；导入顺序即级联顺序（与拆分前的单文件一致），不要随意调换。
import "./styles/base.css";
import "./components/FloatingWidget.css";
import "./components/TabBar.css";
import "./components/NotePanel.css";
import "./styles/overlay.css";
import "./components/ConfirmDialog.css";
import "./components/LockView.css";
import "./components/UsagePanel.css";
import "./components/ChimeView.css";

// 锁窗口（穿透解锁按钮）与报时小窗都加载同一入口，按 Tauri 窗口 label 区分渲染内容。
// 不用 URL query：WebviewUrl::App 不支持 query string，会被编码破坏。
const label = getCurrentWindow().label;
const view = label === "widget-lock" ? <LockView /> : label === "chime" ? <ChimeView /> : <App />;

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>{view}</React.StrictMode>,
);
