# FloatingNotepad (交互原型)

自用桌面悬浮记事本的原型：**像 360 悬浮球一样贴边收纳，鼠标靠近自动弹出，点击展开速记面板，输入即存（SQLite 本地持久化）**。

纯交互原型，聚焦"悬浮球手感"。**暂未处理多显示器**，UI 也很朴素。

技术栈：**Tauri v2 + React + Vite + SQLite (rusqlite)**。

---

## 在本机运行（需要 Windows 开发环境）

沙箱里没有 Rust / WebView2 / MSVC，所以源码是在别处生成的，请你在本机执行：

### 1.  prerequisites
- **Node.js** ≥ 18（已装可跳过）
- **Rust 工具链**：<https://rustup.rs> 安装，选 stable
- **Visual Studio 2022 Build Tools** + 「使用 C++ 的桌面开发」工作负载（提供 MSVC 链接器，Rust 编译必需）
- **WebView2 运行时**：Win11 一般自带；没有的话从微软下载安装

### 2. 安装与启动
```powershell
cd floating-notepad
npm install
npm run tauri:dev      # 等价于 npx tauri dev
```
首次 `tauri:dev` 会编译 Rust 侧（几分钟），之后快很多。

> 想换正式图标：`npx tauri icon path/to/your-logo.png`（会覆盖 `src-tauri/icons`）。

---

## 交互说明
- 启动后球贴在**右边沿**，只露一条小边（hidden）。
- 鼠标移到右边沿附近 → 球滑出（revealed）。
- 点击球 → 展开速记面板（expanded），可输入标题/正文，**输入即自动保存**到本地 `notes.db`。
- 面板内按 `Esc` 或点右上角 `×` 收起；鼠标离开球一段时间也会自动收边。
- 下方列表可切换 / 删除历史笔记。

---

## 关键实现点
- **贴边感应**：Rust 侧 `start_mouse_watch` 用 `GetCursorPos` 每 ~100ms 轮询一次全局光标，通过 `cursor-move` 事件发给前端；前端判断"是否靠近右边沿 + 在球的纵向范围内"决定是否弹出（策略放在前端，方便你调阈值）。
- **窗口形态**：单窗口，无边框 + 透明 + 置顶（`tauri.conf.json` 的 `windows`）。hidden 状态用 CSS `translateX` 把球滑出可视区，避免移动 OS 窗口带来的抖动。
- **持久化**：`rusqlite` 在 `app_data_dir` 下建 `notes.db`，提供 `load_notes / save_note / delete_note` 三个命令。

---

## 已知限制（原型范围）
- 仅单显示器；多屏 / 热插拔未处理。
- DPI 缩放在前端用 `devicePixelRatio` 做了近似换算，高 DPI 下感应区可能有偏差，需后续用 Tauri `scaleFactor` 校正。
- 没有做"点击窗口外部自动收起"的全局点击监听（原型先用 Esc / × 关闭）。
- 图标是占位方块，正式用请替换。

---

## 目录结构
```
floating-notepad/
├─ index.html
├─ package.json
├─ vite.config.ts
├─ src/                      # React 前端
│  ├─ main.tsx
│  ├─ App.tsx                # 状态机 hidden/revealed/expanded + 鼠标感应
│  ├─ App.css
│  ├─ types.ts
│  ├─ lib/window.ts          # 贴边/弹出/展开 的窗口定位
│  ├─ lib/db.ts              # invoke 封装
│  └─ components/
│     ├─ FloatingBall.tsx
│     └─ NotePanel.tsx
└─ src-tauri/                # Rust 后端
   ├─ Cargo.toml
   ├─ tauri.conf.json
   ├─ build.rs
   ├─ icons/
   └─ src/
      ├─ main.rs
      ├─ lib.rs              # 命令 + 鼠标轮询
      └─ db.rs              # SQLite
```
