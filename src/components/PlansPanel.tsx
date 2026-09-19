import { useState } from "react";
import {
  addPlan,
  loadPlans,
  PLAN_TEXT_MAX,
  today,
  weekdayLabel,
  type Plan,
} from "../lib/plans";

interface Props {
  /** 新增成功后回调（App 统一持有日程状态，主页面那一行与角标都从它派生）。 */
  onChange: (plans: Plan[]) => void;
  /** 任务提醒总开关（作用于全部日程）。 */
  notify: boolean;
  onNotifyChange: (on: boolean) => void;
  /** 挂件上是否显示待办角标。 */
  badge: boolean;
  onBadgeChange: (on: boolean) => void;
  onClose: () => void;
}

const WEEK_OPTIONS = [1, 2, 3, 4, 5, 6, 0];

/**
 * 日程面板（面板头栏的日历按钮打开）：新增表单 + 提醒总开关。
 *
 * 新增只在这里做：主界面的「日程」标签页是系统标签页，只用来看和删除，
 * 把表单塞进去会让那块列表区域被输入控件占掉一半。
 * 日期/时刻用原生控件——值要能一眼看清，宽度给足，不做自绘的窄选择器。
 */
export default function PlansPanel({
  onChange,
  notify,
  onNotifyChange,
  badge,
  onBadgeChange,
  onClose,
}: Props) {
  const [date, setDate] = useState(today);
  const [dateTime, setDateTime] = useState("");
  const [dateText, setDateText] = useState("");
  const [weekday, setWeekday] = useState(1);
  const [weekTime, setWeekTime] = useState("");
  const [weekText, setWeekText] = useState("");

  const reload = () => {
    loadPlans()
      .then(onChange)
      .catch((e) => console.error("[plans] 加载失败:", e));
  };

  const submitOnce = () => {
    const text = dateText.trim();
    if (!text || !date) return;
    addPlan({ kind: "once", date, weekday: null, time: dateTime || null, text })
      .then(() => {
        setDateText("");
        setDateTime("");
        reload();
      })
      .catch((e) => console.error("[plans] 新增失败:", e));
  };

  const submitWeekly = () => {
    const text = weekText.trim();
    if (!text) return;
    addPlan({ kind: "weekly", date: null, weekday, time: weekTime || null, text })
      .then(() => {
        setWeekText("");
        setWeekTime("");
        reload();
      })
      .catch((e) => console.error("[plans] 新增失败:", e));
  };

  return (
    <div className="skin-overlay" onClick={onClose}>
      <div className="skin-panel" onClick={(e) => e.stopPropagation()}>
        <div className="skin-head">
          <span>日程</span>
          <span className="skin-x" onClick={onClose} title="关闭">
            ×
          </span>
        </div>
        <div className="skin-body">
          <label
            className="set-switch-row"
            title="到点时调用系统弹窗提醒；时间为空的日程不提醒"
          >
            <span className="set-label">任务提醒</span>
            <input
              type="checkbox"
              className="set-switch"
              checked={notify}
              onChange={(e) => onNotifyChange(e.target.checked)}
            />
          </label>

          <label className="set-switch-row" title="在挂件上显示还没到点的任务条数">
            <span className="set-label">挂件角标</span>
            <input
              type="checkbox"
              className="set-switch"
              checked={badge}
              onChange={(e) => onBadgeChange(e.target.checked)}
            />
          </label>

          <div className="plan-form">
            <div className="plan-form-head">某一天</div>
            <div className="plan-form-row">
              <input
                type="date"
                className="plan-input plan-input-date"
                value={date}
                onChange={(e) => setDate(e.target.value)}
              />
              <input
                type="time"
                className="plan-input plan-input-time"
                value={dateTime}
                onChange={(e) => setDateTime(e.target.value)}
                title="留空则不提醒"
              />
            </div>
            <div className="plan-form-row">
              <input
                className="plan-input plan-input-text"
                value={dateText}
                placeholder={`要做什么（最多 ${PLAN_TEXT_MAX} 字）`}
                maxLength={PLAN_TEXT_MAX}
                onChange={(e) => setDateText(e.target.value)}
                onKeyDown={(e) => e.key === "Enter" && submitOnce()}
              />
              <button className="plan-submit" onClick={submitOnce}>
                添加
              </button>
            </div>
          </div>

          <div className="plan-form">
            <div className="plan-form-head">每周</div>
            <div className="plan-form-row">
              <select
                className="plan-input plan-input-week"
                value={weekday}
                onChange={(e) => setWeekday(Number(e.target.value))}
              >
                {WEEK_OPTIONS.map((w) => (
                  <option key={w} value={w}>
                    {weekdayLabel(w)}
                  </option>
                ))}
              </select>
              <input
                type="time"
                className="plan-input plan-input-time"
                value={weekTime}
                onChange={(e) => setWeekTime(e.target.value)}
                title="留空则不提醒"
              />
            </div>
            <div className="plan-form-row">
              <input
                className="plan-input plan-input-text"
                value={weekText}
                placeholder={`要做什么（最多 ${PLAN_TEXT_MAX} 字）`}
                maxLength={PLAN_TEXT_MAX}
                onChange={(e) => setWeekText(e.target.value)}
                onKeyDown={(e) => e.key === "Enter" && submitWeekly()}
              />
              <button className="plan-submit" onClick={submitWeekly}>
                添加
              </button>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
