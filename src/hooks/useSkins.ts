import { useCallback, useEffect, useState } from "react";
import {
  loadSkins,
  resolveSkin,
  loadSkinName,
  saveSkinName,
  type Skin,
} from "../lib/skins";
import type { WindowController } from "../lib/window";

/**
 * 皮肤：可用清单（从皮肤目录读取）+ 当前选用。
 * 变化模式（transform）对应 solidMode=true——整颗停靠、不滑出，由控制器据此决定 CSS 行为。
 */
export function useSkins(windowCtl: WindowController) {
  const [skins, setSkins] = useState<Skin[]>([]);
  const [skinName, setSkinName] = useState<string>(loadSkinName);
  const [skin, setSkin] = useState<Skin | null>(null);

  // 清单只跟皮肤目录有关，与「当前选了哪个」无关，因此只在启动加载一次
  // （依赖里带上当前皮肤名会让每次换皮肤都重跑一遍目录 IPC 与逐张图片加载）。
  useEffect(() => {
    let alive = true;
    loadSkins()
      .then((list) => {
        if (alive) setSkins(list);
      })
      .catch((e) => console.error("[loadSkins] 失败:", e));
    return () => {
      alive = false;
    };
  }, []);

  // 当前皮肤由「清单 + 选中的名字」推出，同时把 solidMode 同步给控制器。
  useEffect(() => {
    // 清单还没到：先不动（挂件此时按内置 default 渲染）。
    if (skins.length === 0) return;
    const cur = resolveSkin(skins, skinName);
    setSkin(cur);
    windowCtl.setSolidMode(cur.mode === "transform");
  }, [skins, skinName, windowCtl]);

  /** 切换皮肤：只改名字并持久化；皮肤对象、solidMode、尺寸都由上面的 effect 跟上。 */
  const selectSkin = useCallback((name: string) => {
    setSkinName(name);
    saveSkinName(name);
  }, []);

  return { skins, skin, skinName, selectSkin };
}
