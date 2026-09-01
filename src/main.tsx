import React from "react";
import ReactDOM from "react-dom/client";
import { getCurrentWindow } from "@tauri-apps/api/window";
import App from "./App";
import LockView from "./components/LockView";
import "./App.css";

// 锁窗口（穿透解锁按钮）加载同一入口，按 Tauri 窗口 label 区分渲染内容。
// 不用 URL query：WebviewUrl::App 不支持 query string，会被编码破坏。
const isLockWindow = getCurrentWindow().label === "widget-lock";

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    {isLockWindow ? <LockView /> : <App />}
  </React.StrictMode>,
);
