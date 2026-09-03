/**
 * 用户配置：悬浮挂件大小、笔记窗口大小、自动关闭时间。
 *
 * 优先级：localStorage 中的用户覆盖 > public/config.ini 默认值 > 代码内 DEFAULT_CONFIG。
 * - public/config.ini 是随包发布的“出厂默认”配置文件（INI 格式），用户可直接编辑。
 * - 应用内通过“设置”面板调整后写入 localStorage，无需改打包文件。
 */

export interface AppConfig {
  /** 悬浮挂件尺寸（逻辑像素）。 */
  widgetSize: number;
  /** 笔记面板宽度（逻辑像素）。 */
  windowWidth: number;
  /** 笔记面板高度（逻辑像素）。 */
  windowHeight: number;
  /** 鼠标离开 UI 多久后自动收起（毫秒）。 */
  autoCloseDelay: number;
  /** 闲置（隐藏态）时悬浮挂件的不透明度（0.1~1，1 为完全不透明）。 */
  idleOpacity: number;
  /** 面板固定：固定后不随鼠标离开自动收起，只能手动点叉关闭。 */
  pinned: boolean;
  /** 碰撞箱外扩（逻辑像素）：鼠标在笔记面板真实范围外该距离内仍视为“在内”，
   *  不会触发自动收起。默认 5px，调大可避免面板边缘附近误关闭。 */
  panelMargin: number;
}

export const DEFAULT_CONFIG: AppConfig = {
  widgetSize: 56,
  windowWidth: 380,
  windowHeight: 440,
  autoCloseDelay: 600,
  idleOpacity: 0.7,
  pinned: false,
  panelMargin: 15,
};

const LS_KEY = "floating-notepad.config";
const CONFIG_URL = "/config.ini";

/** 把 "key = value" 形式的 INI 文本解析成键值对（忽略分段标题与注释）。 */
function parseIni(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#") || line.startsWith(";")) continue; // 跳过空行与注释
    const eq = line.indexOf("=");
    if (eq === -1) continue;
    const key = line.slice(0, eq).trim();
    const val = line.slice(eq + 1).trim();
    if (key) out[key] = val;
  }
  return out;
}

/** 读取并合并配置：出厂默认 <- config.ini <- localStorage 覆盖。 */
export async function loadConfig(): Promise<AppConfig> {
  let base: AppConfig = { ...DEFAULT_CONFIG };

  // 1) 尝试读取随包发布的 config.ini（缺失则用代码默认）。
  try {
    const res = await fetch(CONFIG_URL, { cache: "no-store" });
    if (res.ok) {
      const kv = parseIni(await res.text());
      const parsed: Partial<AppConfig> = {};
      if (kv.widgetSize) parsed.widgetSize = Number(kv.widgetSize);
      if (kv.windowWidth) parsed.windowWidth = Number(kv.windowWidth);
      if (kv.windowHeight) parsed.windowHeight = Number(kv.windowHeight);
      if (kv.autoCloseDelay) parsed.autoCloseDelay = Number(kv.autoCloseDelay);
      if (kv.idleOpacity) parsed.idleOpacity = Number(kv.idleOpacity);
      if (kv.pinned) parsed.pinned = kv.pinned === "true";
      if (kv.panelMargin) parsed.panelMargin = Number(kv.panelMargin);
      base = { ...base, ...sanitize(parsed) };
    }
  } catch {
    /* 忽略：无配置文件时退回代码默认 */
  }

  // 2) 合并用户在应用内保存的覆盖。
  try {
    const raw = localStorage.getItem(LS_KEY);
    if (raw) {
      const override = sanitize(JSON.parse(raw) as Partial<AppConfig>);
      base = { ...base, ...override };
    }
  } catch {
    /* 忽略损坏的本地覆盖 */
  }

  return base;
}

/** 过滤掉非法数值，保证配置始终有效。 */
function sanitize(part: Partial<AppConfig>): Partial<AppConfig> {
  const out: Partial<AppConfig> = {};
  if (typeof part.widgetSize === "number" && part.widgetSize >= 24 && part.widgetSize <= 200)
    out.widgetSize = Math.round(part.widgetSize);
  if (typeof part.windowWidth === "number" && part.windowWidth >= 240 && part.windowWidth <= 900)
    out.windowWidth = Math.round(part.windowWidth);
  if (typeof part.windowHeight === "number" && part.windowHeight >= 200 && part.windowHeight <= 900)
    out.windowHeight = Math.round(part.windowHeight);
  if (typeof part.autoCloseDelay === "number" && part.autoCloseDelay >= 0 && part.autoCloseDelay <= 5000)
    out.autoCloseDelay = Math.round(part.autoCloseDelay);
  if (typeof part.idleOpacity === "number" && part.idleOpacity >= 0.1 && part.idleOpacity <= 1)
    out.idleOpacity = part.idleOpacity;
  if (typeof part.pinned === "boolean") out.pinned = part.pinned;
  if (typeof part.panelMargin === "number" && part.panelMargin >= 0 && part.panelMargin <= 100)
    out.panelMargin = Math.round(part.panelMargin);
  return out;
}

/** 把用户覆盖写回 localStorage（应用内“设置”面板调用，优先级最高）。 */
export function saveConfig(cfg: AppConfig): void {
  try {
    localStorage.setItem(LS_KEY, JSON.stringify(sanitize(cfg)));
  } catch {
    /* 忽略写入失败（如隐私模式） */
  }
}
