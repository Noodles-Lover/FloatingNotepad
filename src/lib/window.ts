import { getCurrentWindow } from "@tauri-apps/api/window";
import { LogicalPosition, LogicalSize } from "@tauri-apps/api/dpi";

// ---- 尺寸常量（逻辑像素）----
export const BALL = 56; // 悬浮球直径
export const PANEL_W = 320; // 面板宽
export const PANEL_H = 440; // 面板高
/** 隐藏态时，CSS 把球滑出多少像素，只留一条“缝”露在屏幕内。 */
export const PEEK = 24;

/** 贴附的边：只在左右两边之间切换。 */
export type Edge = "left" | "right";

/** 屏幕坐标矩形（左/右/上/下）。 */
export interface Rect {
  left: number;
  right: number;
  top: number;
  bottom: number;
}

/**
 * 窗口控制器：封装所有与 Tauri 窗口相关的操作。
 * - 球停靠在左或右边沿的任意垂直高度；
 * - 拖动松手后吸附到更近的边（只移动 X 轴，保留释放时的高度）；
 * - 笔记面板从停靠侧向外展开。
 * 所有布局/坐标计算都集中在这里，UI 组件只调用它，不直接碰窗口 API。
 */
export class WindowController {
  private readonly win = getCurrentWindow(); // 当前窗口
  private readonly screen = { w: window.screen.width, h: window.screen.height }; // 屏幕逻辑尺寸
  private dockEdge: Edge = "right"; // 当前贴附的边
  private dockY: number; // 当前停靠高度的“中心 Y”（逻辑像素）
  private dragEndCb: ((edge: Edge) => void) | null = null; // 拖动结束回调
  private dragPoll: number | null = null; // 拖动松手检测的定时器

  constructor() {
    // 初始停靠在垂直正中央。
    this.dockY = Math.round(this.screen.h / 2);
  }

  /** 注册“OS 拖动结束”回调；球吸附到就近边后会带上最终边沿调用它。 */
  onDragEnd(cb: (edge: Edge) => void): void {
    this.dragEndCb = cb;
  }

  /** 把任意垂直中心 Y 限制在屏幕可见范围内。 */
  private clampY(cy: number): number {
    const min = BALL / 2;
    const max = this.screen.h - BALL / 2;
    return Math.max(min, Math.min(max, cy));
  }

  /** 计算“完全停靠（无 CSS 滑出）”时球的左上角坐标。 */
  private ballPosFor(edge: Edge): LogicalPosition {
    const x = edge === "left" ? 0 : this.screen.w - BALL;
    const y = Math.round(this.dockY - BALL / 2);
    return new LogicalPosition(x, y);
  }

  /** 把球放到指定边的停靠位。interactive 控制是否穿透鼠标（隐藏态穿透、展示态不穿透）。 */
  async placeBall(edge: Edge, interactive: boolean): Promise<void> {
    this.dockEdge = edge;
    await this.win.setSize(new LogicalSize(BALL, BALL));
    await this.win.setIgnoreCursorEvents(!interactive);
    await this.win.setPosition(this.ballPosFor(edge));
  }

  /** 当前贴附的边。 */
  currentEdge(): Edge {
    return this.dockEdge;
  }

  /** 隐藏态：停靠、鼠标穿透、并由 CSS 滑出半截。 */
  async dockHidden(): Promise<void> {
    await this.placeBall(this.dockEdge, false);
  }

  /** 展示态：停靠、完全在屏内、可点击。 */
  async showBall(): Promise<void> {
    await this.placeBall(this.dockEdge, true);
  }

  /**
   * 贴边吸附：比较球当前的中心 X 与屏幕中线，决定贴左还是贴右；
   * 只移动 X 轴，保留释放时的 Y 高度（同时同步 dockY 供后续使用）。
   */
  async snapBallToNearestEdge(): Promise<void> {
    const dpr = window.devicePixelRatio || 1;
    const phys = await this.win.outerPosition();
    // outerPosition 返回的是物理像素，转成逻辑像素才能和 screen 比较。
    const pos = phys.toLogical(dpr);
    const cx = pos.x + BALL / 2; // 球的中心 X（逻辑像素）
    const edge: Edge = cx < this.screen.w / 2 ? "left" : "right";
    // 保持释放高度，并把它记进 dockY，避免下次被拉回旧高度。
    this.dockY = this.clampY(pos.y + BALL / 2);
    this.dockEdge = edge;
    await this.win.setPosition(this.ballPosFor(edge));
  }

  /**
   * 开始 OS 级窗口拖动（系统接管，无残影）。
   * 由于 OS 拖动期间 WebView 收不到 mouseup，这里用“轮询位置”判断松手：
   * 位置连续若干拍不变即认为已松开，再执行吸附并触发 onDragEnd。
   */
  startDragging(): Promise<void> {
    if (this.dragPoll !== null) window.clearInterval(this.dragPoll);
    const promise = this.win.startDragging();
    let last: { x: number; y: number } | null = null;
    let stable = 0; // 连续稳定的拍数
    this.dragPoll = window.setInterval(async () => {
      try {
        const p = await this.win.outerPosition();
        if (last && p.x === last.x && p.y === last.y) {
          stable += 1;
          // 连续 3 拍（约 150ms）不动 => 鼠标已松开。
          if (stable >= 3) {
            if (this.dragPoll !== null) window.clearInterval(this.dragPoll);
            this.dragPoll = null;
            await this.snapBallToNearestEdge();
            this.dragEndCb?.(this.dockEdge);
          }
        } else {
          stable = 0;
        }
        last = { x: p.x, y: p.y };
      } catch (e) {
        console.error("[dragPoll] 失败:", e);
      }
    }, 50);
    return promise;
  }

  /** 展开为笔记面板：紧贴停靠侧向外（左贴则向右、右贴则向左）弹出，垂直中心对齐球。 */
  async expandPanel(): Promise<void> {
    await this.win.setIgnoreCursorEvents(false);
    await this.win.setSize(new LogicalSize(PANEL_W, PANEL_H));
    const ballPos = this.ballPosFor(this.dockEdge);
    const ballCy = ballPos.y + BALL / 2; // 球的中心 Y
    const y = Math.max(8, Math.min(ballCy - PANEL_H / 2, this.screen.h - PANEL_H - 8));
    // 紧贴边沿：右贴时面板左边界 = 球左边界；左贴时面板右边界 = 球右边界。不再留 8px 间距。
    const x = this.dockEdge === "right" ? ballPos.x - PANEL_W : ballPos.x + BALL;
    await this.win.setPosition(new LogicalPosition(Math.round(x), Math.round(y)));
  }

  /** 返回当前模式下 UI 在屏幕上的实际可见矩形，供 proximity 判定“鼠标是否在内”。 */
  boundsForMode(mode: "hidden" | "revealed" | "expanded"): Rect {
    const top = Math.round(this.dockY - BALL / 2);
    if (mode === "expanded") {
      const ballPos = this.ballPosFor(this.dockEdge);
      const ballCy = ballPos.y + BALL / 2;
      const y = Math.max(8, Math.min(ballCy - PANEL_H / 2, this.screen.h - PANEL_H - 8));
      const left = this.dockEdge === "right" ? ballPos.x - PANEL_W : ballPos.x + BALL;
      return { left, right: left + PANEL_W, top: y, bottom: y + PANEL_H };
    }
    if (mode === "revealed") {
      const pos = this.ballPosFor(this.dockEdge);
      return { left: pos.x, right: pos.x + BALL, top: pos.y, bottom: pos.y + BALL };
    }
    // hidden：仅 CSS 留下的 PEEK 宽“缝”。
    return this.dockEdge === "right"
      ? { left: this.screen.w - PEEK, right: this.screen.w, top, bottom: top + BALL }
      : { left: 0, right: PEEK, top, bottom: top + BALL };
  }
}
