import { useRef } from "react";
import { WindowController } from "../lib/window";
import { NoteWindow } from "../lib/noteWindow";
import { DEFAULT_CONFIG } from "../lib/config";

/**
 * 窗口 / 面板控制器实例：两者都只在首次渲染创建一次，之后跨渲染复用。
 * 初始尺寸取出厂默认——真实配置加载后由 useAppConfig 应用进来。
 */
export function useControllers() {
  const windowCtlRef = useRef<WindowController | null>(null);
  if (!windowCtlRef.current) {
    windowCtlRef.current = new WindowController(DEFAULT_CONFIG.widgetSize);
  }
  const windowCtl = windowCtlRef.current;

  const noteWinRef = useRef<NoteWindow | null>(null);
  if (!noteWinRef.current) {
    noteWinRef.current = new NoteWindow(windowCtl, DEFAULT_CONFIG);
  }
  const noteWin = noteWinRef.current;

  return { windowCtl, noteWin };
}
