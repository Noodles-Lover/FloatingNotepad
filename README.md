# FloatingNotepad

自用桌面悬浮记事本：**像 360 悬浮挂件一样贴边收纳，鼠标靠近自动弹出，点击展开速记面板，输入即存（SQLite 本地持久化）**。

技术栈：**Tauri v2 + React + Vite + SQLite (rusqlite) + Win32 API**。

---

## 功能特性

- **贴边悬浮挂件**：启动后贴右沿只露一条边，鼠标靠近自动滑出，离开自动收起。
- **速记面板**：多标签页速记（单击切换、双击重命名、拖拽排序、`+` 新增），输入即存。
- **待办管理**：多分类待办，支持优先级、完成态、备注；完成项自动沉底。
- **穿透模式**：挂件只剩视觉效果，点击完全穿透到后方内容、不抢焦点，适合全屏/多窗口场景。
- **皮肤系统**：`public/skin/` 下每个文件夹即一套皮肤，自动发现；支持「滑动」与「变化」两种渲染模式。
- **设置面板**：挂件尺寸、面板宽高、自动收起延时、闲置不透明度等，即时生效并本地保存。
- **系统托盘**：显示/隐藏挂件、切换穿透模式（勾选同步）、退出。
- **挂件右键菜单**：隐藏挂件、切换穿透模式、退出。
- **多显示器**：窗口定位基于当前显示器真实尺寸计算，多屏/热插拔场景不跑出屏幕。

---

## 本机运行（需要 Windows 开发环境）

### 前置依赖
- **Node.js** ≥ 18
- **Rust 工具链**：<https://rustup.rs> 安装，选 stable
- **Visual Studio 2022 Build Tools** + 「使用 C++ 的桌面开发」工作负载（提供 MSVC 链接器）
- **WebView2 运行时**：Win11 一般自带；没有则从微软下载安装

### 安装与启动
```powershell
cd floating-notepad
npm install
npm run tauri:dev      # 等价于 npx tauri dev
```
首次 `tauri:dev` 会编译 Rust 侧（几分钟），之后快很多。

> 换正式图标：`npx tauri icon path/to/your-logo.png`（会覆盖 `src-tauri/icons`）。

---

## 交互说明

- 启动后挂件贴在**右边沿**，只露一条小边（hidden）。
- 鼠标移到右边沿附近 → 挂件滑出（revealed）。
- 点击挂件 → 展开速记面板（expanded），可输入正文与待办，**输入即自动保存**。
- 面板内按 `Esc` 或点右上角 `×` 收起；鼠标离开一段时间自动收边。
- 挂件上**右键**弹出菜单：隐藏挂件 / 切换穿透模式 / 退出。
- 右下角系统托盘：显示挂件 / 隐藏挂件 / 切换穿透模式（勾选状态与右键菜单实时同步）/ 退出。

---

## 穿透模式

开启后挂件窗口被设为**完全穿透**：鼠标点击不会落在挂件上，也不会把焦点切给本应用，挂件像不存在一样只保留视觉效果，后方窗口可正常操作。状态由 Rust 侧统一管理（托盘与右键两条入口共用一套逻辑），开启/关闭通过事件广播到前端，前端据此切换渲染状态。

实现要点见 [`src-tauri/LOGIC.md`](src-tauri/LOGIC.md)。

---

## 目录结构

```
floating-notepad/
├─ index.html
├─ package.json
├─ vite.config.ts
├─ public/
│  ├─ config.ini           # 出厂默认配置
│  └─ skin/                # 皮肤目录（每子目录一套皮肤）
├─ src/                    # React 前端
│  ├─ main.tsx
│  ├─ App.tsx              # 状态机 hidden/revealed/expanded + 穿透模式协调
│  ├─ App.css
│  ├─ types.ts
│  ├─ lib/
│  │  ├─ window.ts         # 窗口定位/贴边/拖动控制器
│  │  ├─ noteWindow.ts     # 面板展开/收起的窗口定位
│  │  ├─ proximity.ts      # 鼠标感应（订阅 Rust 光标轮询）
│  │  ├─ config.ts         # 配置加载（localStorage > config.ini > 默认值）
│  │  ├─ skins.ts          # 皮肤发现与选择
│  │  ├─ db.ts             # 数据 invoke 封装（标签页/分类）
│  │  ├─ list.ts           # 列表纯函数（重排）
│  │  ├─ screen.ts         # 显示器尺寸读取（窗口控制器共用）
│  │  └─ useEntityList.ts  # 实体列表状态管理 hook（标签页/分类共用）
│  ├─ components/
│  │  ├─ FloatingWidget.tsx  # 挂件（点击/拖动/右键）
│  │  ├─ NotePanel.tsx       # 速记面板
│  │  ├─ TabBar.tsx          # 标签页栏（切换/重命名/拖拽排序）
│  │  ├─ SkinPanel.tsx       # 皮肤选择
│  │  ├─ SettingsPanel.tsx   # 设置
│  │  └─ ConfirmDialog.tsx   # 通用确认框
│  └─ LOGIC.md             # 前端核心逻辑说明
└─ src-tauri/              # Rust 后端
   ├─ Cargo.toml
   ├─ tauri.conf.json
   ├─ build.rs
   ├─ icons/               # 应用图标（由 tauri icon 生成）
   ├─ capabilities/        # 前端能力权限
   ├─ permissions/         # 自定义命令权限
   ├─ src/
   │  ├─ main.rs
   │  ├─ lib.rs            # 命令 + 穿透模式 + 鼠标轮询 + 系统托盘
   │  └─ db.rs             # SQLite
   └─ LOGIC.md             # 后端核心逻辑说明
```

---

## 核心逻辑文档

- 前端：状态机、窗口控制器、鼠标感应、配置/皮肤/数据流 → [`src/LOGIC.md`](src/LOGIC.md)
- 后端：穿透模式、鼠标轮询、系统托盘、数据库、权限 → [`src-tauri/LOGIC.md`](src-tauri/LOGIC.md)
