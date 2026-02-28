## 1. 删除 breath 占位符

- [x] 1.1 修改 `frontend/src/components/layout/pianoRoll/types.ts`：将 `ParamName` 改为 `"pitch" | "tension"`，添加扩展性注释
- [x] 1.2 修改 `frontend/src/features/session/sessionTypes.ts`：将 `EditParam` 改为 `"pitch" | "tension"`，添加扩展性注释
- [x] 1.3 修改 `frontend/src/components/layout/ActionBar.tsx`：删除 `<Select.Item value="breath">` 选项
- [x] 1.4 修改 `frontend/src/components/layout/pianoRoll/usePianoRollInteractions.ts`：删除 `editParam !== "breath"` 的特判分支
- [x] 1.5 修改 `frontend/src/features/session/sessionSlice.ts`：删除 `breath: AutomationPoint[]` 字段及其初始值 `breath: []`

## 2. 音高线居中对齐

- [x] 2.1 修改 `frontend/src/components/layout/pianoRoll/render.ts`：在 `drawCurveTimed` 函数中，对 pitch 参数的值加 0.5 偏移（`param === "pitch" ? v + 0.5 : v`），使曲线绘制在琴键中心而非底边

## 3. 多参数同时显示

- [x] 3.1 修改 `frontend/src/components/layout/pianoRoll/usePianoRollData.ts`：新增 `secondaryParamView: ParamViewSegment | null` 状态，在 `refreshVisible` 和 `refreshNow` 中同时加载副参数（另一个参数的 edit 数据），返回值中包含 `secondaryParamView` 和 `setSecondaryParamView`
- [x] 3.2 修改 `frontend/src/components/layout/pianoRoll/render.ts`：`drawPianoRoll` 新增 `secondaryParamView` 和 `secondaryPitchView`/`secondaryTensionView` 参数，在主曲线之前绘制副参数 edit 曲线（pitch 副曲线用 `rgba(100, 200, 255, 0.45)`，tension 副曲线用 `rgba(255, 180, 60, 0.45)`，lineWidth 1.5）
- [x] 3.3 修改 `frontend/src/components/layout/PianoRollPanel.tsx`：从 `usePianoRollData` 取出 `secondaryParamView`，传入 `drawPianoRoll`；`drawRef.current` 中透传副参数相关参数
