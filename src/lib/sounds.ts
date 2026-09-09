/** 音效播放：模块加载即预载全部音频，切换瞬间零延迟。 */

type SoundName = "lock" | "unlock" | "paperOpen" | "paperClose";

const FILES: Record<SoundName, string> = {
  lock: "/audio/lock.mp3",
  unlock: "/audio/unlock.mp3",
  paperOpen: "/audio/paper-open.mp3",
  paperClose: "/audio/paper-close.mp3",
};

function create(name: SoundName): HTMLAudioElement {
  const a = new Audio(FILES[name]);
  a.preload = "auto";
  return a;
}

const pool = new Map<SoundName, HTMLAudioElement>(
  (Object.keys(FILES) as SoundName[]).map((n) => [n, create(n)]),
);

let muted = false;

/** 设置静音状态（设置面板控制）。 */
export function setMuted(value: boolean): void {
  muted = value;
}

/**
 * 播放音效；同一种正在播时从头重放（快速切换表现为最新一次）。
 * 静音判断集中在这里，各调用点无需各自判断。
 */
export function playSound(name: SoundName): void {
  if (muted) return;
  const a = pool.get(name);
  if (!a) return;
  a.currentTime = 0;
  a.play().catch(() => {
    /* 未交互时浏览器可能阻止播放，忽略 */
  });
}
