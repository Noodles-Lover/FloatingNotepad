/**
 * 添加快捷文件成功的唯一反馈出口。
 *
 * 添加有两个触发入口（应用级拖放、快捷栏的 + 按钮），两者都只调这里：
 * 提示音只播一次，新增条目的动画由事件把路径带给可能已挂载的 Dock。
 * 不在两个入口各写一套，避免漏掉其中一条路径。
 */
import { sounds } from "./sounds";
import type { LauncherItem } from "./launchers";

export interface LauncherAddedDetail {
  /** 本次真正添加成功的路径，用于只给新条目播动画。 */
  paths: string[];
  /** 最后一次 add 返回的完整列表，Dock 直接采用，不再多一次 invoke。 */
  items: LauncherItem[];
}

/** 播一次提示音 + 广播添加结果。全部失败时不给「成功」反馈。 */
export function reportLauncherAdded(paths: string[], items: LauncherItem[]): void {
  if (paths.length === 0) return;
  sounds.play("notification");
  window.dispatchEvent(
    new CustomEvent<LauncherAddedDetail>("launcher-added", {
      detail: { paths, items },
    }),
  );
}
