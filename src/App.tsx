import { useCallback } from "react";
import { defaultSkin } from "./lib/skins";
import { useControllers } from "./hooks/useControllers";
import { useAppConfig } from "./hooks/useAppConfig";
import { usePlans } from "./hooks/usePlans";
import { useSkins } from "./hooks/useSkins";
import { useWidgetBox } from "./hooks/useWidgetBox";
import { useEntityData } from "./hooks/useEntityData";
import { useViewState } from "./hooks/useViewState";
import { usePopupToast } from "./hooks/usePopupToast";
import { useNotificationSounds } from "./hooks/useNotificationSounds";
import FloatingWidget from "./components/FloatingWidget";
import NotePanel from "./components/NotePanel";
import SkinPanel from "./components/SkinPanel";
import SettingsPanel from "./components/SettingsPanel";
import UsagePanel from "./components/UsagePanel";
import FeaturePanel from "./components/FeaturePanel";
import PlansPanel from "./components/PlansPanel";
import ConfirmDialog from "./components/ConfirmDialog";
import PopupToast from "./components/PopupToast";

/**
 * 应用根组件：只做组合与编排——把各职责 hooks 装配起来、把数据与回调接给视图组件，
 * 不含业务逻辑。窗口形态、配置、日程、皮肤、速记/待办数据各自收在对应 hook 内。
 */
export default function App() {
  // 控制器实例（窗口 / 面板），只创建一次。
  const { windowCtl, noteWin } = useControllers();
  // 用户配置：值 + 改配置入口（持久化与 Rust 同步在 hook 内完成）。
  const {
    config,
    configRef,
    onConfigChange,
    autostartOn,
    onAutostartChange,
    onTogglePin,
    onToggleMute,
  } = useAppConfig(noteWin);
  // 日程数据与派生值（最近一项 / 未完成条数）。
  const { plans, setPlans, nearest, planCount } = usePlans();
  // 皮肤清单与当前选用。
  const { skins, skin, selectSkin } = useSkins(windowCtl);
  // 挂件容器尺寸（与窗口尺寸同源）。
  const widgetBox = useWidgetBox(config.widgetSize, skin);
  // 速记 / 待办数据层。
  const {
    tabsApi,
    catsApi,
    activeTab,
    displayTodos,
    pendingDelete,
    confirmDelete,
    cancelDelete,
    scheduleSave,
    onContentChange,
    onAddTodo,
    onToggleTodo,
    onEditTodo,
    onPriorityTodo,
    onEditTodoNote,
    onDeleteTodo,
  } = useEntityData();
  // 视图 / 窗口生命周期：形态、覆盖层开合、托盘与鼠标事件。
  const view = useViewState({ windowCtl, noteWin, configRef, widgetBox, scheduleSave });
  // 面板内提示与提示音。
  const { popupToast } = usePopupToast(view.modeRef);
  useNotificationSounds();

  // 少量跨 hook 的组合回调：把两个独立动作粘在一个入口上。
  const onSelectSkin = useCallback(
    (name: string) => {
      selectSkin(name);
      view.closeSkin();
    },
    [selectSkin, view.closeSkin],
  );
  const onPlanNotifyChange = useCallback(
    (on: boolean) => onConfigChange({ ...config, planNotify: on }),
    [config, onConfigChange],
  );
  const onPlanBadgeChange = useCallback(
    (on: boolean) => onConfigChange({ ...config, planBadge: on }),
    [config, onConfigChange],
  );

  const { skinOpen, settingsOpen, usageOpen, featuresOpen, plansOpen } = view.overlays;

  return (
    <div className="app">
      {view.mode === "expanded" ? (
        <NotePanel
          note={activeTab?.note ?? ""}
          todos={displayTodos}
          tabs={tabsApi.list}
          activeTabId={tabsApi.activeId}
          onContentChange={onContentChange}
          onAddTodo={onAddTodo}
          onToggleTodo={onToggleTodo}
          onEditTodo={onEditTodo}
          onPriorityTodo={onPriorityTodo}
          onEditTodoNote={onEditTodoNote}
          onDeleteTodo={onDeleteTodo}
          categories={catsApi.list}
          activeCategoryId={catsApi.activeId}
          onSwitchCategory={catsApi.switchTo}
          onAddCategory={catsApi.add}
          onRenameCategory={catsApi.rename}
          onDeleteCategory={catsApi.requestDelete}
          onReorderCategory={catsApi.reorder}
          pinned={config.pinned}
          onTogglePin={onTogglePin}
          muted={config.muted}
          onToggleMute={onToggleMute}
          onSwitchTab={tabsApi.switchTo}
          onAddTab={tabsApi.add}
          onRenameTab={tabsApi.rename}
          onDeleteTab={tabsApi.requestDelete}
          onReorderTab={tabsApi.reorder}
          onClose={view.closePanel}
          closing={view.closing}
          edge={view.edge}
          idleOpacity={config.idleOpacity}
          onOpenSkin={view.openSkin}
          onOpenFeatures={view.openFeatures}
          onOpenSettings={view.openSettings}
          onOpenUsage={view.openUsage}
          onOpenPlans={view.openPlans}
          plans={plans}
          onPlansChange={setPlans}
          nearest={nearest}
        />
      ) : (
        <FloatingWidget
          revealed={view.mode === "revealed" || view.dragging}
          dragging={view.dragging}
          edge={view.edge}
          planCount={config.planBadge ? planCount : 0}
          windowCtl={windowCtl}
          onOpen={view.openPanel}
          onDraggingChange={view.onDraggingChange}
          widgetWidth={widgetBox.width}
          widgetHeight={widgetBox.height}
          widgetPeek={widgetBox.peek}
          idleOpacity={config.idleOpacity}
          skin={skin ?? defaultSkin()}
          passthrough={view.passthrough}
          onContextMenu={view.openContextMenu}
          onLeave={view.onWidgetLeave}
        />
      )}

      {skinOpen && (
        <SkinPanel
          skins={skins}
          current={skin?.name ?? ""}
          onSelect={onSelectSkin}
          onClose={view.closeSkin}
        />
      )}

      {settingsOpen && (
        <SettingsPanel config={config} onChange={onConfigChange} onClose={view.closeSettings} />
      )}

      {usageOpen && (
        <UsagePanel config={config} onChange={onConfigChange} onClose={view.closeUsage} />
      )}

      {featuresOpen && (
        <FeaturePanel
          config={config}
          onChange={onConfigChange}
          autostart={autostartOn}
          onAutostartChange={onAutostartChange}
          onClose={view.closeFeatures}
        />
      )}

      {plansOpen && (
        <PlansPanel
          onChange={setPlans}
          notify={config.planNotify}
          onNotifyChange={onPlanNotifyChange}
          badge={config.planBadge}
          onBadgeChange={onPlanBadgeChange}
          onClose={view.closePlans}
        />
      )}

      {/* 只在面板展开时显示：收起后提示不该继续飘在挂件上方，但状态留着。 */}
      {view.mode === "expanded" && popupToast && (
        <PopupToast
          text={popupToast.text}
          sub={popupToast.sub}
          leaving={popupToast.leaving}
        />
      )}

      <ConfirmDialog
        open={pendingDelete !== null}
        title={pendingDelete?.kind === "category" ? "删除待办分类" : "删除浮笺"}
        message={
          pendingDelete?.kind === "category"
            ? "该分类下有待办内容，删除后不可恢复，确定删除吗？"
            : "该“浮笺”有内容，删除后不可恢复，确定删除吗？"
        }
        onConfirm={confirmDelete}
        onCancel={cancelDelete}
      />
    </div>
  );
}
