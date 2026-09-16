import {
  deletePlan,
  isPending,
  loadPlans,
  planDateLabel,
  sortForDisplay,
  today,
  weekdayLabel,
  type Plan,
} from "../lib/plans";
import "./PlansView.css";

interface Props {
  /** 全部日程（一次性与周常混在一起，这里按类型分组展示）。 */
  plans: Plan[];
  /** 数据变化后回调（由 App 统一持有状态）。 */
  onChange: (plans: Plan[]) => void;
}

/**
 * 日程展示：待办栏里的「日程」系统标签页选中时显示。
 *
 * 只负责看与删：新增在顶部按钮打开的面板里，主界面保持干净。
 * 一次性任务按「今天 / 明天 / 周三」这样的说法显示日期，比 09-16 好读。
 * 今天还没到点的会标出来（`isPending`，与挂件角标同一口径），今天已过时刻的淡显——
 * 它们还在，只是不用再盯着看了。
 */
export default function PlansView({ plans, onChange }: Props) {
  const { once, weekly } = sortForDisplay(plans);
  const now = new Date();
  const day = today(now);

  const remove = (id: number) => {
    deletePlan(id)
      .then(() =>
        loadPlans()
          .then(onChange)
          .catch((e) => console.error("[plans] 加载失败:", e)),
      )
      .catch((e) => console.error("[plans] 删除失败:", e));
  };

  /** 今天已经过了时刻（判定与 `isPending` 互补，两边用同一套时间基准）。 */
  const isPastToday = (p: Plan, pending: boolean) =>
    !pending && (p.kind === "once" ? p.date === day : p.weekday === now.getDay());

  const rows = (list: Plan[], kind: "once" | "weekly") =>
    list.map((p) => {
      const pending = isPending(p, now);
      const state = pending ? "pending" : isPastToday(p, pending) ? "past" : "later";
      return (
        <div className={`plan-row ${state}`} key={p.id}>
          <span className={`plan-pill ${p.time ? "" : "allday"}`}>{p.time ?? "全天"}</span>
          <span className="plan-when">
            {kind === "once" ? planDateLabel(p.date ?? "", now) : weekdayLabel(p.weekday)}
          </span>
          <span className="plan-text" title={p.text}>
            {p.text}
          </span>
          <button className="plan-del" onClick={() => remove(p.id)} title="删除">
            ×
          </button>
        </div>
      );
    });

  return (
    <div className="plans">
      <div className="plan-group">
        <div className="plan-group-head">
          <span>按日期</span>
          {once.length > 0 && <span className="plan-count">{once.length}</span>}
        </div>
        {once.length === 0 ? <div className="plan-empty">还没有</div> : rows(once, "once")}
      </div>

      <div className="plan-group">
        <div className="plan-group-head">
          <span>每周</span>
          {weekly.length > 0 && <span className="plan-count">{weekly.length}</span>}
        </div>
        {weekly.length === 0 ? <div className="plan-empty">还没有</div> : rows(weekly, "weekly")}
      </div>
    </div>
  );
}
