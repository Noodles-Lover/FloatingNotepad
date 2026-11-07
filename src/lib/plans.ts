import { invoke } from "@tauri-apps/api/core";

/**
 * 「日程」系统标签页的固定 id：它是待办栏（分类）里的一行，与「主要」等分类并列，
 * 负数不会与自增 id 冲突，因此能安全地放进 categories 表随分类一起持久化。
 */
export const PLANS_TAB_ID = -1;

// 两套日界各管各的，别混用：
// - 展示 / 红点 / 角标 / 过期清理按「逻辑日」，凌晨 4:00 换日（熬夜那段算前一天）；
// - 新建日程选日期与 Rust 到点提醒按真实日历日，00:00 换日。
// 逻辑日把「次日 0~4 点」归到前一天的深夜：明天 1:30 的日程算今天，
// 今晚 23:00 就计入红点、显示「今天」。


export type PlanKind = "once" | "weekly";

/** 日程内容的最大字数：提醒小窗只有 220 宽，再长既读不完也会把窗口撑高。 */
export const PLAN_TEXT_MAX = 15;

/** 一条日程：`once` 用 date，`weekly` 用 weekday；time 为空表示不提醒。 */
export interface Plan {
  id: number;
  kind: PlanKind;
  /** YYYY-MM-DD */
  date: string | null;
  /** 0=周日 … 6=周六 */
  weekday: number | null;
  /** HH:MM */
  time: string | null;
  text: string;
}

/** 展开后的具体一次：`date` 是所属逻辑日（凌晨时刻已归到前一天）。 */
export interface Occurrence {
  plan: Plan;
  /** 所属逻辑日 YYYY-MM-DD */
  date: string;
  time: string | null;
}

/** 逻辑日的换日时刻：凌晨 4:00 之前算前一天。 */
const DAY_START_HOUR = 4;

interface Clock {
  /** 逻辑今天的日期串 */
  day: string;
  /** 逻辑今天星期几（0=周日） */
  weekday: number;
  /** 自逻辑日 00:00 起已过的分钟数；凌晨 0~4 点是 24:00~27:59 */
  minutes: number;
}

const pad = (n: number) => String(n).padStart(2, "0");

/** 逻辑时钟：凌晨 4:00 前回退一天，熬夜那段的分钟数顺延到 24 小时之后。 */
function clock(at: Date = new Date()): Clock {
  const early = at.getHours() < DAY_START_HOUR;
  const base = new Date(at);
  if (early) base.setDate(base.getDate() - 1);
  return {
    day: `${base.getFullYear()}-${pad(base.getMonth() + 1)}-${pad(base.getDate())}`,
    weekday: base.getDay(),
    // 凌晨 0~4 点属于前一天的深夜，那天的定时日程都算已过；只有无时刻的
    // 日程继续留在「今天还没到点」。
    minutes: at.getHours() * 60 + at.getMinutes() + (early ? 1440 : 0),
  };
}

/** 日期串加减天数。 */
export function addDays(day: string, n: number): string {
  const d = new Date(`${day}T00:00:00`);
  d.setDate(d.getDate() + n);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/** 「HH:MM」→ 自日历日 00:00 起的分钟数；无时刻返回 -1（排最前，整天的事优先）。 */
const toMinutes = (time: string | null): number => {
  if (!time) return -1;
  const [h, m] = time.split(":").map(Number);
  return (h || 0) * 60 + (m || 0);
};

/** 时刻是否落在 0~4 点：这些时刻属于前一个逻辑日的深夜。 */
const isEarlyTime = (time: string | null): boolean =>
  time !== null && toMinutes(time) >= 0 && toMinutes(time) < DAY_START_HOUR * 60;

/** 时刻在逻辑坐标里的分钟数：凌晨 0~4 点顺延到 24:00~27:59，与 clock().minutes 同尺。 */
const logicalMinutes = (time: string | null): number => {
  const m = toMinutes(time);
  return isEarlyTime(time) ? m + 1440 : m;
};

/** 一次性日程所属的逻辑日（次日 0~4 点的日程归前一天）；周常返回 null。 */
export function planLogicalDay(p: Plan): string | null {
  if (p.kind !== "once" || !p.date) return null;
  return isEarlyTime(p.time) ? addDays(p.date, -1) : p.date;
}

/** 周常日程所属的逻辑星期（凌晨的周常归前一天）；一次性返回 null。 */
export function planLogicalWeekday(p: Plan): number | null {
  if (p.kind !== "weekly" || p.weekday === null) return null;
  return isEarlyTime(p.time) ? (p.weekday + 6) % 7 : p.weekday;
}

const WEEKDAYS = ["周日", "周一", "周二", "周三", "周四", "周五", "周六"];

export const weekdayLabel = (w: number | null): string =>
  w === null ? "每周" : WEEKDAYS[((w % 7) + 7) % 7];

/** 逻辑今天的日期串（YYYY-MM-DD，04:00 换日）：展示、红点、过期判定都用它。 */
export const today = (at: Date = new Date()): string => clock(at).day;

/** 逻辑今天星期几（04:00 换日）：周常日程按它归属。 */
export const logicalWeekday = (at: Date = new Date()): number => clock(at).weekday;

/** 真实日历日（00:00 换日）：新建日程选日期用这把尺子，不跟着逻辑日走。 */
export function calendarToday(at: Date = new Date()): string {
  return `${at.getFullYear()}-${pad(at.getMonth() + 1)}-${pad(at.getDate())}`;
}

/** 把「逻辑日」说成人话：今天 / 明天 / 周三 / 9月20日 / 逾期 N 天。 */
export function planDateLabel(day: string, at: Date = new Date()): string {
  const today = clock(at).day;
  if (day === today) return "今天";
  if (day === addDays(today, 1)) return "明天";
  const d = new Date(`${day}T00:00:00`);
  const diff = Math.round(
    (d.getTime() - new Date(`${today}T00:00:00`).getTime()) / 86_400_000,
  );
  if (diff > 0 && diff < 7) return WEEKDAYS[d.getDay()];
  if (diff > 0) return `${d.getMonth() + 1}月${d.getDate()}日`;
  return `逾期 ${-diff} 天`;
}

/** 一次性任务按日期（升序，逾期在前）、周常任务按周一→周日排序。 */
export function sortForDisplay(plans: Plan[]): { once: Plan[]; weekly: Plan[] } {
  const once = plans
    .filter((p) => p.kind === "once")
    .sort((a, b) =>
      (a.date ?? "") === (b.date ?? "")
        ? toMinutes(a.time) - toMinutes(b.time)
        : (a.date ?? "") < (b.date ?? "")
          ? -1
          : 1,
    );
  const weekly = plans
    .filter((p) => p.kind === "weekly")
    .sort(
      (a, b) =>
        (((a.weekday ?? 0) + 6) % 7) - (((b.weekday ?? 0) + 6) % 7) ||
        toMinutes(a.time) - toMinutes(b.time),
    );
  return { once, weekly };
}

/**
 * 最近一次将要发生的日程（主页面那一行用）。
 * 按逻辑日排序：次日 0~4 点的日程归前一个逻辑日的深夜，今晚也排得进来。
 * 只看今天与以后：今天已过时刻的不再算"最近"，过期的一次性任务也不算。
 */
export function nearest(plans: Plan[], at: Date = new Date()): Occurrence | null {
  const now = clock(at);
  const all: Array<{ o: Occurrence; minutes: number }> = [];
  for (const p of plans) {
    if (p.kind === "once") {
      const day = planLogicalDay(p);
      if (!day || day < now.day) continue;
      all.push({ o: { plan: p, date: day, time: p.time }, minutes: logicalMinutes(p.time) });
    } else {
      const w = planLogicalWeekday(p);
      if (w === null) continue;
      const delta = (((w - now.weekday) % 7) + 7) % 7;
      const day = addDays(now.day, delta);
      all.push({ o: { plan: p, date: day, time: p.time }, minutes: logicalMinutes(p.time) });
    }
  }
  all.sort((a, b) =>
    a.o.date === b.o.date ? a.minutes - b.minutes : a.o.date < b.o.date ? -1 : 1,
  );
  return (
    all.find(
      ({ o, minutes }) => o.date > now.day || o.time === null || minutes >= now.minutes,
    )?.o ?? null
  );
}

/** 主页面那一行的内容：拆成三段，让「何时 / 时刻 / 内容」各自有视觉权重。 */
export interface NearestInfo {
  /** 今天 / 明天 / 周三 … */
  when: string;
  /** HH:MM，无时刻时为 null */
  time: string | null;
  text: string;
}

/** 主页面那一行的内容；无近期日程时为 null（整行隐藏，不占位置）。 */
export function nearestInfo(plans: Plan[], at: Date = new Date()): NearestInfo | null {
  const o = nearest(plans, at);
  if (!o) return null;
  return { when: planDateLabel(o.date, at), time: o.time, text: o.plan.text };
}

/**
 * 是否是「**今天还没到点**」的日程。
 *
 * 这是挂件角标与日程列表高亮共用的唯一口径：角标数就是满足这条的条数，
 * 列表里被标出来的也正是这些——两处口径若各写一套，早晚会对不上。
 * 规则：属于逻辑今天（一次性看 planLogicalDay、周常看 planLogicalWeekday），
 * 且没有时刻或逻辑时刻还没到。于是今晚 23:00 的「明天 1:30」也算今天还没到点。
 * 今后的其它日子不算：角标回答的是「今天还剩几件事」，不是待办总量。
 */
export function isPending(p: Plan, at: Date = new Date()): boolean {
  const now = clock(at);
  const belongsToToday =
    p.kind === "once"
      ? planLogicalDay(p) === now.day
      : planLogicalWeekday(p) === now.weekday;
  if (!belongsToToday) return false;
  return p.time === null || logicalMinutes(p.time) >= now.minutes;
}

/** 挂件角标数字：今天还没到点的日程条数（口径见 [`isPending`]）。 */
export function pendingCount(plans: Plan[], at: Date = new Date()): number {
  return plans.filter((p) => isPending(p, at)).length;
}

/**
 * 下一次「派生值会变」的时刻（Unix 毫秒）。
 *
 * 日程数据只由本应用改（增删即时重算），但 [`nearest`] 与 [`pendingCount`] 的结果会
 * 随时刻自然过期：今天的某条日程走过它的时刻，就不再算「最近」、也不该再计入角标；
 * 跨过 04:00 时「今天」整体前移。所以只在这两种时刻各重算一次，不必定时轮询。
 */
export function nextRefreshAt(plans: Plan[], at: Date = new Date()): number {
  const now = clock(at);
  // 逻辑日换日在 04:00：凌晨 0~4 点还没换日，下一次边界是当天 04:00。
  const boundary = new Date(at);
  boundary.setHours(DAY_START_HOUR, 0, 0, 0);
  if (boundary.getTime() <= at.getTime()) boundary.setDate(boundary.getDate() + 1);
  let next = boundary.getTime();

  for (const p of plans) {
    if (p.time === null) continue;
    const isToday =
      p.kind === "once"
        ? planLogicalDay(p) === now.day
        : planLogicalWeekday(p) === now.weekday;
    if (!isToday) continue;
    const m = logicalMinutes(p.time);
    if (m < now.minutes) continue; // 今天的这个时刻已经过去，影响已经发生过了
    // 逻辑分钟以「所属逻辑日的日历日 00:00」为基准，加回去就是真实时刻；
    // 判定用「>= 当前分钟」，所以要等这一分钟走完才翻转。
    const t = new Date(`${now.day}T00:00:00`);
    t.setMinutes(m);
    next = Math.min(next, t.getTime() + 60_000);
  }
  return next;
}

// ---- 命令（与 usage.ts 同样的薄封装）----

export const loadPlans = (): Promise<Plan[]> => invoke<Plan[]>("load_plans");

export const addPlan = (input: {
  kind: PlanKind;
  date: string | null;
  weekday: number | null;
  time: string | null;
  text: string;
}): Promise<Plan> => invoke<Plan>("add_plan", { ...input });

export const deletePlan = (id: number): Promise<void> =>
  invoke<void>("delete_plan", { id });

/** 同步「任务提醒」总开关（作用于全部日程）。 */
export const setPlanNotify = (enabled: boolean): Promise<void> =>
  invoke<void>("set_plan_notify", { enabled });
