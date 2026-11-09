import {
  useEffect,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
} from "react";

const ITEM_H = 30;
const VISIBLE_ROWS = 3;
const GAP = 6;
const SETTLE_MS = 120;

const HOURS = Array.from({ length: 24 }, (_, h) => String(h).padStart(2, "0"));

interface Props {
  /** 当前时刻的小时（"HH"）；为空时滚轮停在 12:00。 */
  initialHour: string | null;
  /** 触发按钮的视口矩形。 */
  anchorRect: DOMRect;
  /** 面板的视口矩形：滚轮是面板的直接子元素，坐标要夹在它里面。 */
  panelRect: DOMRect;
  onSelect: (time: string) => void;
  onClose: () => void;
}

/**
 * 面板内的整点滚轮：选中值固定在中间，00:00~23:00 在背后上下滚动并 snap 到整点。
 * 全程是应用窗口内的 DOM，鼠标不会移出去触发自动收起。
 */
export default function HourWheel({
  initialHour,
  anchorRect,
  panelRect,
  onSelect,
  onClose,
}: Props) {
  const rootRef = useRef<HTMLDivElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const settleRef = useRef<number | null>(null);
  const skipInitialScrollRef = useRef(false);
  const [center, setCenter] = useState(() => {
    const i = HOURS.indexOf(initialHour ?? "12");
    return i < 0 ? 12 : i;
  });

  const height = ITEM_H * VISIBLE_ROWS;
  const width = 96;
  let left = anchorRect.right - panelRect.left - width;
  left = Math.max(8, Math.min(left, panelRect.width - width - 8));
  let top = anchorRect.bottom - panelRect.top + GAP;
  if (top + height > panelRect.height - 8) {
    top = anchorRect.top - panelRect.top - height - GAP;
  }
  top = Math.max(8, Math.min(top, panelRect.height - height - 8));

  const commit = (index: number) => {
    const i = Math.max(0, Math.min(HOURS.length - 1, index));
    onSelect(`${HOURS[i]}:00`);
  };

  const scrollTo = (index: number) => {
    const i = Math.max(0, Math.min(HOURS.length - 1, index));
    listRef.current?.scrollTo({ top: i * ITEM_H, behavior: "smooth" });
    setCenter(i);
  };

  useEffect(() => {
    const list = listRef.current;
    if (!list) return;
    // scrollTop 为 0 时不会触发 scroll 事件，其余情况跳过挂载引发的首次 scroll，
    // 避免「只是打开滚轮」就把默认值写进时刻。
    skipInitialScrollRef.current = center !== 0;
    list.scrollTop = center * ITEM_H;
    list.focus();
    return () => {
      if (settleRef.current !== null) window.clearTimeout(settleRef.current);
    };
  }, []);

  useEffect(() => {
    const onPointerDown = (e: PointerEvent) => {
      if (!rootRef.current?.contains(e.target as Node)) onClose();
    };
    document.addEventListener("pointerdown", onPointerDown);
    return () => document.removeEventListener("pointerdown", onPointerDown);
  }, [onClose]);

  const onScroll = () => {
    const list = listRef.current;
    if (!list) return;
    if (skipInitialScrollRef.current) {
      skipInitialScrollRef.current = false;
      return;
    }
    const index = Math.round(list.scrollTop / ITEM_H);
    setCenter((prev) => (prev === index ? prev : index));
    if (settleRef.current !== null) window.clearTimeout(settleRef.current);
    // 惯性滚动停稳后才写值；不依赖 scrollend（WebView2 不一定支持）。
    settleRef.current = window.setTimeout(() => commit(index), SETTLE_MS);
  };

  const onKeyDown = (e: ReactKeyboardEvent) => {
    if (e.key === "Escape") {
      e.stopPropagation(); // 别冒泡到 NotePanel 的 window 级 Escape 监听
      e.preventDefault();
      onClose();
    } else if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      scrollTo(center + (e.key === "ArrowDown" ? 1 : -1));
    } else if (e.key === "Enter") {
      e.preventDefault();
      commit(center);
      onClose();
    }
  };

  return (
    <div
      ref={rootRef}
      className="hour-wheel"
      style={{ left, top, width, height }}
      role="presentation"
    >
      <div className="hour-wheel-highlight" style={{ top: ITEM_H, height: ITEM_H }} />
      <div
        ref={listRef}
        className="hour-wheel-list"
        role="listbox"
        tabIndex={0}
        aria-label="选整点"
        aria-activedescendant={`hour-wheel-${HOURS[center]}`}
        onScroll={onScroll}
        onKeyDown={onKeyDown}
      >
        {HOURS.map((h, i) => (
          <div
            key={h}
            id={`hour-wheel-${h}`}
            className={`hour-wheel-item ${i === center ? "center" : ""}`}
            role="option"
            aria-selected={i === center}
            onClick={() => {
              commit(i);
              onClose();
            }}
          >
            {h}:00
          </div>
        ))}
      </div>
    </div>
  );
}
