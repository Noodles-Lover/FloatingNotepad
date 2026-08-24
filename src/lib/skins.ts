/**
 * 皮肤（材质包）系统。
 *
 * 物理结构：public/skin/<name>/ 下每个文件夹是一个材质包，文件夹名即材质名。
 * 前端无法列目录，故由 Rust 命令 list_skins 读取文件夹名；随后对每个文件夹用
 * fetch(HEAD) 探测图片文件名，按硬性约定判定模式：
 *   - 滑动模式：存在 widget.png 单张（整颗停靠，用 CSS 滑出半掩）
 *   - 变化模式：同时存在 idle.png（半掩）+ hover.png（伸出）两张
 * 文件名即为路径，不做额外映射；既无 widget 也无 idle/hover 的文件夹会被忽略。
 */

import { invoke } from "@tauri-apps/api/core";

/** 滑动模式：widget.png 单张，整颗停靠，用 CSS 滑出半掩。 */
export interface SlideSkin {
  name: string;
  mode: "slide";
  widget: string;
}

/** 变化模式：idle（半掩）+ hover（伸出）两张图。 */
export interface TransformSkin {
  name: string;
  mode: "transform";
  idle: string;
  hover: string;
}

export type Skin = SlideSkin | TransformSkin;

/** 默认皮肤名（缺少或无效时回落）。 */
export const DEFAULT_SKIN_NAME = "default";

/** 内置 default 皮肤对象（缺少任何皮肤或解析失败时的兜底）。 */
export function defaultSkin(): Skin {
  return {
    name: DEFAULT_SKIN_NAME,
    mode: "slide",
    widget: `/skin/${DEFAULT_SKIN_NAME}/widget.png`,
  };
}

/**
 * 探测某个素材 URL 是否存在且为图片。
 * 注意：dev 服务器（Vite）对不存在的 .png 可能回退返回 index.html（200 + text/html），
 * 故仅看 r.ok 不够，必须额外校验 content-type 以跳过 HTML 兜底，避免误判文件存在。
 */
async function exists(url: string): Promise<boolean> {
  try {
    const r = await fetch(url, { method: "HEAD", cache: "no-store" });
    return r.ok && (r.headers.get("content-type") || "").startsWith("image/");
  } catch {
    return false;
  }
}

/**
 * 自动加载皮肤：先问 Rust 拿到皮肤文件夹名列表，再逐个探测图片文件判定模式。
 * 任何失败都回落到内置 default，保证应用不会因缺皮肤而崩。
 */
export async function loadSkins(): Promise<Skin[]> {
  let names: string[] = [];
  try {
    names = await invoke<string[]>("list_skins");
  } catch (e) {
    console.error("[list_skins] 失败:", e);
    names = [DEFAULT_SKIN_NAME];
  }

  const skins: Skin[] = [];
  for (const name of names) {
    const dir = `/skin/${name}`;
    const [hasWidget, hasIdle, hasHover] = await Promise.all([
      exists(`${dir}/widget.png`),
      exists(`${dir}/idle.png`),
      exists(`${dir}/hover.png`),
    ]);
    if (hasWidget) {
      skins.push({ name, mode: "slide", widget: `${dir}/widget.png` });
    } else if (hasIdle && hasHover) {
      skins.push({ name, mode: "transform", idle: `${dir}/idle.png`, hover: `${dir}/hover.png` });
    }
    // 都不存在：忽略这个文件夹。
  }

  if (skins.length === 0) {
    skins.push(defaultSkin());
  }
  return skins;
}

/** 按名取皮肤；找不到时回落到列表第一项（或内置 default）。 */
export function resolveSkin(skins: Skin[], name: string): Skin {
  return skins.find((s) => s.name === name) ?? skins[0] ?? defaultSkin();
}

/** 皮肤选择的 localStorage key（独立于 config，永久保存）。 */
const SKIN_LS_KEY = "floating-notepad.skin";

/** 读取上次选择的皮肤名；未设置或读取失败则返回 default。 */
export function loadSkinName(): string {
  try {
    return localStorage.getItem(SKIN_LS_KEY) || DEFAULT_SKIN_NAME;
  } catch {
    return DEFAULT_SKIN_NAME;
  }
}

/** 持久化皮肤选择（永久保存，跨会话保留）。 */
export function saveSkinName(name: string): void {
  try {
    localStorage.setItem(SKIN_LS_KEY, name);
  } catch {
    /* 忽略：隐私模式下可能写入失败 */
  }
}
