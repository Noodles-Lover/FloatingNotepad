import { invoke } from "@tauri-apps/api/core";
import { Tab, Todo } from "../types";

/** 后端返回的标签页（todos 为 JSON 字符串），前端不直接持有此结构。 */
interface RawTab {
  id: number;
  title: string;
  content: string;
  todos: string;
  position: number;
}

interface RawState {
  tabs: RawTab[];
  active_tab_id: number;
}

interface RawTabInput {
  id: number;
  title: string;
  content: string;
  todos: string;
}

const parseTodos = (raw: string): Todo[] => {
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
};

/** 加载全部速记标签页与当前激活的标签页 id（永久存储）。 */
export const loadState = async (): Promise<{ tabs: Tab[]; activeTabId: number }> => {
  const raw = await invoke<RawState>("load_tabs");
  const tabs: Tab[] = raw.tabs.map((t) => ({
    id: t.id,
    title: t.title,
    note: t.content,
    todos: parseTodos(t.todos),
  }));
  return { tabs, activeTabId: raw.active_tab_id };
};

/** 把全部标签页写回（覆盖式保存，永久存储）。 */
export const saveTabs = async (tabs: Tab[]): Promise<void> => {
  const payload: RawTabInput[] = tabs.map((t) => ({
    id: t.id,
    title: t.title,
    content: t.note,
    todos: JSON.stringify(t.todos),
  }));
  await invoke<void>("save_tabs", { tabs: payload });
};

/** 持久化当前激活的标签页 id。 */
export const setActiveTab = (tabId: number): Promise<void> =>
  invoke<void>("set_active_tab", { tabId });
