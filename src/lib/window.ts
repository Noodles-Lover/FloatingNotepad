import { getCurrentWindow } from "@tauri-apps/api/window";
import type { UnlistenFn } from "@tauri-apps/api/event";
import { LogicalPosition, LogicalSize } from "@tauri-apps/api/dpi";
import type { ScreenSize } from "./screen";

/** 贴附的边：只在左右两边之间切换。 */
export type Edge = "left" | "right";

/** 屏幕坐标矩形（左/右/上/下）。 */
export interface Rect {
  left: number;
  right: number;
  top: number;
  bottom: number;
}

/** 挂件停靠位置的存储 key。与皮肤名一样独立于配置对象：位置由拖动产生，不是“设置项”。 */
const DOCK_KEY = "floating-notepad.dock";

/** 读取上次的停靠位置；未记录过或数据损坏时返回 null（由调用方回落到屏幕中央）。 */
export function loadDock(): { edge: Edge; y: number } | null {
  try {
    const raw = localStorage.getItem(DOCK_KEY);
    if (!raw) return null;
    const v = JSON.parse(raw) as { edge?: unknown; y?: unknown };
    if (v.edge !== "left" && v.edge !== "right") return null;
    if (typeof v.y !== "number" || !Number.isFinite(v.y)) return null;
    return { edge: v.edge, y: v.y };
  } catch {
    return null;
  }
}

/** 记住挂件当前停靠位置，使下次启动从同一处出现。 */
export function saveDock(edge: Edge, y: number): void {
  try {
    localStorage.setItem(DOCK_KEY, JSON.stringify({ edge, y }));
  } catch {
    /* 忽略：隐私模式下可能写入失败 */
  }
}

/** 容器在素材宽度之外额外留出的宽度（逻辑像素）。图片贴着停靠边，这段留白落在朝屏幕内侧。 */
export const WIDGET_BOX_PAD_X = 20;

/** 「隐藏态露出多少」在这个比例上定：滑出后剩下的那条缝 = 宽度的 45%。 */
const HIDDEN_PEEK_RATIO = 0.5;

/** 显示器变化事件的去抖时长（毫秒）：拖动窗口时 onMoved 很密集。 */
const SCREEN_CHANGE_DEBOUNCE_MS = 300;

/**
 * 挂件尺寸策略的结果。宽高给容器/窗口，peek 给“隐藏态露出多少”这一件事——
 * CSS 的滑出量与 proximity 的判定矩形都取这一个值。
 */
export interface WidgetBox {
  /** 容器（= 窗口）宽度，逻辑像素 */
  width: number;
  /** 容器（= 窗口）高度，逻辑像素 */
  height: number;
  /** 隐藏态露出的那条缝的宽度：容器滑出 `width - peek`，判定矩形也用它 */
  peek: number;
}

/**
 * 挂件容器与窗口的尺寸（逻辑像素），也就是“配置尺寸 → 素材实际大小”的全部映射规则：
 * 素材按 `size × size` 的方框等比缩放，长边恰好等于配置的挂件大小，短边按素材比例收缩，
 * 宽度再额外留出 `WIDGET_BOX_PAD_X`。
 *
 * 容器尺寸必须与图片严格对上（除了那段刻意留的宽度）：窗口矩形与 proximity 判定都按容器算，
 * 容器比图片大出的那一圈会变成「幽灵碰撞箱」——鼠标落在图片外的空处依然判定为“在挂件内”。
 */
export function widgetBoxFor(size: number, ratio: number): WidgetBox {
  // 比例非法（素材尚未探测出来）时按方形兜底。
  const r = Number.isFinite(ratio) && ratio > 0 ? ratio : 1;
  const long = Math.max(1, Math.round(size));
  const short = Math.max(1, Math.round(long * Math.min(r, 1 / r)));
  // 长边随素材朝向落在宽或高上；宽度统一加留白，图片本身仍贴着停靠边。
  const width = (r >= 1 ? long : short) + WIDGET_BOX_PAD_X;
  const height = r >= 1 ? short : long;
  return { width, height, peek: Math.max(1, Math.round(width * HIDDEN_PEEK_RATIO)) };
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
  /** 屏幕逻辑尺寸。初始用 window.screen 兜底，App 读到真实显示器尺寸后由 applyScreen() 覆盖。 */
  private screen = { w: window.screen.width, h: window.screen.height };
  private dockEdge: Edge = "right"; // 当前贴附的边
  private dockY: number; // 当前停靠高度的“中心 Y”（逻辑像素）
  private dragEndCb: ((edge: Edge) => void) | null = null; // 拖动结束回调
  private dragPoll: number | null = null; // 拖动松手检测的定时器
  /** 是否使用整颗停靠模式：变化模式（idle/hover 两张）下“半掩”由素材自身表现，挂件不再做 CSS 滑出。 */
  private solidMode = false;
  /**
   * 挂件容器（= 窗口）的实际尺寸与隐藏态露出宽度。由 App 用 `widgetBoxFor(配置尺寸, 素材比例)`
   * 算好后下发（见 setWidgetBox）——控制器不自己算：窗口与 CSS 容器必须取同一个值，
   * 各算一遍或其中一方跟不上，就会出现“看着有但摸不到”或“摸得到但看不见”。
   */
  private box: WidgetBox;

  constructor(widgetSize: number = 56) {
    // 先按方形占位，App 挂载后立刻用真实尺寸覆盖。
    this.box = widgetBoxFor(widgetSize, 1);
    const saved = loadDock();
    if (saved) {
      this.dockEdge = saved.edge;
      this.dockY = saved.y;
    } else {
      // 没有记录时初始停靠在垂直正中央。
      this.dockY = Math.round(this.screen.h / 2);
    }
  }

  /** 注册“OS 拖动结束”回调；挂件吸附到就近边后会带上最终边沿调用它。 */
  onDragEnd(cb: (edge: Edge) => void): void {
    this.dragEndCb = cb;
  }

  /**
   * 更新屏幕逻辑尺寸。由 App 统一读一次后下发（两个控制器共用），
   * 同时把停靠 Y 夹回可见范围：换显示器/改分辨率后，旧坐标可能已落到屏幕外。
   * 注意：window.screen 在 Tauri WebView 里不可靠，只有 currentMonitor() 的尺寸能用（见 lib/screen.ts）。
   */
  applyScreen(size: ScreenSize): void {
    this.screen = size;
    this.dockY = this.clampY(this.dockY);
  }

  /**
   * 订阅“当前显示器可能变了”：改缩放（DPI）与窗口移动（换显示器）都会触发。
   * 只做订阅 + 去抖（拖动期间 onMoved 很密集），是否重读屏幕尺寸、是否重排由调用方决定。
   * 不订阅的话，中途插拔显示器/改缩放会一直按旧屏幕尺寸算坐标，窗口可能跑到屏幕外。
   * @returns 取消订阅函数
   */
  watchScreenChange(cb: () => void): () => void {
    let timer: number | null = null;
    const fire = () => {
      if (timer !== null) window.clearTimeout(timer);
      timer = window.setTimeout(cb, SCREEN_CHANGE_DEBOUNCE_MS);
    };
    const unlisteners: UnlistenFn[] = [];
    const bind = (p: Promise<UnlistenFn>) =>
      p.then((fn) => unlisteners.push(fn)).catch((e) => console.error("[screen-watch] 注册失败:", e));
    bind(this.win.onScaleChanged(fire));
    bind(this.win.onMoved(fire));
    return () => {
      if (timer !== null) window.clearTimeout(timer);
      unlisteners.forEach((fn) => fn());
    };
  }

  /** 更新挂件容器尺寸并立即重新停靠（面板打开时应改用 syncWidgetBox）。 */
  async setWidgetBox(box: WidgetBox): Promise<void> {
    this.syncWidgetBox(box);
    await this.placeWidget(this.dockEdge);
  }

  /**
   * 仅记录容器尺寸，不触发窗口 resize/重排：
   * 面板（笔记/设置）打开时调用——避免把整窗缩成挂件大小导致面板被卸载、留下一个小圆点；
   * 真正应用留到收起后由 showWidget/dockHidden 自然带上。
   */
  syncWidgetBox(box: WidgetBox): void {
    const nums = [box.width, box.height, box.peek];
    if (!nums.every((n) => Number.isFinite(n) && n > 0)) return;
    this.box = {
      width: Math.round(box.width),
      height: Math.round(box.height),
      peek: Math.round(box.peek),
    };
  }

  /** 把任意垂直中心 Y 限制在屏幕可见范围内。 */
  private clampY(cy: number): number {
    const half = this.box.height / 2;
    return Math.max(half, Math.min(this.screen.h - half, cy));
  }

  /** 计算“完全停靠（无 CSS 滑出）”时挂件的左上角坐标。 */
  private widgetPosFor(edge: Edge): LogicalPosition {
    const x = edge === "left" ? 0 : this.screen.w - this.box.width;
    const y = Math.round(this.dockY - this.box.height / 2);
    return new LogicalPosition(x, y);
  }

  /** 把挂件放到指定边的停靠位（仅位置/尺寸，不涉及鼠标穿透）。 */
  async placeWidget(edge: Edge): Promise<void> {
    this.dockEdge = edge;
    // 先移动再缩放：setSize 以窗口左上角为锚点，若先缩后移，窗口会瞬间收缩到旧（面板）位置的
    // 左上角再跳到挂件位，视觉上出现“闪到面板角落再回正”的闪烁。先定位到挂件位再缩即可消除。
    await this.win.setPosition(this.widgetPosFor(edge));
    await this.win.setSize(new LogicalSize(this.box.width, this.box.height));
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

  /** 隐藏态：停靠并由 CSS 滑出半截；保持可交互以便接收右键菜单与点击。 */
  async dockHidden(): Promise<void> {
    await this.placeWidget(this.dockEdge);
  }

  /** 展示态：停靠、完全在屏内、可点击。 */
  async showWidget(): Promise<void> {
    await this.placeWidget(this.dockEdge);
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

  /** 仅显示窗口（不重排位置、不改交互态）。穿透态下用于让挂件常驻可见。 */
  async showOnly(): Promise<void> {
    await this.win.show();
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
    const { width, height } = this.box;
    const cx = pos.x + width / 2; // 挂件的中心 X（逻辑像素）
    const edge: Edge = cx < this.screen.w / 2 ? "left" : "right";
    // 保持释放高度，并把它记进 dockY，避免下次被拉回旧高度。
    this.dockY = this.clampY(pos.y + height / 2);
    this.dockEdge = edge;
    await this.win.setPosition(this.widgetPosFor(edge));
    // 记住这次停靠，下次启动从同一处出现。
    saveDock(this.dockEdge, this.dockY);
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
    const { width, height, peek } = this.box;
    const top = Math.round(this.dockY - height / 2);
    if (mode === "revealed") {
      // revealed：窗口已真实停在停靠位，直接读真实位置。
      const dpr = window.devicePixelRatio || 1;
      const physPos = await this.win.outerPosition();
      const pos = physPos.toLogical(dpr);
      return {
        left: pos.x,
        right: pos.x + width,
        top: pos.y,
        bottom: pos.y + height,
      };
    }
    // hidden：滑动模式下 CSS 把挂件滑出，只露 peek 宽的“缝”，碰撞箱只算那条缝
    // （peek 与 CSS 的滑出量同源，见 widgetBoxFor）。
    // 变化模式下挂件不滑出（半掩由素材表现），碰撞箱为整颗挂件。
    if (this.solidMode) {
      return this.dockEdge === "right"
        ? { left: this.screen.w - width, right: this.screen.w, top, bottom: top + height }
        : { left: 0, right: width, top, bottom: top + height };
    }
    return this.dockEdge === "right"
      ? { left: this.screen.w - peek, right: this.screen.w, top, bottom: top + height }
      : { left: 0, right: peek, top, bottom: top + height };
  }
}
