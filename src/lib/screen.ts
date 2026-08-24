import { currentMonitor } from "@tauri-apps/api/window";

/** 逻辑像素尺寸（DIP），区别于 Windows 物理像素。 */
export interface ScreenSize {
  w: number;
  h: number;
}

/**
 * 读取当前显示器尺寸（逻辑像素）。失败时打印错误并返回 null，
 * 调用方应保留上一次的尺寸而不是使用无效数据。
 */
export async function readMonitorScreen(): Promise<ScreenSize | null> {
  try {
    const mon = await currentMonitor();
    if (mon) {
      const size = mon.size.toLogical(mon.scaleFactor);
      return { w: size.width, h: size.height };
    }
  } catch (e) {
    console.error("[screen] 读取显示器尺寸失败:", e);
  }
  return null;
}
