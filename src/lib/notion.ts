import { invoke } from "@tauri-apps/api/core";

/**
 * Notion 同步的调用层。
 *
 * 同步逻辑、映射表与密钥都在 Rust 侧（见 src-tauri/src/notion.rs），
 * 这里只负责把命令转成一个个函数，界面不关心 HTTP 与签名比对的细节。
 */

/** Notion 同步配置（Rust 存在本机 meta 表里，不会离开这台机器）。 */
export interface NotionConfig {
  token: string;
  parent_page_id: string;
  db_notes: string;
  db_todos: string;
  db_plans: string;
}

/** 一轮同步的结果。 */
export interface SyncSummary {
  /** 本地改动推到 Notion。 */
  pushed: number;
  /** Notion 改动拉回本地。 */
  pulled: number;
  /** 一边删除导致另一边跟着删除。 */
  deleted: number;
  /** 两边都改过（v1 以本地为准）。 */
  conflicts: number;
}

export function getNotionConfig(): Promise<NotionConfig> {
  return invoke<NotionConfig>("notion_get_config");
}

export function setNotionConfig(token: string, parentPageId: string): Promise<void> {
  // 注意：Tauri v2 会把命令参数名转成 camelCase，前端必须写 parentPageId。
  return invoke<void>("notion_set_config", { token, parentPageId });
}

/** 在容器页下建齐三个数据库；已建过的会跳过。 */
export function setupNotion(): Promise<NotionConfig> {
  return invoke<NotionConfig>("notion_setup");
}

/** 跑一轮同步（async 命令，不卡界面）。 */
export function syncNotion(): Promise<SyncSummary> {
  return invoke<SyncSummary>("notion_sync");
}

/** 归档三个库的全部页面并清空映射表（映射状态损坏后的重建入口）。 */
export function resetNotionSync(): Promise<number> {
  return invoke<number>("notion_reset");
}

/** 三个数据库都已就绪时才能同步。 */
export function isReady(cfg: NotionConfig): boolean {
  return cfg.token !== "" && cfg.db_notes !== "" && cfg.db_todos !== "" && cfg.db_plans !== "";
}
