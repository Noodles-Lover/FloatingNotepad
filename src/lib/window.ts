import { getCurrentWindow } from "@tauri-apps/api/window";
import { LogicalPosition, LogicalSize } from "@tauri-apps/api/dpi";

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
 * - 挂件停靠在左或右边沿的任意垂直高度；
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
  /** 是否使用整颗停靠模式：变化模式（idle/hover 两张）下“半掩”由素材自身表现，挂件不再做 CSS 滑出。 */
  private solidMode = false;
  /** 悬浮挂件尺寸（逻辑像素），由用户配置驱动。 */
  private widgetSize: number;

  constructor(widgetSize: number = 56) {
    this.widgetSize = widgetSize;
    // 初始停靠在垂直正中央。
    this.dockY = Math.round(this.screen.h / 2);
  }

  /** 注册“OS 拖动结束”回调；挂件吸附到就近边后会带上最终边沿调用它。 */
  onDragEnd(cb: (edge: Edge) => void): void {
    this.dragEndCb = cb;
  }

  /** 设置悬浮挂件尺寸（逻辑像素），并立即按新尺寸重新停靠。 */
  async setWidgetSize(size: number, interactive: boolean): Promise<void> {
    this.widgetSize = size;
    await this.placeWidget(this.dockEdge, interactive);
  }

  /**
   * 仅同步内部挂件尺寸，不触发任何窗口 resize/重排。
   * 面板（笔记/设置）打开时调用：避免把整窗缩成挂件大小导致面板被卸载/留下小圆点，
   * 真正应用尺寸留到收起后由 showWidget/dockHidden 自然处理。
   */
  syncWidgetSize(size: number): void {
    this.widgetSize = size;
  }

  /** 把任意垂直中心 Y 限制在屏幕可见范围内。 */
  private clampY(cy: number): number {
    const min = this.widgetSize / 2;
    const max = this.screen.h - this.widgetSize / 2;
    return Math.max(min, Math.min(max, cy));
  }

  /** 计算“完全停靠（无 CSS 滑出）”时挂件的左上角坐标。 */
  private widgetPosFor(edge: Edge): LogicalPosition {
    const x = edge === "left" ? 0 : this.screen.w - this.widgetSize;
    const y = Math.round(this.dockY - this.widgetSize / 2);
    return new LogicalPosition(x, y);
  }

  /** 把挂件放到指定边的停靠位。interactive 控制是否穿透鼠标（隐藏态穿透、展示态不穿透）。 */
  async placeWidget(edge: Edge, interactive: boolean): Promise<void> {
    this.dockEdge = edge;
    // 先移动再缩放：setSize 以窗口左上角为锚点，若先缩后移，窗口会瞬间收缩到旧（面板）位置的
    // 左上角再跳到挂件位，视觉上出现“闪到面板角落再回正”的闪烁。先定位到挂件位再缩即可消除。
    await this.win.setPosition(this.widgetPosFor(edge));
    await this.win.setSize(new LogicalSize(this.widgetSize, this.widgetSize));
    await this.win.setIgnoreCursorEvents(!interactive);
  }

  /** 当前贴附的边。 */
  currentEdge(): Edge {
    return this.dockEdge;
  }

  /** 设置是否使用整颗停靠模式（变化模式为整颗，滑动模式由 CSS 滑出；影响 hidden 撞箱范围）。 */
  setSolidMode(on: boolean): void {
    this.solidMode = on;
  }

  /** 挂件当前的中心 Y（逻辑像素），面板展开时用来垂直对齐。 */
  getDockY(): number {
    return this.dockY;
  }

  /** 隐藏态：停靠、鼠标穿透、并由 CSS 滑出半截。 */
  async dockHidden(): Promise<void> {
    await this.placeWidget(this.dockEdge, false);
  }

  /** 展示态：停靠、完全在屏内、可点击。 */
  async showWidget(): Promise<void> {
    await this.placeWidget(this.dockEdge, true);
  }

  /** 完全隐藏整个应用窗口（托盘“隐藏挂件”用）。 */
  async hideApp(): Promise<void> {
    await this.win.hide();
  }

  /** 显示整个应用窗口并回到展示态（托盘“显示挂件”用）。 */
  async showApp(): Promise<void> {
    await this.win.show();
    await this.showWidget();
  }

  /**
   * 贴边吸附：比较挂件当前的中心 X 与屏幕中线，决定贴左还是贴右；
   * 只移动 X 轴，保留释放时的 Y 高度（同时同步 dockY 供后续使用）。
   */
  async snapWidgetToNearestEdge(): Promise<void> {
    const dpr = window.devicePixelRatio || 1;
    const phys = await this.win.outerPosition();
    // outerPosition 返回的是物理像素，转成逻辑像素才能和 screen 比较。
    const pos = phys.toLogical(dpr);
    const cx = pos.x + this.widgetSize / 2; // 挂件的中心 X（逻辑像素）
    const edge: Edge = cx < this.screen.w / 2 ? "left" : "right";
    // 保持释放高度，并把它记进 dockY，避免下次被拉回旧高度。
    this.dockY = this.clampY(pos.y + this.widgetSize / 2);
    this.dockEdge = edge;
    await this.win.setPosition(this.widgetPosFor(edge));
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
            await this.snapWidgetToNearestEdge();
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

  /**
   * 返回“挂件”在当前模式下的实际可见矩形，供 proximity 判定鼠标是否在内。
   * 只处理 hidden / revealed 两种挂件形态；expanded（笔记面板）由 NoteWindow 负责。
   */
  async boundsForMode(mode: "hidden" | "revealed"): Promise<Rect> {
    const top = Math.round(this.dockY - this.widgetSize / 2);
    // 隐藏态只露出的“缝”宽度：随挂件大小，但不超过一半。
    const peek = Math.round(this.widgetSize * 0.45);
    if (mode === "revealed") {
      // revealed：窗口已真实停在停靠位，直接读真实位置。
      const dpr = window.devicePixelRatio || 1;
      const physPos = await this.win.outerPosition();
      const pos = physPos.toLogical(dpr);
      return {
        left: pos.x,
        right: pos.x + this.widgetSize,
        top: pos.y,
        bottom: pos.y + this.widgetSize,
      };
    }
    // hidden：滑动模式下 CSS 把挂件滑出，只露 PEEK 宽的“缝”，碰撞箱只算那条缝。
    // 变化模式下挂件不滑出（半掩由素材表现），碰撞箱为整颗挂件。
    if (this.solidMode) {
      return this.dockEdge === "right"
        ? { left: this.screen.w - this.widgetSize, right: this.screen.w, top, bottom: top + this.widgetSize }
        : { left: 0, right: this.widgetSize, top, bottom: top + this.widgetSize };
    }
    return this.dockEdge === "right"
      ? { left: this.screen.w - peek, right: this.screen.w, top, bottom: top + this.widgetSize }
      : { left: 0, right: peek, top, bottom: top + this.widgetSize };
  }
}
