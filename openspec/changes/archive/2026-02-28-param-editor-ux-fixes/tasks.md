## 1. 副参数独立显示开关

- [x] 1.1 修改 `frontend/src/components/layout/PianoRollPanel.tsx`：新增 `secondaryParamVisible` state（`Partial<Record<ParamName, boolean>>`，默认 `{}`），新增 `toggleSecondaryParam(param: ParamName)` 函数切换开关状态
- [x] 1.2 修改 `frontend/src/components/layout/PianoRollPanel.tsx`：在 Header Bar 的参数切换按钮组中，为每个非当前 editParam 的参数按钮旁边添加眼睛图标按钮（`EyeIcon`/`EyeOffIcon`），点击调用 `toggleSecondaryParam`；当 `pitchEnabled` 为 false 时不显示 pitch 的眼睛图标
- [x] 1.3 修改 `frontend/src/components/layout/PianoRollPanel.tsx`：在 `drawRef.current` 中，将 `showSecondaryParam: secondaryParamVisible[secondaryParam] ?? false` 传入 `drawPianoRoll`
- [x] 1.4 修改 `frontend/src/components/layout/pianoRoll/render.ts`：`drawPianoRoll` 新增 `showSecondaryParam: boolean` 参数，在绘制副参数曲线前检查此开关，为 false 时跳过副参数曲线绘制

## 2. 波形预取边距扩大

- [x] 2.1 修改 `frontend/src/components/layout/pianoRoll/usePianoRollData.ts`：在 `computeVisibleRequest` 函数中，将 `const marginSec = visibleDurSec` 改为 `const marginSec = visibleDurSec * 2`，使预取范围覆盖 5 倍可见宽度

## 3. 初次导入后曲线自动显示

- [x] 3.1 修改 `frontend/src/components/layout/pianoRoll/usePianoRollData.ts`：在 `useEffect([paramsEpoch, rootTrackId])` 中，在 `setForceParamFetchToken` 之前添加 `setParamView(null)`，清除旧曲线数据，强制重新拉取
