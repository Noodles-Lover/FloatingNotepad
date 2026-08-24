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

`revealed` 的判定额外并入 `passthrough`：穿透开启时挂件必须保持屏幕内（不能因为 proximity 失效而消失），见第 3 节。

窗口交互形态由两个职责分离的控制器负责：

- **`WindowController`**（`src/lib/window.ts`）：悬浮挂件形态。负责贴边（left/right）、垂直位置、拖动、停靠、碰撞箱外扩、`dockHidden()` / `showWidget()` 等窗口定位。
- **`NoteWindow`**（`src/lib/noteWindow.ts`）：速记面板形态。负责 `expand(dockEdge, dockY)`（紧贴停靠侧向外弹出、垂直中心对齐挂件、与屏幕边沿留 `MARGIN`）、`collapse()`（还原回挂件隐藏态，经注入的 `windowCtl.dockHidden()`）、`bounds()`（读窗口真实 outerPosition/outerSize 换算逻辑像素，供 proximity 判定鼠标是否在面板内）。

`WindowController` 与 `NoteWindow` 的 `refreshScreen()` 共用 `src/lib/screen.ts` 的 `readMonitorScreen()`（读 `currentMonitor()` 的真实尺寸转逻辑像素）覆盖内部 `screen`，避免窗口被放到屏幕外——多显示器/热插拔场景由这层保证。

---

## 2. 鼠标感应（ProximitySensor）

`src/lib/proximity.ts` 订阅 Rust 广播的 `cursor-move` 事件，把物理像素除以 `devicePixelRatio` 换算为逻辑像素后回调 App。

App 端判定**始终基于 UI 当前真实 bounds**：

- 挂件形态：根据挂件贴边位置与 `panelMargin`（碰撞箱外扩）判定接近。
- 面板形态：用 `NoteWindow.bounds()` 的真实矩形判定鼠标是否仍在面板内，超时（`autoCloseDelay`）后自动收起。
- 穿透模式：proximity 直接早退（穿透时不参与鼠标检测），保证鼠标不会因接近而触发任何行为。

---

## 3. 穿透模式的前端侧（与 Rust 协同）

前端不维护穿透状态的第二个副本，状态唯一来源是 Rust 的 `passthrough-state` 广播：

- **切换入口**：`setPassthrough(on)` 只调 `invoke("toggle_passthrough")`（Rust 统一执行样式与状态）。
- **显示同步**：`listen<boolean>("passthrough-state")` 驱动：
  - 开启：`showOnly()` + `setMode("hidden")`，挂件保持在屏幕内，且进入 `passthrough` 渲染标记。
  - 关闭：恢复挂件常态渲染。
- **渲染标记**：`revealed = mode === "revealed" || dragging || passthrough`，穿透时挂件即使 `mode === "hidden"` 也保持屏幕内可见。
- **样式**：`FloatingWidget` 的 class 列表追加 `passthrough`，`App.css` 定义 `.widget-wrap.passthrough` 强制 idle 图、隐藏 hover 图，穿透时挂件恒为「闲置图」静态展示。
- **右键菜单**：挂件右键菜单含「穿透模式」项，点击 `invoke("toggle_passthrough")`，command 内部复用 `do_toggle_passthrough`（与托盘共用同一函数）。另有「退出」项调 `getCurrentWindow().close()`。

---

## 4. 配置（config.ts）

优先级：**localStorage 用户覆盖 > public/config.ini 出厂默认 > 代码内 `DEFAULT_CONFIG`**。

- `loadConfig()`：先 fetch `/config.ini`（`cache: "no-store"`）解析 INI 键值（跳过注释/空行），再合并 localStorage 覆盖，每层都过 `sanitize`（数值范围过滤，非法值丢弃）。
- `saveConfig(cfg)`：应用内「设置」面板调整后写 localStorage（最高优先级，无需改打包文件）。
- 配置项：`widgetSize`、`windowWidth`、`windowHeight`、`autoCloseDelay`、`idleOpacity`、`pinned`（面板固定）、`panelMargin`（碰撞箱外扩）、`passthrough`。

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

**状态管理**：标签页与分类共用同一套「带激活项的持久化列表」管理模式，由 `src/lib/useEntityList.ts` 的 `useEntityList` hook 统一提供（列表 + 激活项 + refs + CRUD：新增 / 切换 / 重命名 / 重排 / 删除确认 / 编辑激活项）。App 只注入差异点（数据形状、默认名、删除确认条件、持久化目标）；`src/lib/list.ts` 提供纯函数 `reorderById`（重排核心逻辑）。待办编辑基于当前激活分类经 `mutateTodos(mutator)` 统一走「读取最新引用 → 更新 todos → 防抖保存」，不再按操作各写一份模板。
