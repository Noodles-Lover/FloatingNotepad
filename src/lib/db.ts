import { invoke } from "@tauri-apps/api/core";
import { Category, Tab, Todo } from "../types";

/** 后端返回的标签页，前端不直接持有此结构。 */
interface RawTab {
  id: number;
  title: string;
  content: string;
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
}

/** 后端返回的待办分类，前端不直接持有此结构。 */
interface RawCategory {
  id: number;
  title: string;
  todos: string;
  position: number;
}

interface RawCategoryState {
  categories: RawCategory[];
  active_category_id: number;
}

interface RawCategoryInput {
  id: number;
  title: string;
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
  }));
  return { tabs, activeTabId: raw.active_tab_id };
};

/** 把全部标签页写回（覆盖式保存，永久存储）。 */
export const saveTabs = async (tabs: Tab[]): Promise<void> => {
  const payload: RawTabInput[] = tabs.map((t) => ({
    id: t.id,
    title: t.title,
    content: t.note,
  }));
  await invoke<void>("save_tabs", { tabs: payload });
};

/** 持久化当前激活的标签页 id。 */
export const setActiveTab = (tabId: number): Promise<void> =>
  invoke<void>("set_active_tab", { tabId });

/** 加载全部待办分类与当前激活的分类 id（永久存储）。 */
export const loadCategories = async (): Promise<{
  categories: Category[];
  activeCategoryId: number;
}> => {
  const raw = await invoke<RawCategoryState>("load_categories");
  const categories: Category[] = raw.categories.map((c) => ({
    id: c.id,
    title: c.title,
    todos: parseTodos(c.todos),
  }));
  return { categories, activeCategoryId: raw.active_category_id };
};

/** 把全部待办分类写回（覆盖式保存，永久存储）。 */
export const saveCategories = async (categories: Category[]): Promise<void> => {
  const payload: RawCategoryInput[] = categories.map((c) => ({
    id: c.id,
    title: c.title,
    todos: JSON.stringify(c.todos),
  }));
  await invoke<void>("save_categories", { categories: payload });
};

/** 持久化当前激活的待办分类 id。 */
export const setActiveCategory = (categoryId: number): Promise<void> =>
  invoke<void>("set_active_category", { categoryId });
