export interface Todo {
  id: string;
  text: string;
  done: boolean;
  priority: number; // 1-10，默认 5；越高越靠前（完成项沉底）
  note: string; // 备注
}

/** 一个速记标签页：独立标题与文本，永久存储（待办已解耦到分类）。 */
export interface Tab {
  id: number;
  title: string;
  note: string;
}

/** 一个待办分类：独立标题与任务列表，永久存储。默认分类名为“主要”。 */
export interface Category {
  id: number;
  title: string;
  todos: Todo[];
}

