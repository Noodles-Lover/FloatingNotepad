import { getCurrentWindow } from "@tauri-apps/api/window";
import { LogicalPosition, LogicalSize } from "@tauri-apps/api/dpi";
import { BALL, WindowController, type Edge, type Rect } from "./window";

/** 笔记面板尺寸（逻辑像素）。 */
export const PANEL_W = 320;
export const PANEL_H = 440;
/** 展开后面板与屏幕边界保留的最小间距。 */
const MARGIN = 6;

/**
 * 笔记面板窗口控制器：负责“展开/收起笔记面板”这一形态下的所有窗口操作——
 * 尺寸、位置（紧贴停靠侧向外弹出、垂直中心对齐球）、真实的可见矩形（供 proximity
 * 判定鼠标是否仍在面板内），以及把窗口从“面板”收回到“球隐藏态”。
 *
 * 与 WindowController（管悬浮球）职责分离：收起时通过注入的 windowCtl 把球还原回隐藏态。
 */
export class NoteWindow {
  private readonly win = getCurrentWindow();
  private readonly screen = { w: window.screen.width, h: window.screen.height };

  /** 注入悬浮球控制器，收起面板时用来把球还原回隐藏停靠态。 */
  constructor(private readonly windowCtl: WindowController) {}

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
      MARGIN,
      Math.min(ballCy - PANEL_H / 2, this.screen.h - PANEL_H - MARGIN),
    );
    // 与屏幕边沿也留 MARGIN：右贴时面板贴右边但内缩 MARGIN；左贴时贴左边内缩 MARGIN。
    const x = dockEdge === "left" ? MARGIN : this.screen.w - PANEL_W - MARGIN;
    await this.win.setPosition(new LogicalPosition(Math.round(x), Math.round(y)));
  }

  /**
   * 收起笔记面板：把窗口形态还原回“球隐藏态”。
   * 这是“自动消失”和“手动关闭”共用的唯一出口，App 侧播完收起动画后再调用它。
   */
  async collapse(): Promise<void> {
    await this.windowCtl.dockHidden();
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
