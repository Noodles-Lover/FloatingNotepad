import { invoke } from "@tauri-apps/api/core";

/**
 * 「日程」系统标签页的固定 id：它是待办栏（分类）里的一行，与「主要」等分类并列，
 * 负数不会与自增 id 冲突，因此能安全地放进 categories 表随分类一起持久化。
 */
export const PLANS_TAB_ID = -1;

// 日程用的是真实日历日（00:00 换日）。项目里那套「凌晨 4 点换日」是给应用使用统计
// 专用（熬夜那段算前一天），日程/报时不要跟着它走——两套日界混用只会互相误判。


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

/** 展开后的具体一次：周常任务按日期展开，便于与一次性任务统一排序。 */
export interface Occurrence {
  plan: Plan;
  date: string;
  time: string | null;
}

interface Clock {
  /** 今天的日期串 */
  day: string;
  /** 今天星期几（0=周日） */
  weekday: number;
  /** 自 00:00 起已过的分钟数 */
  minutes: number;
}

const pad = (n: number) => String(n).padStart(2, "0");

/** 当前时钟（真实日历日）。 */
function clock(at: Date = new Date()): Clock {
  return {
    day: `${at.getFullYear()}-${pad(at.getMonth() + 1)}-${pad(at.getDate())}`,
    weekday: at.getDay(),
    minutes: at.getHours() * 60 + at.getMinutes(),
  };
}

/** 日期串加减天数。 */
function addDays(day: string, n: number): string {
  const d = new Date(`${day}T00:00:00`);
  d.setDate(d.getDate() + n);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/** 「HH:MM」→ 自 00:00 起的分钟数，与 `clock().minutes` 同一把尺子。 */
const toMinutes = (time: string | null): number => {
  if (!time) return -1; // 无时刻的排在最前（整天的事优先）
  const [h, m] = time.split(":").map(Number);
  return (h || 0) * 60 + (m || 0);
};

const WEEKDAYS = ["周日", "周一", "周二", "周三", "周四", "周五", "周六"];

export const weekdayLabel = (w: number | null): string =>
  w === null ? "每周" : WEEKDAYS[((w % 7) + 7) % 7];

/** 逻辑今天的日期串（YYYY-MM-DD，04:00 日界）。 */
export const today = (at: Date = new Date()): string => clock(at).day;

/** 把日期说成人话：今天 / 明天 / 周三 / 9月20日 / 逾期 N 天。 */
export function planDateLabel(date: string, at: Date = new Date()): string {
  const today = clock(at).day;
  if (date === today) return "今天";
  if (date === addDays(today, 1)) return "明天";
  const d = new Date(`${date}T00:00:00`);
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
 * 只看今天与以后：今天已过时刻的不再算"最近"，过期的一次性任务也不算。
 */
export function nearest(plans: Plan[], at: Date = new Date()): Occurrence | null {
  const now = clock(at);
  const all: Occurrence[] = [];
  for (const p of plans) {
    if (p.kind === "once") {
      if (!p.date || p.date < now.day) continue;
      all.push({ plan: p, date: p.date, time: p.time });
    } else if (p.weekday !== null) {
      const delta = (((p.weekday - now.weekday) % 7) + 7) % 7;
      all.push({ plan: p, date: addDays(now.day, delta), time: p.time });
    }
  }
  all.sort((a, b) =>
    a.date === b.date ? toMinutes(a.time) - toMinutes(b.time) : a.date < b.date ? -1 : 1,
  );
  return (
    all.find(
      (o) => o.date > now.day || o.time === null || toMinutes(o.time) >= now.minutes,
    ) ?? null
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
 * 规则：属于今天（一次性看日期、周常看星期），且没有时刻或时刻还没到。
 * 今后的其它日子不算：角标回答的是「今天还剩几件事」，不是待办总量。
 */
export function isPending(p: Plan, at: Date = new Date()): boolean {
  const now = clock(at);
  if (p.kind === "once") {
    if (p.date !== now.day) return false;
  } else if (p.weekday !== now.weekday) {
    return false;
  }
  return p.time === null || toMinutes(p.time) >= now.minutes;
}

/** 挂件角标数字：今天还没到点的日程条数（口径见 [`isPending`]）。 */
export function pendingCount(plans: Plan[], at: Date = new Date()): number {
  return plans.filter((p) => isPending(p, at)).length;
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
