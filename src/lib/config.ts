/**
 * 用户配置：悬浮挂件大小、笔记窗口大小、自动关闭时间。
 *
 * 出厂默认值集中在 DEFAULT_CONFIG，用户通过“设置”面板调整后覆盖进 localStorage。
 */

export interface AppConfig {
  /** 悬浮挂件尺寸（逻辑像素）。 */
  widgetSize: number;
  /** 笔记面板宽度（逻辑像素）。 */
  windowWidth: number;
  /** 笔记面板高度（逻辑像素）。对应 .content（速记文本域）的固定高度 120px，
   *  调整其中之一时需确认另一处是否仍协调。 */
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
  widgetSize: 80,
  windowWidth: 380,
  windowHeight: 520,
  autoCloseDelay: 500,
  idleOpacity: 0.6,
  pinned: false,
  panelMargin: 15,
};

const LS_KEY = "floating-notepad.config";

/** 读取配置：出厂默认 <- localStorage 里的用户覆盖。 */
export function loadConfig(): AppConfig {
  // 合并用户在应用内保存的覆盖。
  try {
    const raw = localStorage.getItem(LS_KEY);
    if (raw) {
      const override = sanitize(JSON.parse(raw) as Partial<AppConfig>);
      return { ...DEFAULT_CONFIG, ...override };
    }
  } catch {
    /* 忽略损坏的本地覆盖 */
  }
  return { ...DEFAULT_CONFIG };
}

/** 过滤掉非法数值，保证配置始终有效。 */
function sanitize(part: Partial<AppConfig>): Partial<AppConfig> {
  const out: Partial<AppConfig> = {};
  if (typeof part.widgetSize === "number" && part.widgetSize >= 30 && part.widgetSize <= 300)
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
