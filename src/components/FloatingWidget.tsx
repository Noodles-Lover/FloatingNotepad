import { useRef } from "react";
import type { Edge, WindowController } from "../lib/window";
import type { Skin } from "../lib/skins";

interface Props {
  /** 当前是否处于“展示”状态（完全可见、不透明）。 */
  revealed: boolean;
  /** 当前是否正在被拖动。 */
  dragging: boolean;
  /** 当前贴附的边。 */
  edge: Edge;
  /** 窗口控制器，负责实际的拖动与贴边逻辑。 */
  windowCtl: WindowController;
  /** 用户“点击”（非拖动）时回调，用于打开面板。 */
  onOpen: () => void;
  /** 拖动状态发生变化时回调（开始 / 结束），用于让 App 暂停或恢复 proximity 检测。 */
  onDraggingChange: (dragging: boolean) => void;
  /** 悬浮挂件尺寸（逻辑像素），用于让图片按尺寸等比例缩放。 */
  widgetSize: number;
  /** 闲置（隐藏态）时的不透明度（0.1~1）。 */
  idleOpacity: number;
  /** 当前选用的皮肤（决定渲染滑动模式还是变化模式）。 */
  skin: Skin;
}

/** 判定为“拖动”的最小位移（像素），小于此值视为点击。 */
const DRAG_THRESHOLD = 6;

/**
 * 悬浮挂件组件：只负责与鼠标直接相关的交互（按下、移动、点击判定），
 * 不涉及任何窗口布局/贴边计算——那些逻辑在 WindowController 里。
 * 渲染由 skin 决定：滑动模式用单张 widget.png 配合 CSS 滑出半掩（隐藏态滑出半截，revealed 时整颗伸出）；
 * 变化模式用 idle/hover 两张图切换（整颗停靠，由图片自身表现半掩/伸出）。
 */
export default function FloatingWidget({
  revealed,
  dragging,
  edge,
  windowCtl,
  onOpen,
  onDraggingChange,
  widgetSize,
  idleOpacity,
  skin,
}: Props) {
  // 记录鼠标按下的起点，用于区分“点击”与“拖动”。
  const downPosRef = useRef<{ x: number; y: number } | null>(null);
  // 本次按下是否已经越过拖动阈值。
  const movedRef = useRef(false);
  // document 上的临时 mousemove 监听器引用，便于在结束时移除。
  const moveRef = useRef<((e: MouseEvent) => void) | null>(null);

  /** 鼠标按下：暂不启动 OS 拖动，先挂一个 mousemove 监听，等待越过阈值。 */
  const handleMouseDown = (e: React.MouseEvent) => {
    downPosRef.current = { x: e.clientX, y: e.clientY };
    movedRef.current = false;

    const onMove = (ev: MouseEvent) => {
      const start = downPosRef.current;
      if (!start) return;
      // 还没越过阈值：继续等待。
      if (!movedRef.current && Math.hypot(ev.clientX - start.x, ev.clientY - start.y) < DRAG_THRESHOLD) {
        return;
      }
      if (!movedRef.current) {
        // 首次越过阈值：交给 OS 接管拖动（无残影），并通知 App 进入拖动态。
        movedRef.current = true;
        document.removeEventListener("mousemove", onMove);
        moveRef.current = null;
        onDraggingChange(true);
        windowCtl.showWidget(); // 拖动前先把窗口设为可交互。
        windowCtl.startDragging().catch((err) => console.error("[startDragging] 失败:", err));
      }
    };

    moveRef.current = onMove;
    document.addEventListener("mousemove", onMove);
  };

  /** 鼠标点击：移除临时监听；若本次是拖动则忽略，否则视为点击并打开面板。 */
  const handleClick = (e: React.MouseEvent) => {
    const onMove = moveRef.current;
    if (onMove) {
      document.removeEventListener("mousemove", onMove);
      moveRef.current = null;
    }
    const start = downPosRef.current;
    downPosRef.current = null;
    // 位移过大或是拖动过的，都不算点击。
    if (start && Math.hypot(e.clientX - start.x, e.clientY - start.y) > DRAG_THRESHOLD) return;
    if (movedRef.current) return;
    onOpen();
  };

  // 根据状态拼装样式类。
  const cls = [
    "widget-wrap",
    revealed ? "revealed" : "hidden",
    dragging ? "dragging" : "",
    `dock-${edge}`,
    // 变化模式（idle/hover 两张）：整颗停靠、不滑出（滑动模式则用 CSS 滑出半掩）。
    skin.mode === "transform" ? "solid" : "",
    // 默认图按左侧设计：贴左侧时水平翻转，让“探出”方向朝右（滑动模式与变化模式通用）。
    edge === "left" ? "flipped" : "",
  ]
    .filter(Boolean)
    .join(" ");

  return (
    <div
      className={cls}
      style={{
        ["--widget-size" as string]: `${widgetSize}px`,
        ["--idle-opacity" as string]: `${idleOpacity}`,
      }}
      onMouseDown={handleMouseDown}
      onClick={handleClick}
      title="点击记一笔 · 拖动可贴边"
    >
      {skin.mode === "slide" ? (
        /* 滑动模式：单张 widget.png，整颗挂件；隐藏态由 CSS 滑出半掩。 */
        <img className="widget-img widget-img-single" src={skin.widget} alt="" draggable={false} />
      ) : (
        <>
          {/* 默认图（半掩）：隐藏态显示，hover 时淡出 */}
          <img className="widget-img widget-img-idle" src={skin.idle} alt="" draggable={false} />
          {/* hover 探出图：默认隐藏，revealed/hover 时淡入 */}
          <img className="widget-img widget-img-hover" src={skin.hover} alt="" draggable={false} />
        </>
      )}
    </div>
  );
}
