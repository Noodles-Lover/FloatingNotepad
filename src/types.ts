/** 单条 to-do 任务。 */
export interface Todo {
  id: string; // 前端生成的唯一 id（保存时序列化为 JSON）
  text: string; // 任务内容
  done: boolean; // 是否完成
}

/**
 * 应用只维护一份笔记文档：一段自由文本 + 一组 to-do 任务。
 * 固定使用 id = 1 存储，启动时恢复。
 */
export interface Note {
  id: number;
  content: string; // 文本域内容
  todos: Todo[]; // to-do 列表
  created_at: number;
  updated_at: number;
}
