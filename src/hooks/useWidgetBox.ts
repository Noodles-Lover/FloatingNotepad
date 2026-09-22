import { useMemo } from "react";
import { widgetBoxFor } from "../lib/window";
import { defaultSkin, type Skin } from "../lib/skins";

export type WidgetBox = ReturnType<typeof widgetBoxFor>;

/**
 * 挂件容器尺寸：长边 = 配置的挂件大小，短边按素材比例收缩，宽度再加固定留白。
 * 窗口与 CSS 容器都取这一个结果——不一致就会出现「看着有但摸不到」或「摸得到但看不见」。
 */
export function useWidgetBox(widgetSize: number, skin: Skin | null): WidgetBox {
  return useMemo(
    () => widgetBoxFor(widgetSize, (skin ?? defaultSkin()).ratio),
    [widgetSize, skin],
  );
}
