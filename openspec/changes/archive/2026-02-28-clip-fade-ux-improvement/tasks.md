# Tasks: clip-fade-ux-improvement

## 1. 类型定义和数据层

- [x] 1.1 `paths.ts`：导出 `FadeCurveType` 类型和 `fadeCurveGain(t, curve)` 工具函数
- [x] 1.2 `paths.ts`：`fadeInAreaPath` / `fadeOutAreaPath` 新增 `curve: FadeCurveType = "sine"` 参数
- [x] 1.3 `sessionTypes.ts`：`ClipInfo` 新增 `fadeInCurve: FadeCurveType` / `fadeOutCurve: FadeCurveType` 字段（默认 `"sine"`）
- [x] 1.4 `sessionSlice.ts`：`setClipFades` action 支持 `fadeInCurve` / `fadeOutCurve`；初始化和后端映射时设置默认值

## 2. 鼠标指针优化

- [x] 2.1 `ClipItem.tsx`：fade in handle div 的 `cursor` 改为 `"col-resize"`
- [x] 2.2 `ClipItem.tsx`：fade out handle div 的 `cursor` 改为 `"col-resize"`

## 3. 可控制区与渐变区一致（视觉指示器重构）

- [x] 3.1 `ClipItem.tsx`：fade in 视觉指示器改为全区域半透明条带 + 右边缘竖线，替换原来的左上角小方块
- [x] 3.2 `ClipItem.tsx`：fade out 视觉指示器改为全区域半透明条带 + 左边缘竖线，替换原来的右上角小方块
- [x] 3.3 `ClipItem.tsx`：指示器默认 `opacity-30`（始终微弱可见），hover 时 `opacity-100`，选中时边缘线加亮

## 4. 多曲线类型支持

- [x] 4.1 `ClipItem.tsx`：`areaPathFromMinMaxBand` 新增 `fadeInCurve` / `fadeOutCurve` 参数，使用 `fadeCurveGain` 替换原有硬编码增益计算
- [x] 4.2 `ClipItem.tsx`：`waveformSvg` useMemo 中传入 `clip.fadeInCurve` / `clip.fadeOutCurve`
- [x] 4.3 `ClipItem.tsx`：fade SVG 路径渲染调用 `fadeInAreaPath` / `fadeOutAreaPath` 时传入曲线类型
- [x] 4.4 `ClipContextMenu.tsx`：新增"渐变曲线"子菜单，支持为选中 clip 的 fade in / fade out 分别选择曲线类型

## 5. 波形显示和缓存优化

- [x] 5.1 `ClipItem.tsx`：移除 preview 状态的 `strokeDasharray` 虚线，改用 `opacity` 降低（0.6）表示加载中
- [x] 5.2 `useClipWaveformPeaks.ts`：新增模块级 `ssKeySet: Set<string>` 维护已写入的 key，`ssSet` 函数使用 Set 替代遍历 sessionStorage 所有 key
