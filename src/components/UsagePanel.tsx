import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import {
  loadUsage,
  type UsageDay,
  type UsageSession,
  type UsageTotal,
} from "../lib/usage";
import type { AppConfig } from "../lib/config";

interface Props {
  /** 当前配置（读取使用统计开关）。 */
  config: AppConfig;
  /** 配置项变动时回调（应用会实时应用并持久化到 localStorage）。 */
  onChange: (next: AppConfig) => void;
  /** 关闭面板。 */
  onClose: () => void;
}

/** 饼图与时间线共用的配色，按当天时长降序依次取用（纸感低饱和）。 */
const PALETTE = [
  "#c45c48",
  "#d8a93c",
  "#5a8f4e",
  "#4a7fa5",
  "#8a6bb0",
  "#b5704f",
  "#4f8f8a",
  "#a9637f",
];
/** 一天的毫秒数：时间线横轴的跨度。 */
const DAY_MS = 24 * 60 * 60 * 1000;
/** 显示区间在首尾各留的余量：裁掉整段空白，但别让色块顶到条的两端。 */
const RANGE_PAD_MS = 3 * 60 * 1000;
/** 跨度下限：只有一两条很短的会话时，不至于被放大到占满整条、看着像用了一整天。 */
const MIN_SPAN_MS = 30 * 60 * 1000;
/** 网格步长的候选（由小到大取第一个够疏的）。 */
const GRID_STEPS_MS = [5, 10, 15, 30, 60, 120, 180, 360].map((m) => m * 60 * 1000);
/** 相邻刻度标签的最小像素间距：小于它就不显示，避免文字互相压住。 */
const MIN_LABEL_GAP_PX = 44;
/** 面板打开期间的自动刷新间隔（毫秒）。 */
const REFRESH_MS = 30_000;

/** 去掉 .exe 后缀，只显示程序名。 */
const appLabel = (app: string): string => app.replace(/\.exe$/i, "");

/** 毫秒转「1h 23m」/「23m」/「42s」。 */
function fmtDur(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  return `${Math.floor(m / 60)}h ${m % 60}m`;
}

/** 时间戳转「09:05」（本地时间）。 */
function fmtClock(ms: number): string {
  const d = new Date(ms);
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}

/** 应用 -> 配色。按总时长排名取色，保证图例、时间线、饼图里同一应用始终同色。 */
function colorMap(totals: UsageTotal[]): Map<string, string> {
  const map = new Map<string, string>();
  totals.forEach((t, i) => map.set(t.app, PALETTE[i % PALETTE.length]));
  return map;
}

/**
 * 按当天实际会话裁出显示区间：去掉首尾整段的空白，只看真正有内容的那一段。
 * 整天不用电脑时中间的大片空白毫无信息量，还会把有效区间压成一条细线。
 */
function visibleRange(sessions: UsageSession[], dayStart: number): [number, number] {
  let from = Math.min(...sessions.map((s) => s.start)) - RANGE_PAD_MS;
  let to = Math.max(...sessions.map((s) => s.end)) + RANGE_PAD_MS;
  if (to - from < MIN_SPAN_MS) {
    // 只有一两条很短的会话时，按最小跨度居中铺开，避免被放大成「用了一整天」。
    const mid = (from + to) / 2;
    from = mid - MIN_SPAN_MS / 2;
    to = mid + MIN_SPAN_MS / 2;
  }
  // 夹回当天内：越界的部分本来就没有数据。
  return [Math.max(from, dayStart), Math.min(to, dayStart + DAY_MS)];
}

/** 取一个让网格线不超过 4 条的步长（网格同时用作刻度标签，太密会糊成一片）。 */
function gridStep(span: number): number {
  return GRID_STEPS_MS.find((s) => span / s <= 4) ?? GRID_STEPS_MS[GRID_STEPS_MS.length - 1];
}

/** 横向时间线：只显示有内容的区间，每个会话按所属应用着色，悬停看详情。 */
function Timeline({
  sessions,
  dayStart,
  colors,
}: {
  sessions: UsageSession[];
  dayStart: number;
  colors: Map<string, string>;
}) {
  const [from, to] = visibleRange(sessions, dayStart);
  const span = Math.max(to - from, 1);
  const step = gridStep(span);

  // 区间内的整/半点作为网格线与刻度，画在色块之下。
  // 两端各让开 1ms：否则区间端点正好落在整点时，刻度与端点标签会重复。
  const grids: number[] = [];
  for (let t = Math.ceil((from + 1) / step) * step; t < to - 1; t += step) grids.push(t);

  const barRef = useRef<HTMLDivElement>(null);
  const tipRef = useRef<HTMLDivElement>(null);
  /** 悬停中的会话，以及色块中心的横向位置（px，相对色条）。 */
  const [hover, setHover] = useState<{ session: UsageSession; cx: number } | null>(null);
  /** 浮层最终的横向位置：按其真实宽度夹进色条范围后的结果。 */
  const [tipX, setTipX] = useState(0);
  /** 色条的像素宽度（刻度标签抽稀用）。 */
  const [barWidth, setBarWidth] = useState(0);

  /** 时间 -> 百分比位置（相对显示区间，而非整天）。 */
  const pos = (t: number) => ((t - from) / span) * 100;

  /** 记录悬停会话：先按色块中心落位，绘制前再按浮层真实宽度夹紧（见下方 effect）。 */
  const enter = (session: UsageSession, seg: DOMRect) => {
    const bar = barRef.current?.getBoundingClientRect();
    if (!bar) return;
    setHover({ session, cx: seg.left + seg.width / 2 - bar.left });
  };

  // 浮层宽度随内容（应用名）变化，渲染前拿不到；useLayoutEffect 在绘制前量出
  // 真实宽度，把锚点夹到「浮层边缘恰好贴齐色条边缘」——不往里缩，也不越界。
  // 在绘制前完成修正，肉眼看不到中间态。
  useLayoutEffect(() => {
    if (!hover) return;
    const bar = barRef.current;
    const tip = tipRef.current;
    if (!bar || !tip) return;
    const half = tip.offsetWidth / 2;
    setTipX(Math.min(Math.max(hover.cx, half), bar.clientWidth - half));
  }, [hover]);

  // 色条的像素宽度：刻度标签要按实际像素间距抽稀，否则窄面板上文字会叠在一起。
  // layout effect 里量，首帧就能拿到；之后随窗口尺寸变化保持同步。
  useLayoutEffect(() => {
    const el = barRef.current;
    if (!el) return;
    const measure = () => setBarWidth(el.clientWidth);
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // 刻度标签：区间两端必显示，中间的网格点按最小像素间距抽稀，
  // 挤不下时让位给后面的（末端时间优先保留）。
  const labels: number[] = [];
  for (const [i, t] of [from, ...grids, to].entries()) {
    const x = (pos(t) / 100) * barWidth;
    const last = labels[labels.length - 1];
    if (last !== undefined) {
      const gap = x - (pos(last) / 100) * barWidth;
      if (gap < MIN_LABEL_GAP_PX) {
        // 末端标签挤不下时，去掉上一个，保证结尾时刻始终可见。
        if (i === grids.length + 1) labels.pop();
        else continue;
      }
    }
    labels.push(t);
  }

  return (
    <div className="usage-tl">
      <div className="usage-tl-bar-wrap">
        <div className="usage-tl-bar" ref={barRef}>
        {grids.map((t) => (
          <span key={t} className="usage-tl-grid" style={{ left: `${pos(t)}%` }} />
        ))}
        {sessions.map((s, i) => {
          // 会话按显示区间裁剪：越界的部分不画，避免算出负宽度。
          const start = Math.max(s.start, from);
          const end = Math.min(Math.max(s.end, start), to);
          return (
            <span
              key={i}
              className="usage-tl-seg"
              style={{
                left: `${pos(start)}%`,
                // 极短的会话（切窗口瞬间）也要看得见，给一点最小宽度。
                width: `${Math.max(pos(end) - pos(start), 0.5)}%`,
                background: colors.get(s.app) ?? PALETTE[0],
              }}
              onMouseEnter={(e) => enter(s, e.currentTarget.getBoundingClientRect())}
              onMouseLeave={() => setHover(null)}
            />
          );
          })}
        </div>
        {hover && (
          // 画在色条正上方、面板内部：窗口之外没有像素可用，而面板的撕纸边缘
          // 是 clip-path，任何越界的后代都会被裁掉，所以只能往里放。
          <div ref={tipRef} className="usage-tl-tip" style={{ left: `${tipX}px` }}>
            <span className="usage-tip-head">
              <span
                className="usage-tip-dot"
                style={{ background: colors.get(hover.session.app) }}
              />
              <span className="usage-tip-name">{appLabel(hover.session.app)}</span>
            </span>
            <span className="usage-tip-time">
              {`${fmtClock(hover.session.start)}–${fmtClock(hover.session.end)}`}
              <span className="usage-tip-dur">
                {fmtDur(hover.session.end - hover.session.start)}
              </span>
            </span>
          </div>
        )}
      </div>
      <div className="usage-tl-axis">
        {/* 首尾标签贴边对齐，避免被面板裁掉一半。 */}
        {labels.map((t, i, all) => (
          <span
            key={t}
            className="usage-tl-tick"
            style={{
              left: `${pos(t)}%`,
              transform:
                i === 0 ? "none" : i === all.length - 1 ? "translateX(-100%)" : "translateX(-50%)",
            }}
          >
            {fmtClock(t)}
          </span>
        ))}
      </div>
    </div>
  );
}

/** 圆饼图：各应用总时长占比，中心显示当天合计。 */
function Pie({ totals, colors }: { totals: UsageTotal[]; colors: Map<string, string> }) {
  const sum = totals.reduce((s, t) => s + t.ms, 0);
  const r = 42;
  const circumference = 2 * Math.PI * r;
  // 逐段累加弧长：用虚线偏移把每段接到上一段末尾，省去手算扇形路径。
  let offset = 0;

  return (
    <div className="usage-pie-wrap">
      <svg viewBox="0 0 120 120" className="usage-pie">
        <circle cx="60" cy="60" r={r} className="usage-pie-track" strokeWidth="16" fill="none" />
        {totals.map((t) => {
          const len = sum > 0 ? (t.ms / sum) * circumference : 0;
          const el = (
            <circle
              key={t.app}
              cx="60"
              cy="60"
              r={r}
              fill="none"
              strokeWidth="16"
              stroke={colors.get(t.app)}
              strokeDasharray={`${len} ${Math.max(circumference - len, 0)}`}
              strokeDashoffset={-offset}
              transform="rotate(-90 60 60)"
            />
          );
          offset += len;
          return el;
        })}
      </svg>
      <div className="usage-pie-center">
        <span className="usage-pie-total">{fmtDur(sum)}</span>
        <span className="usage-pie-sub">今日合计</span>
      </div>
    </div>
  );
}

/**
 * 使用统计面板（覆盖层）：开关采样、当天时间线、各应用占比饼图。
 * 数据来自 Rust 采样器（usage.rs），只统计当天。
 */
export default function UsagePanel({ config, onChange, onClose }: Props) {
  const [data, setData] = useState<UsageDay | null>(null);

  const refresh = useCallback(() => {
    loadUsage()
      .then(setData)
      .catch((e) => console.error("[usage] 读取失败:", e));
  }, []);

  // 打开即读一次，之后定时刷新：采样在后台持续进行，面板停留时需要跟上。
  useEffect(() => {
    refresh();
    const timer = window.setInterval(refresh, REFRESH_MS);
    return () => window.clearInterval(timer);
  }, [refresh]);

  const totals = data?.totals ?? [];
  const colors = colorMap(totals);
  // 后端按「凌晨 4 点」分日：日期串是逻辑日，该日的 04:00 才是时间线原点。
  const dayStart = data ? new Date(`${data.day}T04:00:00`).getTime() : 0;
  const sum = totals.reduce((s, t) => s + t.ms, 0);

  return (
    <div className="skin-overlay" onClick={onClose}>
      <div className="skin-panel usage-panel" onClick={(e) => e.stopPropagation()}>
        <div className="skin-head">
          <span>使用统计</span>
          <span className="skin-x" onClick={onClose} title="关闭">
            ×
          </span>
        </div>
        <div className="skin-body">
          <label
            className="set-switch-row"
            title="记录每个前台应用的使用时长；数据只写进本机的 notes.db"
          >
            <span className="set-label">记录应用使用时间</span>
            <input
              type="checkbox"
              className="set-switch"
              checked={config.usageTracking}
              onChange={(e) => onChange({ ...config, usageTracking: e.target.checked })}
            />
          </label>

          <div className="usage-group">
            <div className="usage-group-title">时间线</div>
            {data && totals.length > 0 ? (
              <Timeline sessions={data.sessions} dayStart={dayStart} colors={colors} />
            ) : (
              <div className="usage-empty">今天还没有记录</div>
            )}
          </div>

          <div className="usage-group">
            <div className="usage-group-title">应用分布</div>
            {totals.length > 0 ? (
              <div className="usage-pie-row">
                <Pie totals={totals} colors={colors} />
                <div className="usage-legend">
                  {totals.map((t) => (
                    <div className="usage-legend-row" key={t.app}>
                      <span className="usage-dot" style={{ background: colors.get(t.app) }} />
                      <span className="usage-legend-name" title={appLabel(t.app)}>
                        {appLabel(t.app)}
                      </span>
                      <span className="usage-legend-time">{fmtDur(t.ms)}</span>
                      <span className="usage-legend-pct">
                        {sum > 0 ? Math.round((t.ms / sum) * 100) : 0}%
                      </span>
                    </div>
                  ))}
                </div>
              </div>
            ) : (
              <div className="usage-empty">暂无数据</div>
            )}
          </div>

          <div className="usage-hint">
            以凌晨 4 点为界统计当天（熬夜到 3 点仍算前一天）；历史记录保留 30 天后自动清理。
          </div>
        </div>
      </div>
    </div>
  );
}
