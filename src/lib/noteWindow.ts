import { getCurrentWindow, currentMonitor } from "@tauri-apps/api/window";
import { LogicalPosition, LogicalSize } from "@tauri-apps/api/dpi";
import { WindowController, type Edge, type Rect } from "./window";
import type { AppConfig } from "./config";

/** 展开后面板与屏幕边界保留的最小间距。 */
const MARGIN = 6;

/**
 * 笔记面板窗口控制器：负责“展开/收起笔记面板”这一形态下的所有窗口操作——
 * 尺寸、位置（紧贴停靠侧向外弹出、垂直中心对齐球）、真实的可见矩形（供 proximity
 * 判定鼠标是否仍在面板内），以及把窗口从“面板”收回到“球隐藏态”。
 *
 * 与 WindowController（管悬浮挂件）职责分离：收起时通过注入的 windowCtl 把挂件还原回隐藏态。
 */
export class NoteWindow {
  private readonly win = getCurrentWindow();
  /** 屏幕逻辑尺寸，启动后由 refreshScreen() 用真实显示器尺寸覆盖。 */
  private screen = { w: window.screen.width, h: window.screen.height };
  private panelW: number;
  private panelH: number;
  private widgetSize: number;

  /**
   * 注入悬浮挂件控制器（收起时还原挂件）与当前配置（决定面板尺寸、挂件大小）。
   */
  constructor(
    private readonly windowCtl: WindowController,
    cfg: AppConfig,
  ) {
    this.panelW = cfg.windowWidth;
    this.panelH = cfg.windowHeight;
    this.widgetSize = cfg.widgetSize;
  }

  /** 应用新的配置（尺寸变化时立即生效，下次展开即使用新尺寸）。 */
  applyConfig(cfg: AppConfig): void {
    this.panelW = cfg.windowWidth;
    this.panelH = cfg.windowHeight;
    this.widgetSize = cfg.widgetSize;
  }

  /** 用 Tauri 真实显示器尺寸刷新内部 screen（逻辑像素），避免窗口被放到屏幕外。 */
  async refreshScreen(): Promise<void> {
    try {
      const mon = await currentMonitor();
      if (mon) {
        const size = mon.size.toLogical(mon.scaleFactor);
        this.screen = { w: size.width, h: size.height };
      }
    } catch (e) {
      console.error("[NoteWindow.refreshScreen] 失败:", e);
    }
  }

  /**
   * 展开为笔记面板：紧贴停靠侧向外（左贴则向右、右贴则向左）弹出，垂直中心对齐挂件。
   * @param dockEdge 挂件当前贴附的边
   * @param dockY    挂件的中心 Y（逻辑像素），用来对齐面板垂直中心
   */
  async expand(dockEdge: Edge, dockY: number): Promise<void> {
    await this.win.setIgnoreCursorEvents(false);
    await this.win.setSize(new LogicalSize(this.panelW, this.panelH));
    const widgetTop = Math.round(dockY - this.widgetSize / 2);
    const widgetCy = widgetTop + this.widgetSize / 2;
    const y = Math.max(
      MARGIN,
      Math.min(widgetCy - this.panelH / 2, this.screen.h - this.panelH - MARGIN),
    );
    // 与屏幕边沿也留 MARGIN：右贴时面板贴右边但内缩 MARGIN；左贴时贴左边内缩 MARGIN。
    const x = dockEdge === "left" ? MARGIN : this.screen.w - this.panelW - MARGIN;
    await this.win.setPosition(new LogicalPosition(Math.round(x), Math.round(y)));
  }

  /**
   * 收起笔记面板：把窗口形态还原回“挂件隐藏态”。
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
