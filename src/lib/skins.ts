/**
 * 皮肤（材质包）系统。
 *
 * 物理结构：public/skin/<name>/ 下每个文件夹是一个材质包，文件夹名即材质名。
 * 前端无法列目录，故由 Rust 命令 list_skins 读取文件夹名；随后对每个文件夹用
 * <img> 加载约定文件名下的图片，按硬性约定判定模式，同时取得素材宽高比：
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
  ratio: number;
}

/** 变化模式：idle（半掩）+ hover（伸出）两张图。 */
export interface TransformSkin {
  name: string;
  mode: "transform";
  idle: string;
  hover: string;
  ratio: number;
}

/**
 * 皮肤（材质包）。`ratio` 是素材宽高比（宽/高）——挂件容器与窗口按它收缩到图片实际大小；
 * 容器比图片大出的那一圈会成为「幽灵碰撞箱」（见 `lib/window.ts` 的 `widgetBoxFor`）。
 */
export type Skin = SlideSkin | TransformSkin;

/** 默认皮肤名（缺少或无效时回落）。 */
export const DEFAULT_SKIN_NAME = "default";

/** 内置 default 皮肤对象（缺少任何皮肤或解析失败时的兜底）。 */
export function defaultSkin(): Skin {
  return {
    name: DEFAULT_SKIN_NAME,
    mode: "slide",
    widget: `/skin/${DEFAULT_SKIN_NAME}/widget.png`,
    // 兜底比例：正常路径下比例是加载图片量出来的，这里只在素材整个加载失败时顶着用。
    ratio: 1,
  };
}

/**
 * 探测某个素材 URL：能解码成图片时返回其宽高比（宽/高），不存在或不是图片返回 null。
 *
 * 用 `<img>` 而不是 `fetch(HEAD)`：dev 服务器（Vite）对不存在的 .png 会回退返回
 * index.html（200 + text/html），只看状态码会误判文件存在；`<img>` 解码失败即报错，
 * 天然把 HTML 兜底挡掉。顺带量出宽高比——容器要按它收缩，光知道「存在」不够。
 */
function probeImage(url: string): Promise<number | null> {
  return new Promise((resolve) => {
    const img = new Image();
    img.onload = () =>
      resolve(
        img.naturalWidth > 0 && img.naturalHeight > 0 ? img.naturalWidth / img.naturalHeight : null,
      );
    img.onerror = () => resolve(null);
    img.src = url;
  });
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
    const [widget, idle, hover] = await Promise.all([
      probeImage(`${dir}/widget.png`),
      probeImage(`${dir}/idle.png`),
      probeImage(`${dir}/hover.png`),
    ]);
    if (widget !== null) {
      skins.push({ name, mode: "slide", widget: `${dir}/widget.png`, ratio: widget });
    } else if (idle !== null && hover !== null) {
      // 变化模式以 idle 图定容器尺寸：它是「基准」那张（两张画布尺寸不一定相同）。
      skins.push({ name, mode: "transform", idle: `${dir}/idle.png`, hover: `${dir}/hover.png`, ratio: idle });
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
