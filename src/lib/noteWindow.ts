import { getCurrentWindow } from "@tauri-apps/api/window";
import { LogicalPosition, LogicalSize } from "@tauri-apps/api/dpi";
import { BALL, type Edge, type Rect } from "./window";

/** 笔记面板尺寸（逻辑像素）。 */
export const PANEL_W = 320;
export const PANEL_H = 440;
/** 展开后面板与屏幕上下边界保留的最小间距。 */
const MARGIN_Y = 8;

/**
 * 笔记面板窗口控制器：负责“展开/收起笔记面板”这一形态下的所有窗口操作——
 * 尺寸、位置（紧贴停靠侧向外弹出、垂直中心对齐球）、以及真实的可见矩形
 * （供 proximity 判定鼠标是否仍在面板内）。
 *
 * 与 WindowController（管悬浮球）职责分离，互不打扰。
 */
export class NoteWindow {
  private readonly win = getCurrentWindow();
  private readonly screen = { w: window.screen.width, h: window.screen.height };

  /**
   * 展开为笔记面板：紧贴停靠侧向外（左贴则向右、右贴则向左）弹出，垂直中心对齐球。
   * @param dockEdge 球当前贴附的边
   * @param dockY    球的中心 Y（逻辑像素），用来对齐面板垂直中心
   */
  async expand(dockEdge: Edge, dockY: number): Promise<void> {
    await this.win.setIgnoreCursorEvents(false);
    await this.win.setSize(new LogicalSize(PANEL_W, PANEL_H));
    const ballTop = Math.round(dockY - BALL / 2);
    const ballCy = ballTop + BALL / 2;
    const y = Math.max(
      MARGIN_Y,
      Math.min(ballCy - PANEL_H / 2, this.screen.h - PANEL_H - MARGIN_Y),
    );
    // 紧贴边沿：右贴时面板左边界 = 球左边界；左贴时面板右边界 = 球右边界。
    const x = dockEdge === "left" ? 0 : this.screen.w - PANEL_W;
    await this.win.setPosition(new LogicalPosition(Math.round(x), Math.round(y)));
  }

  /**
   * 返回笔记面板当前“实际可见矩形”，供 proximity 判定鼠标是否在内。
   * 直接读窗口真实的 outerPosition + outerSize，面板被拖到哪、尺寸多少都跟着走。
   */
  async bounds(): Promise<Rect> {
    const dpr = window.devicePixelRatio || 1;
    const physPos = await this.win.outerPosition();
    const physSize = await this.win.outerSize();
    const pos = physPos.toLogical(dpr);
    const size = physSize.toLogical(dpr);
    return { left: pos.x, right: pos.x + size.width, top: pos.y, bottom: pos.y + size.height };
  }
}
