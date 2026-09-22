import { useCallback, useEffect, useMemo, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import { loadPlans, nearestInfo, nextRefreshAt, pendingCount, type Plan } from "../lib/plans";

/**
 * 日程数据与派生值（最近一项、未完成条数）。
 *
 * 不做定时轮询：日程只由本应用改（增删改即时重算），真正需要重取的是
 * 「派生值随时刻过期」的边界——今天某条日程的时刻走完、以及跨过 00:00。
 */
export function usePlans() {
  const [plans, setPlans] = useState<Plan[]>([]);
  const nearest = useMemo(() => nearestInfo(plans), [plans]);
  const planCount = useMemo(() => pendingCount(plans), [plans]);

  const reload = useCallback(() => {
    loadPlans()
      .then(setPlans)
      .catch((e) => console.error("[plans] 加载失败:", e));
  }, []);

  // 启动取一次。
  useEffect(() => {
    reload();
  }, [reload]);

  // 到下一个「派生值过期」的时刻再重取。
  useEffect(() => {
    const at = new Date();
    const delay = Math.max(1_000, nextRefreshAt(plans, at) - at.getTime());
    const timer = window.setTimeout(reload, delay);
    return () => window.clearTimeout(timer);
  }, [plans, reload]);

  // 日程到点后立即同步（角标少一个、最近一项往后挪），不必等下一个边界。
  useEffect(() => {
    const pending = listen("plan-due", reload);
    return () => {
      pending.then((fn) => fn()).catch(() => {});
    };
  }, [reload]);

  // 窗口隐藏期间定时器会被 webview 节流，重新可见时补一次，别停在过期画面上。
  useEffect(() => {
    const onVisible = () => {
      if (document.visibilityState === "visible") reload();
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => document.removeEventListener("visibilitychange", onVisible);
  }, [reload]);

  return { plans, setPlans, nearest, planCount, reload };
}
