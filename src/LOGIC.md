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

屏幕逻辑尺寸由 `App.syncScreen()` **统一读一次**（`src/lib/screen.ts` 的 `readMonitorScreen()`，读 `currentMonitor()` 的真实尺寸转逻辑像素），再 `applyScreen()` 分发给两个控制器（一次读取，两处共用）；尺寸没变就直接返回。`WindowController.watchScreenChange()` 订阅 `onScaleChanged`（改缩放/DPI）与 `onMoved`（换显示器）并在去抖后触发重读，所以中途换显示器不必重启。

### 停靠位置持久化

拖动松手后 `snapWidgetToNearestEdge()` 会 `saveDock(edge, y)`，把贴附的边与垂直中心 Y 写入 `localStorage["floating-notepad.dock"]`，下次启动从同一处出现；未记录过时回落到屏幕垂直中央（`loadDock()` 返回 `null`）。

位置与皮肤名一样**独立于 `AppConfig`**——它由拖动产生，属于运行时状态而非设置项，拖动时不需要走配置的 `sanitize`。

`applyScreen()` 拿到真实显示器尺寸后会 `clampY(dockY)`：换显示器或改分辨率后，旧坐标可能落在屏幕外，夹回可见范围。启动时也因此**必须先把屏幕尺寸喂进去（`syncScreen()`）再 `showWidget()`**，否则会用 `window.screen` 的兜底尺寸定位。

`App` 的 `edge` state 在 `syncScreen()` 完成后从 `windowCtl.currentEdge()` 同步——挂件的翻转与面板展开方向都依赖它，不同步会出现「窗口贴左、样式按右」的错位。

### 挂件容器尺寸（素材比例）

挂件容器**跟着素材图片的实际大小走**，不是正方形。“配置尺寸 → 素材实际大小”的映射规则只写在 `widgetBoxFor(size, ratio)`（`src/lib/window.ts`）一处：素材按 `size × size` 的方框等比缩放（长边 = 配置的挂件大小，短边按素材宽高比收缩），宽度再额外留 `WIDGET_BOX_PAD_X`（20px）。图片始终贴着停靠边，那段留白落在朝屏幕内侧。`WindowController`（窗口矩形、停靠坐标、碰撞箱）与挂件 CSS 容器（`FloatingWidget`）取的是同一个函数的结果，尺寸不会各算一遍；**隐藏态露出多少（`peek`）也在这个函数里定**——CSS 的滑出量 = 容器宽 − `peek`，proximity 在隐藏态的判定矩形用的也是这个数，两处取同一份。

这条必须成立：碰撞箱（窗口矩形 + proximity 判定）按容器算，容器比图片大出的那一圈就是「幽灵区」——鼠标落在图片外的空处仍判定为「在挂件内」，`mouseleave` 也不会触发。`object-fit: contain` 恰好会造出这一圈（图片按短边缩进方框，两侧或上下留下空走），所以容器的宽高必须严格等于图片尺寸加上面那段刻意留的宽度。

比例在 `loadSkins()` 加载图片时量出（`Skin.ratio`，变化模式取 `idle.png`）；App 里算一次 `widgetBoxFor(config.widgetSize, skin.ratio)`，再由一个 effect 下发给窗口（`setWidgetBox`，面板打开或首次定位完成前退化为只记录的 `syncWidgetBox`）。**尺寸一变就下发**——窗口不会停在旧尺寸上，容器也不会比窗口宽或窄（这两者不一致就是“看着有但摸不到”或“摸得到但看不见”）。

---

## 2. 鼠标感应（ProximitySensor）

`src/lib/proximity.ts` 订阅 Rust 广播的 `cursor-move` 事件，把物理像素除以 `devicePixelRatio` 换算为逻辑像素后回调 App。Rust 侧只广播「有意义的位置变化」（窗口不可见、穿透态、离挂件太远的移动都不发，见 `src-tauri/LOGIC.md` 第 3 节的广播门槛），所以前端不必在每个坐标上都跑一遍判定。

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
- 配置项：`widgetSize`、`windowWidth`、`windowHeight`、`autoCloseDelay`、`idleOpacity`、`pinned`（面板固定）、`panelMargin`（面板碰撞箱外扩）、`fullscreenPassthrough`（全屏自动穿透）、`muted`（静音）、`usageTracking`（记录应用使用时间）、`chime`（整点报时）、`planNotify`（任务提醒）、`planBadge`（挂件待办角标）。

> 穿透状态是 Rust 维护的运行时态，由 `passthrough-state` 广播驱动，前端只同步显示、不自行持久化（见第 3 节）。

> 开机自启同样**不进 `AppConfig`**：它属于系统状态（Windows 下是启动项），由 `@tauri-apps/plugin-autostart` 读写，启动时读真实值同步显示（见第 11 节）。

**皮肤名**单独存在 `localStorage["floating-notepad.skin"]`（见第 5 节），不混在配置对象里。

---

## 5. 皮肤系统（skins.ts）

- **物理结构**：`public/skin/<name>/` 每个文件夹一套皮肤，文件夹名即皮肤名。
- **发现**：前端不能列目录，先 `invoke("list_skins")` 拿文件夹名列表，再逐文件夹用 `<img>` 加载约定文件名下的图片：解码成功即视为存在，同时量出宽高比。用 `<img>` 而非 `fetch(HEAD)`——Vite dev 下缺失的 `.png` 会回退返回 `index.html`（200 + `text/html`），只看状态码会误判，而解码失败天然把 HTML 挡掉；顺带取到的比例本来也必须知道。清单只跟**皮肤目录**有关，与“当前选了哪个”无关，所以**只在启动加载一次**；当前皮肤由「清单 + 选中的名字」推出，换皮肤只做本地解析。
- **模式判定**：
  - `slide`：存在 `widget.png` 单张（整颗停靠，CSS 滑出半掩）。
  - `transform`：同时存在 `idle.png`（半掩）+ `hover.png`（伸出）两张。
- **宽高比（`Skin.ratio`）**：挂件容器与窗口按它收缩到图片实际大小（长边 = 配置的挂件大小，宽度另加固定留白），见第 1 节「挂件容器尺寸」；变化模式以 `idle.png` 定尺寸——两张画布未必等大。
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
- **日界**：使用统计从**当天 04:00** 起算（熬夜那段算前一天，日期串是逻辑日）；**日程等其它功能一律用真实日历日**（00:00 换日），别跟着这套走。
- **时间线**：会话按所属应用着色，颜色与饼图图例共用一份映射（按总时长排名取色）。横轴**按当天实际会话裁剪**——只显示有首尾各留 3 分钟余量的区间，而不是整天；跨度不足 30 分钟时按 30 分钟居中铺开，避免一两条短会话被放大成「用了一整天」。悬停色块弹出浮层，显示应用名、起止时刻与时长。浮层画在**色条正上方、面板内部**，横向锚点按浮层半宽夹进色条范围——窗口只有这么大，webview 之外没有像素可显示；而面板的撕纸边缘是 `clip-path`，会裁掉**任何越界的后代**（`fixed` 元素也逃不掉，portal 挂到 `body` 也一样），所以方案是往里收而不是往外跳。开销可忽略：仅在悬停期间多渲染一个节点，坐标在进入色块时取一次 `getBoundingClientRect`。
- **饼图**：SVG 圆环，用 `stroke-dasharray` 依次叠加各应用的弧段，圆心显示当天合计。
- 面板打开（或切换口径）即读一次，**不做定时刷新**：采样虽在后台持续进行，但面板是开着看一眼的东西，重新打开拿到的就是最新的。

数据全部来自本机 `notes.db`，面板不做任何跨天查询。

---

## 8. 样式组织（styles/ + 组件同名 CSS）

样式按组件拆分，没有单体 CSS 文件：

- `styles/base.css`：重置与设计令牌（`:root` 的纸墨配色、撕纸轮廓 `--torn`、阴影）的全局唯一来源。
- `styles/overlay.css`：皮肤 / 设置 / 使用统计三类覆盖层共用的壳（`.skin-overlay`、`.skin-panel`、`.set-*` 开关）与皮肤卡片网格——三个面板长得一样是因为它们真的共用这些类。
- 其余与组件同目录同名：`FloatingWidget.css`、`TabBar.css`、`NotePanel.css`、`ConfirmDialog.css`、`LockView.css`、`UsagePanel.css`、`PopupView.css`、`PlansView.css`。
- 所有 CSS 仍是全局类名（未用 CSS Modules），因此**导入顺序即级联顺序**：统一在 `main.tsx` 按固定顺序导入，不要调整顺序，也不要改成组件内各自 import——那会改变同优先级规则的覆盖关系。

---

## 9. 音效与挂件交互

- **音效统一出口（`lib/sounds.ts`）**：`SoundPlayer` 类持音频池与静音状态，导出单例 `sounds`，调用点只写 `sounds.play("paperOpen")`，静音判断也在类里。`playOnEvent(event, name)` 用于「替播不了声音的窗口代播」——弹窗窗口从未被用户点过，Chromium 会拦掉无用户交互的 audio，因此 `popup-show` 与 `plan-due` 都由主窗口代播。弹窗（目前是报时）用 `bell`，任务提醒用 `notification`，启动提示音仍是 `notification`。
- **通用弹窗（`PopupView`）**：与业务无关，只画 Rust 下发的一段内容（主文本 + 可选小字）——`popup-show` 载荷带文本与不透明度（文本由 Rust 组织，前后端不各写一套）；挂载时再主动取一次 `popup_state`，避免事件错过后空白。目前唯一使用者是整点报时。
- **挂件右键菜单关闭后要收起**：原生菜单期间指针被菜单接管，挂件收不到 `mouseleave`，会一直卡在展开态。菜单关闭后走一次 `onWidgetLeave` 收起；指针若确实还停在挂件上，光标采样会在冷却结束后重新展开。

---

## 10. 日程 / 待办（`lib/plans.ts` + PlansView / PlansPanel）

日程分两处，主界面只负责**看与删**：

- **展示**：待办栏（分类标签页）里的「日程」系统标签页，`PLANS_TAB_ID = -1`，是 `categories` 的一行——不可重命名、不可删除，但能拖拽换序（跟着分类一起落库）。选中时**只有待办清单那一块**换成日程列表，速记区照常在上方，切标签不会像换页。
- **新增与提醒开关**：面板头栏的日历按钮打开覆盖层面板（`PlansPanel`，标题「日程」），里面是任务提醒总开关 + 「某一天 / 每周」两个表单。开关放在这里而不是功能面板，是因为它只跟日程有关；默认开启。表单不塞进标签页，是不想让输入控件占掉列表区域。
- **内容上限 15 字**（`PLAN_TEXT_MAX`）：提醒小窗只有 220 宽，再长既读不完也会把窗口撑高。
- **系统标签页的视觉**：不参与便签配色轮换——白纸底 + 朱砂虚线框 + 小日历图标，选中时虚线转实线。标记用 `outline` 而非 `border`：`.tab.active` 的朱砂底杠是 `border-bottom`，用 `border` 简写会连它一起覆盖（底杠就没了），`outline` 与 `border` 互不干扰，等于直接继承普通标签页的选中底线。只做「换个颜色」不够，纸深色和便签黄几乎一个色，看不出来。
- **面板内的弹出（`PopupToast`）**：面板展开时 Rust 不弹独立小窗（会被挡住），只广播内容，主窗口在面板顶部显示同名提示条，观感与小窗一致，5 秒后自动消失。消失有动画，所以卸载前先打 `leaving` 再延迟 180ms，直接卸载就看不到动画了。
- **提示条只在面板展开时渲染**：收起面板后它不该继续飘在挂件上方，但状态留着——下次打开面板若还没过兜底时长，它还在。前端不需要把这个状态同步给后端：Rust 用窗口几何自己判断（见后端文档）。
- **挂件元素的闲置透明度**：`.widget-fade` 是共享类——闲置时 `opacity: var(--idle-opacity)`，展开/拖动时 1，穿透态强制回到闲置值。挂件图与待办角标都带这个类，新元素也只要带上它，不必再抄一遍 opacity 规则（透明度只有一个来源）。
- **过期自动清理**：一次性日程过了当天（真实日历日）就不再读取时被删掉（后端在 `load_plans` 里清）；周常任务不过期。没有完成态，留着只会堆积。

- **没有完成态**：任务只是带日期时间列出来，不需要了就删。周常任务只列一条而不是按天展开——展开会把同一件事重复七次，反而读不清。
- **提醒是全体开关**（日程面板「任务提醒」）：到点发系统通知；时间为空的日程不提醒。Rust 每分钟比一次，前端只负责开关与数据。
- **主页面只占日期行的左侧空白**（`.seal-plan`）：显示最近一项日程（今天 / 明天 / 周三 + 时刻 + 内容），没有近期日程时整段不渲染，把这一行还给日期。点击跳到日程标签页。
- **挂件角标**显示**今天还没到点**的日程数（`isPending`：属于今天、且无时刻或时刻没到；今天已过时刻的不算）。列表里被标出来的行用的就是同一个 `isPending`——角标与高亮是同一批任务，口径只有一处。角标贴在朝屏幕内侧的上角（靠左放右上、靠右放左上），并整体收进挂件范围内——挂件尺寸用户可调，贴边放会被边界裁掉一截。
- **刷新**：启动取一次，之后**不做定时轮询**。日程只由本应用改（增删改即时重算），需要重取的是「派生值随时刻过期」的时刻，共三类：今天某条日程的时刻走完（`nextRefreshAt()` 算出下一个这样的边界）、跨过 00:00、以及收到 `plan-due`（真到点了）。窗口被隐藏期间定时器会被 webview 节流，所以重新可见时也补一次。
- **日界：只有使用统计用 04:00**。日程一律真实日历日（`clock()` 直接取本地日期、星期与自 00:00 起的分钟数），比较时刻与排序都用同一把尺子。

---

## 11. 开机自启与诊断留痕

**开机自启**（`@tauri-apps/plugin-autostart`）：功能面板（`FeaturePanel`）的「开机自启」开关，真相源在系统（Windows 下是启动项），前端只同步显示。

- 启动时 `isEnabled()` 读真实状态初始化开关；切换时 `enable()` / `disable()` 写入系统。
- **不写 localStorage、不进 `AppConfig`**——它不该被缓存成第二个真相源（详见 `src-tauri/LOGIC.md` 第 12 节）。
- 状态与回调由 `App.tsx` 持有（`autostartOn` / `onAutostartChange`），`FeaturePanel` 是受控组件。

**诊断留痕**（`src/lib/log.ts`）：`logEvent(tag, msg)` 把关键 UI 操作上报给 Rust 的 `log_event` 命令，由 Rust 统一写日志（同时打到控制台）。

- 只上报**低频关键事件**：面板打开 / 关闭（`panel`）、右键隐藏挂件（`widget`）。
- **高频行为不记**：鼠标靠近滑出、自动收起、光标轮询——记了会淹没日志（所以 `beginClose` 里只在 `mode === "expanded"` 时留痕）。
- 上报失败静默：留痕本身不该影响功能。
