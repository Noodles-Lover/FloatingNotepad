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

### 停靠位置持久化

拖动松手后 `snapWidgetToNearestEdge()` 会 `saveDock(edge, y)`，把贴附的边与垂直中心 Y 写入 `localStorage["floating-notepad.dock"]`，下次启动从同一处出现；未记录过时回落到屏幕垂直中央（`loadDock()` 返回 `null`）。

位置与皮肤名一样**独立于 `AppConfig`**——它由拖动产生，属于运行时状态而非设置项，拖动时不需要走配置的 `sanitize`。

`refreshScreen()` 拿到真实显示器尺寸后会 `clampY(dockY)`：换显示器或改分辨率后，旧坐标可能落在屏幕外，夹回可见范围。启动时也因此**必须先 `refreshScreen()` 再 `showWidget()`**，否则会用 `window.screen` 的兜底尺寸定位。

`App` 的 `edge` state 在 `refreshScreen()` 完成后从 `windowCtl.currentEdge()` 同步——挂件的翻转与面板展开方向都依赖它，不同步会出现「窗口贴左、样式按右」的错位。

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

优先级：**localStorage 用户覆盖 > 代码内 `DEFAULT_CONFIG` 出厂默认**。

- `loadConfig()`：同步读取。以 `DEFAULT_CONFIG` 为底，合并 localStorage 里的用户覆盖，覆盖前过 `sanitize`（数值范围过滤，非法值丢弃）。
- `saveConfig(cfg)`：应用内「设置」面板调整后写 localStorage。
- 出厂默认值集中在 `DEFAULT_CONFIG`。
- 静音（`muted`）由速记面板**头栏的喇叭按钮**切换，设置面板里不再有开关——头栏要放固定、皮肤、统计、静音、设置、收起六个按钮，设置面板只留不与它们重复的项。
- 配置项：`widgetSize`、`windowWidth`、`windowHeight`、`autoCloseDelay`、`idleOpacity`、`pinned`（面板固定）、`panelMargin`（面板碰撞箱外扩）、`fullscreenPassthrough`（全屏自动穿透）、`muted`（静音）、`usageTracking`（记录应用使用时间）。

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

---

## 7. 使用统计（usage.ts / UsagePanel）

`src/lib/usage.ts` 封装两条命令；`UsagePanel` 是与皮肤、设置同级的覆盖层面板，从速记面板头栏的柱状图图标进入。

- `loadUsage()`：取当天数据——`sessions`（区间，画时间线）与 `totals`（各应用总时长，画饼图）。后端只统计当天，无需传日期。
- `loadUsageAll()`：取全部历史的各应用总时长与日期范围。饼图可在「今天 / 全部」间切换，**时间线始终只看当天**，不随切换变化；历史数据只在切到「全部」时才请求。
- `setUsageTracking(enabled)`：把 `config.usageTracking` 同步给 Rust 采样器，与全屏开关同一条同步路径（配置加载时一次、改动时一次）。
- **日界**：与后端一致，一天从**当天 04:00** 起算（日期串是逻辑日，`new Date(\`${day}T04:00:00\`)` 得原点）。
- **时间线**：会话按所属应用着色，颜色与饼图图例共用一份映射（按总时长排名取色）。横轴**按当天实际会话裁剪**——只显示有首尾各留 3 分钟余量的区间，而不是整天；跨度不足 30 分钟时按 30 分钟居中铺开，避免一两条短会话被放大成「用了一整天」。悬停色块弹出浮层，显示应用名、起止时刻与时长。浮层画在**色条正上方、面板内部**，横向锚点按浮层半宽夹进色条范围——窗口只有这么大，webview 之外没有像素可显示；而面板的撕纸边缘是 `clip-path`，会裁掉**任何越界的后代**（`fixed` 元素也逃不掉，portal 挂到 `body` 也一样），所以方案是往里收而不是往外跳。开销可忽略：仅在悬停期间多渲染一个节点，坐标在进入色块时取一次 `getBoundingClientRect`。
- **饼图**：SVG 圆环，用 `stroke-dasharray` 依次叠加各应用的弧段，圆心显示当天合计。
- 面板打开即读一次，之后每 30 秒刷新：采样在后台持续进行，面板停留期间需要跟上。

数据全部来自本机 `notes.db`，面板不做任何跨天查询。

---

## 8. 样式组织（styles/ + 组件同名 CSS）

样式按组件拆分，没有单体 CSS 文件：

- `styles/base.css`：重置与设计令牌（`:root` 的纸墨配色、撕纸轮廓 `--torn`、阴影）的全局唯一来源。
- `styles/overlay.css`：皮肤 / 设置 / 使用统计三类覆盖层共用的壳（`.skin-overlay`、`.skin-panel`、`.set-*` 开关）与皮肤卡片网格——三个面板长得一样是因为它们真的共用这些类。
- 其余与组件同目录同名：`FloatingWidget.css`、`TabBar.css`、`NotePanel.css`、`ConfirmDialog.css`、`LockView.css`、`UsagePanel.css`、`ChimeView.css`。
- 所有 CSS 仍是全局类名（未用 CSS Modules），因此**导入顺序即级联顺序**：统一在 `main.tsx` 按固定顺序导入，不要调整顺序，也不要改成组件内各自 import——那会改变同优先级规则的覆盖关系。

---

## 9. 音效与挂件交互

- **音效统一出口（`lib/sounds.ts`）**：`SoundPlayer` 类持音频池与静音状态，导出单例 `sounds`，调用点只写 `sounds.play("paperOpen")`，静音判断也在类里。`playOnEvent(event, name)` 用于「替播不了声音的窗口代播」——报时小窗从未被用户点过，Chromium 会拦掉无用户交互的 audio，因此 `chime-show` 由主窗口代播，报时小窗自身只显示时刻。
- **报时小窗（`ChimeView`）**：内容来自 Rust——`chime-show` 载荷带时刻与不透明度（时刻由 Rust 格式化，前后端不各写一套）；挂载时再主动取一次 `chime_state`，避免事件错过后小窗空白或停在启动时刻。
- **挂件右键菜单关闭后要收起**：原生菜单期间指针被菜单接管，挂件收不到 `mouseleave`，会一直卡在展开态。菜单关闭后走一次 `onWidgetLeave` 收起；指针若确实还停在挂件上，光标采样会在冷却结束后重新展开。
