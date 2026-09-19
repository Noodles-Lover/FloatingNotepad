# 后端核心逻辑（src-tauri）

本文件描述 `src-tauri/` 下 Rust 侧的核心实现，作为阅读 `lib.rs` / `db.rs` 的导航。内容描述代码现状，不含历史改动叙事。

---

## 1. 穿透模式（重点）

### 设计：Rust 为唯一真相源

穿透状态由 Rust 托管（`PassthroughState`，内部 `AtomicBool`），托盘菜单与挂件右键菜单**统一经由同一个切换入口** `do_toggle_passthrough`，不存在第二条旁路。

### 完整实现链路

```
托盘菜单 "toggle_passthrough" ────────┐
挂件右键 invoke("toggle_passthrough") ├─→ toggle_passthrough ──→ do_toggle_passthrough
解锁按钮 invoke("toggle_passthrough") ┘                          ──→ apply_transparent + set_input_enabled
```

`do_toggle_passthrough(app, tray_item)` 顺序执行：

1. **取主窗口 HWND**：**按 label `"main"` 取窗口**，再经 `main_hwnd` 取句柄；取不到时只翻转状态、广播事件，跳过样式操作。

   > 目标窗口必须在函数内部解析，**不能接收调用方注入的 `WebviewWindow`**。注入的是「发起 invoke 的窗口」，锁窗口调用时就会把样式打在锁自己身上，主窗口的穿透位永远不被清除（表现为解锁后点击仍穿透）。
2. **翻转状态并计算目标值** `next = !当前值`。
3. **`apply_transparent`**：设置/清除窗口扩展样式位，`SetWindowPos(SWP_FRAMECHANGED)` 强制系统重算。
4. **`set_input_enabled`**：穿透时 `EnableWindow(hwnd, FALSE)`，退出时 `TRUE`。
5. **`PassthroughState::write_current`**：写入唯一真相源。
6. **`app.emit("passthrough-state", new_on)`**：广播给前端同步显示。
7. **同步托盘勾选**：`tray_item.set_checked(new_on)`。

### Win32 样式位（apply_transparent）

```rust
let bits = (WS_EX_TRANSPARENT | WS_EX_NOACTIVATE | WS_EX_LAYERED).0 as isize;
```

| 样式 | 作用 |
| --- | --- |
| `WS_EX_TRANSPARENT` | 命中测试穿透，点击落到下方窗口（后方内容可交互） |
| `WS_EX_NOACTIVATE` | 点击不激活本窗口，焦点不会切到应用 |
| `WS_EX_LAYERED` | 分层窗口，保证 TRANSPARENT 命中穿透稳定生效 |

切换后 `SetWindowPos(HWND_TOP, 0,0,0,0, SWP_NOMOVE|SWP_NOSIZE|SWP_FRAMECHANGED)` 强制系统立即应用/移除样式位。

### EnableWindow 的作用（set_input_enabled）

仅靠样式位，窗口在部分场景仍可能收到点击/抢焦点。`EnableWindow(hwnd, FALSE)` 让窗口连同其 webview 子窗口**完全不接收任何鼠标/键盘输入**，也不成为激活窗口，点击直接落到 z-order 下方——窗口只保留视觉效果。退出穿透时恢复 `TRUE`。

- 函数位于 `windows::Win32::UI::Input::KeyboardAndMouse::EnableWindow`，需在 `Cargo.toml` 的 windows 依赖启用 `Win32_UI_Input_KeyboardAndMouse` feature。
- 返回值为 `must_use`，调用处加 `let _ =`。

### 托盘勾选项同步（TrayPassthroughRef）

```rust
pub struct TrayPassthroughRef(pub Mutex<Option<CheckMenuItem<tauri::Wry>>>);
```

setup 阶段把托盘穿透菜单项 clone 存入该托管引用；切换命令 / 事件处理器从引用取回并 `set_checked`，保证托盘勾选与真实状态同步。

> 泛型必须是 `CheckMenuItem<tauri::Wry>`（Tauri v2 的菜单类型），不是 `AppHandle`。

### 前端配合

- 前端 `setPassthrough(on)` 只调 `invoke("toggle_passthrough")`，不做本地状态翻转。
- 显示状态完全由 `listen<boolean>("passthrough-state")` 广播驱动，消除双路径状态竞态。
- 穿透开启时前端执行 `showOnly()` + `setMode("hidden")`，挂件呈半掩静态展示并强制 idle 图渲染（见 `src/LOGIC.md`）。

### 命令与权限

- command `toggle_passthrough(app, tray_ref)`：`tray_ref` 为自动注入的 `State<TrayPassthroughRef>`。
- 权限：`permissions/commands.toml` 定义 `allow-toggle-passthrough`，`capabilities/default.json` 引用。
- 注意：Tauri v2 默认以 Rust 函数名（snake_case）注册命令，前端 `invoke` 与 `permissions` 的 allow 项必须一致。
- 权限文件改动后必须重新编译才生效：ACL 由 `tauri-build` 在编译期生成（默认扫描 `./capabilities/**/*` 与 `./permissions/**/*`）。`tauri-build` 自身会 emit `rerun-if-changed=capabilities` 与 `rerun-if-changed=permissions`，故这两个目录变化时 build script 会重跑。若改用 `AppSettings::capabilities_path_pattern` / `permissions_path_pattern` 自定义路径，则需自行 emit 对应的 `rerun-if-changed`，否则会出现「新命令编译进了 exe、ACL 却是旧版本，invoke 被静默拒绝」。

---

## 2. 穿透解锁锁（widget-lock 窗口）

主窗口穿透时对系统整体穿透，其内部任何 DOM 都收不到鼠标事件，因此「点击解锁」必须由**自身不穿透的独立窗口**承载。

### 窗口属性

`ensure_lock_window()` 创建（setup 阶段预创建并常驻隐藏）：

| 属性 | 值 | 原因 |
| --- | --- | --- |
| label | `widget-lock` | 前端 `main.tsx` 按 label 分流渲染 `LockView` |
| URL | `index.html` | 不附加 query：`WebviewUrl::App(PathBuf)` 不支持 query string，`?` 会被编码破坏 |
| 尺寸 | 30×30 | 比 CSS 的 `.lock-btn`（26px）大一圈，给 hover 放大留空间 |
| `skip_taskbar` + `WS_EX_TOOLWINDOW` | — | 不出现在任务栏与 Alt-Tab |
| `WS_EX_NOACTIVATE` | — | 点击不激活，焦点不离开当前应用 |
| `always_on_top` | — | 保证浮在其他窗口之上 |

**显示必须用 `ShowWindow(SW_SHOWNA)`**，不能用 `WebviewWindow::show()`：后者走 `SW_SHOW`，会激活窗口——把焦点从全屏应用里抢走（游戏失焦，穿透名存实亡），还会让锁自己变成前台窗口。`SW_SHOWNA` 只显示不激活，配合 `WS_EX_NOACTIVATE`，前台始终是原来的应用，锁只负责可见与可点。隐藏同理用 `SW_HIDE`，不依赖 Tauri 对可见状态的记忆。

**必须用 `SetWindowRgn` 裁出可交互区域**：Windows 会把小窗口撑到系统最小尺寸（请求 30×30，实测得到 **136×38**），多出来的部分虽然透明，却**照常参与命中测试**——等于在挂件旁边糊了一块看不见的挡板，穿透点击全被它吃掉。窗口区域同时裁剪绘制与用户交互，把命中范围收回按钮那一小块（圆形，与按钮外观一致）。因此 CSS 里 `.lock-btn` 固定在窗口左上角，才能与区域重合。

**收起时机**（`update_lock_hover`）：非穿透态、或主窗口不可见（托盘「隐藏挂件」）时一律收起——主窗口隐藏后矩形仍算得出来，热区依旧成立，不处理的话锁会孤零零地一直浮在屏幕上。

### hover 检测

检测**完全在 Rust 完成**，不依赖前端事件：

- 穿透时主窗口被 `EnableWindow(hwnd, FALSE)` 禁用，其 webview 内的 JS 不保证继续推进，前端无法可靠判断鼠标位置。
- `MouseWatcher` 每 100ms 轮询时，若处于穿透态则调用 `update_lock_hover(app, x, y)`。
- 坐标均为物理像素：`GetWindowRect` 取主窗口矩形，`GetCursorPos` 取光标，可直接比较，无需 dpr 换算。

```
热区 = 主窗口矩形 ∪ 锁矩形
  在内 → 显示锁（先 set_position 后 show，避免闪现在旧位置）
  离开 → 累计时长超过 hide_delay_ms 后隐藏
```

锁位于挂件内侧：主窗口 `left <= 2` 视为贴左，锁放在其右侧，否则放左侧，垂直居中。

### 前台豁免（重要）

锁窗口是本应用自己的 UI，它成为前台时**不参与任何前台判定**：

- **全屏检测**：保持上一次判定不变。它当然不是全屏窗口，若据此判定「已退出全屏」，鼠标一移到挂件上（用户只是想点锁解锁）就会被立刻自动解除穿透、锁也随之消失。
- **使用统计**：保持当前会话不动。游戏还在跑，不该因为锁弹出就中断会话。

判定由 `foreground::is_lock_window(app, hwnd)` 统一提供（比对 `widget-lock` 窗口句柄），两个模块共用。

### 状态

托管 `LockState`：`visible`（是否显示中）、`left_at`（离开热区的时刻）、`hide_delay_ms`（自动隐藏延时）。

- `hide_delay_ms` 默认 600，由前端 `invoke("set_lock_hide_delay")` 在配置加载与设置变更时同步为 `autoCloseDelay`。
- `do_toggle_passthrough` 关闭穿透时统一调用 `hide_lock_now()` 并重置状态，不依赖前端。

### 命令

`show_lock_window` / `hide_lock_window` / `set_lock_hide_delay`，权限定义于 `permissions/commands.toml`。

---

## 3. 鼠标轮询（MouseWatcher）

- `MouseWatcher`：托管状态（`app.manage`），内含 `AtomicBool running`，`start()` 幂等（重复调用为 no-op）。
- 后台线程每 100ms 调 `GetCursorPos`（物理像素）：
  - 处于穿透态时先执行 `update_lock_hover`（见第 2 节）；
  - 随后按 `CursorEmit` 的门槛决定要不要 `app.emit("cursor-move", {x, y})`。
- **采样频率与广播频率分开**：锁窗口的 hover 判定依赖 100ms 的采样，但前端只关心「靠近/离开」——窗口不可见时、穿透态、以及离主窗口超过 `CURSOR_MARGIN_PX`（48px）之外的移动，广播出去也没有意义。`CursorEmit` 只在四种情况放行：状态刚变成需要关心（穿透关闭 / 窗口重新显示）、刚进入关注范围、范围内坐标变化、刚离开范围（补一次，前端据此开始收起计时）。判定与范围比较都用物理像素，与 `GetCursorPos` 同一把尺子。
- 非 Windows 平台 `current_cursor()` 返回 `None`。
- 命令 `start_mouse_watch(app, watcher)` 供前端启动轮询。

前端 `ProximitySensor` 订阅该事件并把物理像素按 `devicePixelRatio` 换算为逻辑像素，由 App 依据当前 UI 真实 bounds 判定接近/离开。

---

## 4. 系统托盘

setup 阶段构建，菜单项：

| ID | 行为 |
| --- | --- |
| `show` | `emit("show-widget")` |
| `hide` | `emit("hide-widget")` |
| `toggle_passthrough` | `CheckMenuItem`，调 `do_toggle_passthrough` |
| `quit` | `do_quit_app` |

- 托盘穿透项初始 `set_checked(false)`，并托管进 `TrayPassthroughRef`。
- 主窗口未就绪时 `do_toggle_passthrough` 退化为仅翻转状态 + 广播 + 同步勾选，待窗口就绪后由下一次切换补全样式；该分支由函数内部统一处理，调用方不再各自实现。

### 退出（do_quit_app）

托盘 `quit`、挂件右键「退出」、命令 `quit_app` 共用 `do_quit_app`。

退出的收尾流程：

1. **`app.emit("before-quit")`**：前端监听后执行 `scheduleSave(true)`，把防抖中的文本/待办编辑立即落库（结构性变更本就是立即保存，这里补的是防抖项）。
2. **延时 `QUIT_FLUSH_MS`（250ms）后 `app.exit(0)`**：兜底强制退出。

> 延时是固定的，不等待前端响应：穿透态下主窗口被 `EnableWindow(FALSE)` 禁用，其 webview 内的 JS 不保证推进，前端可能收不到 `before-quit`。250ms 对本地 SQLite 写入有充足余量。

> 退出必须走 `do_quit_app`。若前端自行 `getCurrentWindow().close()`，一是与托盘行为不一致（关窗口而非退应用），二是依赖 `core:window:allow-close` 权限——该权限不在 `core:window:default` 内，缺省时 invoke 会被静默拒绝。

**多入口功能必须收敛到单一实现**（详见开发思维规则）。本项目有三个入口共用同一函数的例子：穿透切换、退出、锁窗口显隐。

---

## 5. 数据库（db.rs）

- `init_db(app)`：setup 阶段建库建表，失败即 panic（存储不可用就快速失败）。
- 表：
  - `notes`：旧版单文档遗留表（单行 `id = 1`，存 note 正文与 todos JSON）。仅用于迁移，新版本不再读写。
  - `tabs`：速记标签页（title / content / position）。
  - `categories`：待办分类（title / todos JSON / position）。
  - `meta`：键值对，存激活项 id 与迁移标记。
  - `usage_sessions`：应用使用统计（day / app / start_ms / end_ms，按 day 建索引）。启动时清理 30 天前的数据——面板只展示当天，历史留着只会让库无谓变大。
- 一次性迁移（以 `meta` 中 `migrated_notes` / `migrated_categories` 标记防重复）：
  - `migrated_notes`：首次启动且 `tabs` 为空时，把 `notes` 单行正文迁入第一个标签页「速记」。
  - `migrated_categories`：首次启动且 `categories` 为空时，把 `notes` 单行残留的 todos 迁入默认分类「主要」。
- 命令：`load_tabs` / `save_tabs`（覆盖式全量写回）、`set_active_tab`、`load_categories` / `save_categories`（覆盖式）、`set_active_category`。
- `save_tabs` 与 `save_categories` 共用 `replace_all` helper：同一事务内先 `DELETE` 整表、再按 `position` 重新 `INSERT`；空列表直接跳过（防止误清空）。
- 前端通过 `src/lib/db.ts` 的 invoke 封装访问，`todos` 字段在 Rust 侧以 JSON 字符串存、前端解析为数组。

---

## 6. 皮肤发现（list_skins）

- 读取 `resource_dir()` 下的 `skin/` 目录，返回文件夹名列表（跳过 `.` 开头的隐藏目录，排序后返回）。
- dev 与 prod 下 `resource_dir` 层级不同，枚举多个候选路径，取第一个真实存在的目录。
- 前端 `loadSkins()` 据此探测图片文件判定模式（见 `src/LOGIC.md`）。

---

## 7. 应用使用统计（usage.rs）

每 10 秒采样一次前台应用，把「连续使用某个应用」记成一条会话写进 `usage_sessions`。

- **会话边界**：只有前台切换、跨天、空闲（>60s 无键鼠输入）或关闭功能时才结束会话；其余时候结束时间只攒在内存里，按 `FLUSH_INTERVAL_MS`（3 分钟）的节奏才写一次盘——跟着采样频率写就是每 10 秒一次 `UPDATE`，一天数千次。代价是进程被强杀最多丢 3 分钟时长（手动退出前 `usage::flush` 会补一次）。
- **跨天**：旧会话属于昨天时，结束时间按昨天最后一毫秒算（`day_start - 1`），不能写成「现在」，否则会把今天开头的几分钟记到昨天头上。
- **排除自身**：浮笺只是贴在别人上面的便签，`own_process()` 比对 `current_exe()` 的文件名后把自己排除在统计外。
- **离开判定（何时停表）**：只有**明确离开**才结束会话——锁屏（前台是系统覆盖层，或宿主进程是 `LockApp.exe` / `LogonUI.exe`）、屏保运行（`SystemParametersInfoW(SPI_GETSCREENSAVERRUNNING)`）、系统睡眠（见下一条）。
  键鼠空闲**只作兜底**，阈值 45 分钟：看视频、看文档、会议投屏时全程没有键鼠输入，但人一直在看，按几十秒停表会把这些整段吞掉。代价是「离开但既没锁屏也没屏保」时最长会多记 45 分钟。
- **时间基准**：本地日期由 SQLite 的 `date('now','localtime')` 提供（`db::local_clock()`），不自己处理时区与夏令时。
- **前台读取**：`foreground.rs` 统一提供进程名 / 标题 / 空闲时长，全屏检测（`tracker.rs`）与使用统计共用一份实现，避免两套 Win32 调用各自漂移。
- **系统覆盖层**：Alt+Tab 切换器这类系统 UI 视为「没有在用任何应用」，切换期间不计入任何应用（见第 8 节）。
- **系统睡眠**：合盖 / 休眠时本线程被挂起，`GetTickCount` 与「最后输入时间」**一起冻结**，空闲判定失效——醒来后会把整段睡眠算成使用时间。改用墙上时钟识别：两次轮询的间隔超过 `SLEEP_GAP_MS`（60s，远大于 10s 轮询）即判定睡过，会话停在上一次轮询，睡眠时长不计入任何应用。锁屏（不睡眠）不受影响，那时 tick 照常推进、空闲判定正常生效。
- **日界**：一天以**凌晨 4 点**为界（`db::local_clock()`），熬夜到 3 点仍算前一天；起点 = 当前时刻减 4 小时后取当日零点再加 4 小时，无需分支判断。
- **短间隔合并**：`A → B（≤20s）→ A` 视为一直在用 A——命中时删掉中间那条记录、把前一段的结束时间续到现在（`db::merge_short_gap`）。误触或焦点被弹窗/UAC 短暂抢走不该在时间线上留下痕迹。跨天的旧会话不参与合并（它属于昨天，接不上今天的区间）。
- **与全屏检测的关系**：两者是**各自独立的轮询线程**（统计 10 秒、全屏 1.5 秒），只共用 `foreground.rs` 的窗口读取函数，不共用循环。节奏不同、开关也能独立启停，合并成一个循环会把两件事耦死。
  > 轮询间隔同时是「会话的最小可分辨时长」：合并阈值必须大于它，否则夹在中间的会话永远达不到判定长度（现在 20s > 10s）。
- 命令：`set_usage_tracking`（开关采样）、`load_usage`（当天的会话区间 + 各应用总时长）、`load_usage_all`（全部历史的各应用总时长与日期范围，供面板的「全部」饼图使用）。

---

## 8. 通用弹窗（popup.rs）+ 整点报时（chime.rs）

**`popup.rs` 是与业务无关的通用弹窗**：调 `popup::show(app, text, sub)` 就能在挂件旁弹一小段内容，停留 5 秒后自动收起。目前唯一调用者是整点报时，别的功能要弹一下直接调它即可。

- **独立窗口** `popup`：主窗口可能被穿透或隐藏，弹出不能依赖它。setup 阶段预创建并常驻隐藏——内容靠事件下发，若等首次弹出才创建，前端还没挂载，第一次事件就丢了。
- **尺寸按内容估**：短内容用紧凑尺寸（104×52）；长内容按文本宽度单位（中日韩算 2）估行数算出高，最多 5 行，再长由前端裁掉——估高只影响观感，估矮会把文字切掉，所以宁可贵一点。`show` 里先 `set_size` 再定位。
- **收起由 `show()` 自己排定**：定时器带序号（`show_seq`），期间若又弹一次，旧定时器自动作废，不会把新弹的窗提前收走。
- **面板展开时不弹独立小窗**：会被速记面板挡住，等于白弹。此时只广播内容（音效照旧由主窗口播），由主窗口在面板顶部显示（`PopupToast`）。
- **「面板是否展开」用窗口几何判断**（`panel_expanded`：宽 ≥ 240 且高 > 宽 = 竖长的面板纸；挂件是正方形），而不是让前端同步一个标志位。标志位一旦与服务端失联（invoke 被拒、事件丢失）就永远停在旧值，且极难查；几何是物理事实，不需要同步也不会过时。
- **置顶要用 `HWND_TOPMOST`**：挂件本身是置顶窗口，`HWND_TOP` 只把窗口排到「非置顶组」的第一位，与挂件重叠时会被压在下面。
- **不透明度走 CSS，不用分层窗口**：给 WebView2 的宿主窗口加 `WS_EX_LAYERED` + `SetLayeredWindowAttributes` 会让内容整个不显示。Rust 把不透明度放进 `popup-show` 载荷，前端用 `style={{ opacity }}`。
- **不抢焦点**：与解锁锁一致，`SW_SHOWNA` + `WS_EX_NOACTIVATE`；显示后再补一次不激活置顶。
- **新窗口必须登记能力**：`capabilities/default.json` 的 `windows` 数组决定了哪些窗口拥有这套权限。漏登记的窗口**一条权限都没有**——连 `core:event:allow-listen` 也被拒，于是收不到 `popup-show`，窗口渲染成一片空白（而音效由主窗口播放，听起来像"响了但没弹窗"）。新增窗口时务必把 label 加进 `windows`，并把新命令加进 `permissions/commands.toml` + `default.json`。
- **内容不依赖事件**：`popup-show` 在**显示之后**发（载荷含文本与不透明度）；窗口挂载时还会主动取一次 `popup_state`，万一事件错过也不会空白。
- **音效不在弹窗里播**：该窗口从没被用户点过，Chromium 会拦掉无用户交互的 audio；因此内容广播给所有窗口，由主窗口播放。
- **留痕**：与系统通知相关的路径都写进诊断日志（见第 11 节 `log.rs`）。位置、可见性、系统是否接受通知都是运行时事实，出问题时看日志比读代码快。
- 命令：`popup_state`（窗口挂载时取当前内容）。

**整点报时（`chime.rs`）**只负责「什么时候报」：睡到下一个整点调 `popup::show`；`set_chime` 写开关与不透明度。整点判定复用 `db::local_clock()` 的「自当日 4 点起已过毫秒数」，加 4 小时对一小时取余；末尾多等 250ms，避免本地时钟只精确到秒而提前弹窗。
命令：`set_chime`（开关 + 不透明度）、`ring_chime`（立刻弹一次，供挂件右键菜单的「试一下报时」使用——面板打开时看不见挂件，测试入口只能放在挂件上）。

## 9. 日程 / 待办（plans.rs + notify.rs）

短信道各司其职：**弹窗**（`popup.rs`）与**系统通知**（`notify.rs`）是两个独立的呈现模块，谁要用谁的接口，业务模块（`chime.rs` / `plans.rs`）只管"什么时候提示什么"。

一次性任务（某天）与周常任务（每周几），时刻可为空；到点发**系统通知**。**没有「完成」概念**——只是带日期时间列出来，不需要了就删掉。

- **两张表**：日程在 `plans`（`kind` 为 `once`/`weekly`，二者用 `date` / `weekday`，`time` 为空表示不提醒）；「日程」本身是 `categories` 里的一行**系统标签页**，固定 `id = -1`（负数不会与自增 id 冲突），与「主要」等分类并列。放真行的原因是换序要能落库——它跟着分类一起保存，拖拽排序不用另写存储；不可重命名/删除由前端拦截（它落在待办那一栏，只展示与删除，新增走顶部按钮的面板）。
- **老库清理**：日程曾作为系统标签页插在 `tabs` 里（速记那一栏），`init_db` 会 `DELETE FROM tabs WHERE id = -1` 摘掉残留行，否则老库会永久留着一个删不掉的「日程」。
- **过期自动删除**：`load_plans()` 每次先 `DELETE FROM plans WHERE kind='once' AND date < 今天`（真实日历日）。没有「完成」概念，过期的一次性任务留着只会越堆越多，还要用户手动删；周常任务不会过期。清理放在读取里，跨天不用额外调度。
- **日界：日程用真实日历日**（`db::local_day` / `local_time` / `local_weekday`），**不要用 `db::local_clock`**——那套「凌晨 4 点换日」是应用使用统计专用的（熬夜那段算前一天）。两套日界混用会互相误判：凌晨 1 点看昨天下午 14:47 的任务，按 4 点日界它属于"今天"、又因为时刻比不出来而被当成"还没到"。
- **提醒调度**：一个睡到下一个整分的循环，每分钟比一次「日期/周几 + 时刻」都命中的任务，命中即发系统通知（`tauri-plugin-notification`，见下）。同一分钟多条合并成一条通知、逐行显示。
- **画面交给系统通知**：自己画弹窗在全屏/游戏里打扰不打扰用户，得自己判断（还得判断是不是游戏）；系统通知把这层交给系统——它知道当前是不是全屏、要不要静默、进不进通知中心。音效仍由主窗口播放（`plan-due` 事件），系统通知自带的提示音是系统行为。
- **通知只对已安装的应用生效**：Tauri 官方插件文档在 Windows 一行写得很直白——"Only works for installed apps"，开发态会显示成 PowerShell 的名称与图标。原因是 Windows 要求调用方的 AppUserModelID 在开始菜单里有对应快捷方式，没有的话通知会被系统直接丢掉（`tauri-winrt-notification` 的原话：程序若未安装，请先用 `POWERSHELL_APP_ID`）。安装版由安装器建快捷方式，开发/绿色版没有，于是 `notify::prepare` 启动时让 `shortcut.rs` 写一个 `.lnk`（IShellLink + IPropertyStore 写 `PKEY_AppUserModel_ID`），每次启动重写以修正被移动的 exe。
- **模块分工**：`notify.rs` 只管"发一条通知"（`send` + 启动准备 `prepare`），`shortcut.rs` 只管"给应用准备 AppUserModelID"（Windows 平台细节），`plans.rs` 只决定"到点发什么"。
- **排查入口**：挂件右键菜单「试一下提醒」立刻走一遍提醒路径（不用等到点）；开关状态、命中条数、发送结果都写进诊断日志（见第 11 节）。之前"没弹通知"卡了很久，就是因为日志里连"尝试发送"都没有——开关关着和系统丢弃在界面上完全一样。
- **一分钟最多弹一次**：`last_fire_min` 记上次提醒的 Unix 分钟。睡眠唤醒后线程可能在同一分钟被唤醒多次，没有它通知会连发两回。
- **总开关，不逐条设置**：`set_plan_notify` 由功能面板的「任务提醒」控制，作用于全部日程；时间为空的任务自然不参与（比不出时刻）。
- 命令：`load_plans` / `add_plan`（返回带 id 的完整记录，省一次全量拉取）/ `delete_plan` / `set_plan_notify`。

## 10. 系统覆盖层排除（is_shell_overlay）

Alt+Tab 切换器、任务视图、开始菜单这类系统 UI 由 explorer 提供，**无边框且铺满显示器**，
在几何上与「全屏应用」无法区分：一按 Alt+Tab 就会被判成进入全屏、自动开穿透。

`foreground::is_shell_overlay(hwnd)` 做两级判定，全屏检测与使用统计共用：

1. **类名**（`GetClassNameW`）：类名由系统定义、**不随显示语言变化**，比窗口标题稳定
   ——标题在中文系统上是「工作切换」、英文是「Task switching」，靠标题排除换个语言就失效。
   命中名单见 `SHELL_OVERLAY_CLASSES`；另有 `Shell_` 前缀一律视为外壳 UI。
2. **兜底**：不同 Windows 版本的切换器类名会变（实测 Win11 为 `XamlExplorerHostIslandWindow`，
   Win10 为 `TaskSwitcherWnd`，任务视图为 `MultitaskingViewFrame`），但都归 explorer；
   而资源管理器窗口一定带标题栏——所以「explorer 出的无边框铺满窗口」只可能是系统 UI。
   实测中平板模式遮罩 `TabletModeCoverWindow` 正是靠这条拦下的。

两个使用点：

- **全屏检测**：排除只作用于几何层。d3d 层是系统级判定（`SHQueryUserNotificationState`），
  独占全屏的真游戏不受影响。
- **使用统计**：覆盖层期间返回「无前台应用」，会话暂停，切换的那段时间不计入任何应用。

---

## 11. 诊断日志（log.rs）

统一入口 `log::write(app, tag, msg)`：**一处调用、双输出**——同时打到 stderr 与文件。

- **位置**：`<数据目录>/logs/floatingnotepad-YYYY-MM-DD.log`，按**天**分文件。
- **保留**：启动时 `log::prune` 删除修改时间早于 7 天（`LOG_KEEP_DAYS`）的文件；单文件超过 256KB 就从头写，避免一天内无限增长。
- **不依赖数据库与日期库**：时间用 `windows` crate 的 `GetLocalTime`（自包含）。数据库起不来时，日志反而更该写得出来。
- **panic 钩子**（`install_panic_hook`）：release 用 `panic = "abort"`，进程会直接终止、不留界面提示；钩子仍在 abort 前把 panic 信息写进日志——「静默关闭」时唯一能留下的线索。在 setup 起始处安装。
- **留痕点**（低频、关键；轮询类**不记**，避免淹没日志）：
  - `[app]` 启动（含版本）/ 初始化完成 / 退出；
  - `[passthrough]` 开启 / 关闭（在 `set_passthrough` 唯一入口，覆盖用户切换、全屏自动、解锁）；
  - `[fullscreen]` 进入 / 退出（含判定路径 `via` 与前台应用，在状态翻转那一拍）；
  - `[popup]` 显示 / 隐藏、`[plans]` 到点命中、`[notify]` 发送结果、`[widget]` 托盘显示 / 隐藏挂件。
- **前端事件桥接**：日志文件由 Rust 管理，前端纯 UI 操作（面板开合、右键隐藏）经命令 `log_event(tag, msg)` 上报，走同一个 `log::write`。命令权限：`permissions/commands.toml` 的 `allow-log-event`，`capabilities/default.json` 引用。
- **运行期错误也留痕**：锁显隐失败、全屏自动穿透失败、报时 / 提醒失败、穿透切换失败等都走 `log::write`（release 下没有控制台，`eprintln!` 等于丢失）。
- **启动报错也留痕**：setup 阶段的失败（如预创建窗口）由 `log::write` 写出；更早或更严重的启动错误（数据库初始化失败、托盘构建失败等）会 panic，由 panic 钩子落盘——启动失败时日志里必定有线索。
- **只在值变化时留痕**：`plans::apply` 这类设置同步函数会被前端「全量同步配置」在每次改动时调用（拖动尺寸滑块会高频触发），因此只在值与上次不同时才写日志，避免刷屏。
- **判定用法**：有「启动 / 初始化完成」却无「退出」也无 `[panic]` → 进程被外部结束；有「启动」无「初始化完成」→ 初始化阶段即失败。

---

## 12. 开机自启（tauri-plugin-autostart）

用官方 `tauri-plugin-autostart`，**真相源在系统**（Windows 下写 `HKCU\...\Run`），前端只同步显示。

- 注册：`run()` 里 `.plugin(tauri_plugin_autostart::init(MacosLauncher::LaunchAgent, None))`（`MacosLauncher` 参数在 Windows 下被忽略）。
- 权限：`capabilities/default.json` 的 `autostart:allow-enable` / `allow-disable` / `allow-is-enabled`（插件自带权限，非 app 自定义命令）。
- 前端：功能面板开关 → `isEnabled()` 读真实状态、`enable()` / `disable()` 切换（见 `src/LOGIC.md` 第 11 节）；**不写进 `AppConfig`**。
