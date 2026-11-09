import { useRef, useState } from "react";
import {
  addDays,
  addPlan,
  loadPlans,
  PLAN_TEXT_MAX,
  calendarToday,
  weekdayLabel,
  type Plan,
} from "../lib/plans";
import HourWheel from "./HourWheel";

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
 * 日期/星期与时刻并排一行，内容输入独占一行；「+1 天」与整点快捷是字段组内的
 * 窄条，分别显示 `>` 与「整点」，用途由 aria-label / title 说明。整点用面板内滚轮选择。
 */
export default function PlansPanel({
  onChange,
  notify,
  onNotifyChange,
  badge,
  onBadgeChange,
  onClose,
}: Props) {
  const [date, setDate] = useState(calendarToday);
  const [dateTime, setDateTime] = useState("");
  const [dateText, setDateText] = useState("");
  const [weekday, setWeekday] = useState(1);
  const [weekTime, setWeekTime] = useState("");
  const [weekText, setWeekText] = useState("");
  const [wheel, setWheel] = useState<{
    which: "date" | "week";
    rect: DOMRect;
    panelRect: DOMRect;
  } | null>(null);
  const panelRef = useRef<HTMLDivElement>(null);

  /** 两个表单共用一个滚轮：记下触发按钮与面板的矩形，浮层据此夹在面板内。 */
  const toggleWheel = (which: "date" | "week", rect: DOMRect) => {
    const panelRect = panelRef.current?.getBoundingClientRect() ?? rect;
    setWheel((prev) => (prev?.which === which ? null : { which, rect, panelRect }));
  };

  /** 「+1 天」：每次把日期往后挪一天，多点一次就是下下天。 */
  const stepDate = () => setDate(date ? addDays(date, 1) : calendarToday());

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
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal-panel" ref={panelRef} onClick={(e) => e.stopPropagation()}>
        <div className="modal-head">
          <span>日程</span>
          <span className="modal-close" onClick={onClose} title="关闭">
            ×
          </span>
        </div>
        <div className="modal-body">
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
              <div className="plan-field-group">
                <input
                  type="date"
                  className="plan-input plan-input-date"
                  value={date}
                  onChange={(e) => setDate(e.target.value)}
                  aria-label="日期"
                />
                <button
                  className="plan-mini-btn"
                  onClick={stepDate}
                  aria-label="日期加一天"
                  title="日期加一天"
                >
                  &gt;
                </button>
              </div>
              <div className="plan-field-group">
                <input
                  type="time"
                  className="plan-input plan-input-time"
                  value={dateTime}
                  onChange={(e) => setDateTime(e.target.value)}
                  aria-label="时刻"
                  title="留空则不提醒；可直接细调到分钟"
                />
                <button
                  className="plan-hour-mini"
                  onPointerDown={(e) => e.stopPropagation()}
                  onClick={(e) => toggleWheel("date", e.currentTarget.getBoundingClientRect())}
                  aria-haspopup="listbox"
                  aria-expanded={wheel?.which === "date"}
                  aria-label="选整点"
                  title="选整点"
                >
                  整点
                </button>
              </div>
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
                aria-label="每周几"
              >
                {WEEK_OPTIONS.map((w) => (
                  <option key={w} value={w}>
                    {weekdayLabel(w)}
                  </option>
                ))}
              </select>
              <div className="plan-field-group">
                <input
                  type="time"
                  className="plan-input plan-input-time"
                  value={weekTime}
                  onChange={(e) => setWeekTime(e.target.value)}
                  aria-label="时刻"
                  title="留空则不提醒；可直接细调到分钟"
                />
                <button
                  className="plan-hour-mini"
                  onPointerDown={(e) => e.stopPropagation()}
                  onClick={(e) => toggleWheel("week", e.currentTarget.getBoundingClientRect())}
                  aria-haspopup="listbox"
                  aria-expanded={wheel?.which === "week"}
                  aria-label="选整点"
                  title="选整点"
                >
                  整点
                </button>
              </div>
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
          <div className="set-hint">
            以凌晨 4:00 换日：次日 0~4 点的日程算前一天，今晚就计入红点并显示「今天」，过了 4:00 才清理；新建选日期仍按 0 点换日。
          </div>
        </div>
        {wheel && (
          <HourWheel
            initialHour={(wheel.which === "date" ? dateTime : weekTime).slice(0, 2) || null}
            anchorRect={wheel.rect}
            panelRect={wheel.panelRect}
            onSelect={wheel.which === "date" ? setDateTime : setWeekTime}
            onClose={() => setWheel(null)}
          />
        )}
      </div>
    </div>
  );
}
