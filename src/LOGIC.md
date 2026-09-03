# 前端核心逻辑（src）

本文件描述 `src/` 下 React 侧的核心实现，作为阅读 `App.tsx` 与 `src/lib/` 的导航。内容描述代码现状，不含历史改动叙事。

---

## 1. 窗口形态状态机

`App.tsx` 维护三种形态（mode）：

| 形态 | 含义 | 触发 |
| --- | --- | --- |
| `hidden` | 挂件贴边收窄，只露一条边 | 启动 / 鼠标离开后超时 / 手动隐藏 |
| `revealed` | 挂件滑出完整可见 | 鼠标接近贴边区 / 托盘显示 |
| `expanded` | 展开为速记面板 | 点击挂件 |

窗口的渲染形态由 `main.tsx` 按 Tauri 窗口 label 分流：label 为 `widget-lock` 时渲染解锁按钮（`LockView`），否则渲染主应用 `App`。锁窗口与主应用共用同一份前端入口与样式。

窗口交互形态由两个职责分离的控制器负责：

- **`WindowController`**（`src/lib/window.ts`）：悬浮挂件形态。负责贴边（left/right）、垂直位置、拖动、停靠、碰撞箱外扩、`dockHidden()` / `showWidget()` 等窗口定位。
- **`NoteWindow`**（`src/lib/noteWindow.ts`）：速记面板形态。负责 `expand(dockEdge, dockY)`（紧贴停靠侧向外弹出、垂直中心对齐挂件、与屏幕边沿留 `MARGIN`）、`collapse()`（还原回挂件隐藏态，经注入的 `windowCtl.dockHidden()`）、`bounds()`（读窗口真实 outerPosition/outerSize 换算逻辑像素，供 proximity 判定鼠标是否在面板内）。

`WindowController` 与 `NoteWindow` 的 `refreshScreen()` 共用 `src/lib/screen.ts` 的 `readMonitorScreen()`（读 `currentMonitor()` 的真实尺寸转逻辑像素）覆盖内部 `screen`，避免窗口被放到屏幕外——多显示器/热插拔场景由这层保证。

---

## 2. 鼠标感应（ProximitySensor）

`src/lib/proximity.ts` 订阅 Rust 广播的 `cursor-move` 事件，把物理像素除以 `devicePixelRatio` 换算为逻辑像素后回调 App。

App 端判定**始终基于 UI 当前真实 bounds**：

- 挂件形态：根据挂件贴边位置判定接近。碰撞箱外扩 `panelMargin` **只对面板生效**——挂件外扩会形成一圈「幽灵区」，鼠标停在区内既判定为内部、又不触发 DOM `mouseleave`，导致挂件收不回去。
- 面板形态：用 `NoteWindow.bounds()` 的真实矩形判定鼠标是否仍在面板内，超时（`autoCloseDelay`）后自动收起。
- 穿透模式：proximity 直接早退，挂件不因鼠标接近产生任何反应；解锁按钮的显隐改由 Rust 在光标轮询中判定（见第 3 节）。

---

## 3. 穿透模式的前端侧（与 Rust 协同）

前端不维护穿透状态的第二个副本，状态唯一来源是 Rust 的 `passthrough-state` 广播：

- **切换入口**：`setPassthrough(on)` 只调 `invoke("toggle_passthrough")`，不做本地状态翻转（Rust 统一执行样式与状态）。托盘、挂件右键、解锁按钮三条入口共用该命令。
- **显示同步**：`listen<boolean>("passthrough-state")` 驱动：
  - 开启：`showOnly()` + `setMode("hidden")`，并清理定时器与收起动画态，避免半途状态残留。
  - 关闭：`showApp()` + `setMode("hidden")`，回到半掩待命态。
- **样式**：`FloatingWidget` 的 class 列表追加 `passthrough`，`App.css` 定义 `.widget-wrap.passthrough` 强制 idle 图、隐藏 hover 图，穿透时挂件恒为「闲置图」静态展示。
- **右键菜单**：挂件右键菜单含「穿透模式」与「退出」两项，分别 `invoke("toggle_passthrough")` 与 `invoke("quit_app")`，均与托盘共用 Rust 侧同一实现。

### 穿透期间的解锁按钮

主窗口穿透时对系统整体穿透，其 webview 收不到任何鼠标事件，因此解锁按钮由**独立的锁窗口**承载（`LockView`），且该窗口自身不穿透。

- hover 检测与显隐**完全由 Rust 完成**（见 `src-tauri/LOGIC.md`）：穿透时主窗口被 `EnableWindow(FALSE)` 禁用，其 webview 内的 JS 不保证继续推进，前端无法可靠判断鼠标位置。
- 前端只负责一件事：`syncLockDelay()` 在配置加载与设置变更时把 `autoCloseDelay` 同步给 Rust（`invoke("set_lock_hide_delay")`），使解锁按钮的自动隐藏与挂件收起保持同一节奏。

---

## 4. 配置（config.ts）

优先级：**localStorage 用户覆盖 > public/config.ini 出厂默认 > 代码内 `DEFAULT_CONFIG`**。

- `loadConfig()`：先 fetch `/config.ini`（`cache: "no-store"`）解析 INI 键值（跳过注释/空行），再合并 localStorage 覆盖，每层都过 `sanitize`（数值范围过滤，非法值丢弃）。
- `saveConfig(cfg)`：应用内「设置」面板调整后写 localStorage（最高优先级，无需改打包文件）。
- 配置项：`widgetSize`、`windowWidth`、`windowHeight`、`autoCloseDelay`、`idleOpacity`、`pinned`（面板固定）、`panelMargin`（面板碰撞箱外扩）。

> 穿透状态是 Rust 维护的运行时态，由 `passthrough-state` 广播驱动，前端只同步显示、不自行持久化（见第 3 节）。

**皮肤名**单独存在 `localStorage["floating-notepad.skin"]`（见第 5 节），不混在配置对象里。

---

## 5. 皮肤系统（skins.ts）

- **物理结构**：`public/skin/<name>/` 每个文件夹一套皮肤，文件夹名即皮肤名。
- **发现**：前端不能列目录，先 `invoke("list_skins")` 拿文件夹名列表，再逐文件夹 `fetch(HEAD)` 探测图片并校验 `content-type` 以跳过 Vite dev 下「404 回退 index.html」的误判。
- **模式判定**：
  - `slide`：存在 `widget.png` 单张（整颗停靠，CSS 滑出半掩）。
  - `transform`：同时存在 `idle.png`（半掩）+ `hover.png`（伸出）两张。
- **回落**：无任何有效皮肤或 `list_skins` 失败时回落到内置 `default`。
- **持久化**：选择存 `localStorage["floating-notepad.skin"]`，跨会话保留。

---

## 6. 数据流（db.ts）

`src/lib/db.ts` 是 Rust 数据库命令的前端封装：

- `loadState()` / `saveTabs()`：速记标签页全量加载 / 覆盖式写回（`save_tabs`）。
- `setActiveTab(id)`：持久化当前激活标签页。
- `loadCategories()` / `saveCategories()`：待办分类全量加载 / 覆盖式写回，`todos` 字段 JSON 字符串与前端 `Todo[]` 互转。
- `setActiveCategory(id)`：持久化当前激活分类。

App 内所有增删改都收敛到这几个封装，后端命令为纯数据读写，前端负责交互与渲染。

**退出前落库**：Rust 的退出流程会先广播 `before-quit`（见 `src-tauri/LOGIC.md`「退出」），前端监听后立即 `scheduleSave(true)`，把防抖中的文本/待办编辑写入。结构性变更（新增 / 删除 / 重排 / 切换激活）本就是立即持久化，不受防抖影响。

**状态管理**：标签页与分类共用同一套「带激活项的持久化列表」管理模式，由 `src/lib/useEntityList.ts` 的 `useEntityList` hook 统一提供（列表 + 激活项 + refs + CRUD：新增 / 切换 / 重命名 / 重排 / 删除确认 / 编辑激活项）。App 只注入差异点（数据形状、默认名、删除确认条件、持久化目标）；`src/lib/list.ts` 提供纯函数 `reorderById`（重排核心逻辑）。待办编辑基于当前激活分类经 `mutateTodos(mutator)` 统一走「读取最新引用 → 更新 todos → 防抖保存」，不再按操作各写一份模板。
