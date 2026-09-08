悬浮挂件皮肤目录
================

每个子文件夹都是一个皮肤，文件夹名即皮肤名（直接展示，无需额外配置）。
本目录只存放图片素材；应用启动时自动读取 skin/ 下的子文件夹，无需手动登记。

【内置皮肤】
  default   出厂默认，滑动模式（widget.png）
  fubuki    变化模式（idle.png + hover.png）

【新增皮肤】
  1. 在 skin/ 下新建文件夹，文件夹名即皮肤名，例如 skin/fox/
  2. 按下面任一模式放入图片（文件名为硬性要求）：
       - 滑动模式：widget.png（单张，隐藏态由 CSS 滑出半掩）
       - 变化模式：idle.png（半掩态） + hover.png（伸出态）
  3. 重启应用，在面板右上角调色板图标 → 皮肤 里选择。

【注意】
  - 图片需为透明背景 PNG，会按「挂件尺寸」等比缩放。
  - 一个文件夹内既有 widget.png 又有 idle/hover 时，widget.png 优先。
  - 三者皆无的文件夹会被忽略；以 . 开头的文件夹也会被跳过。

完整规格、构图建议与故障排查见源码仓库的 docs/skins.md：
https://github.com/Noodles-Lover/FloatingNotepad
