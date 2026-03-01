## Context

目前波形渲染分散在两个独立的实现中：
1. **Piano Roll** (`pianoRoll/render.ts`): 使用 Canvas 2D Context，通过 `fillRect` 绘制固定颜色的竖条，数据来源于 backend 返回的 min/max peaks
2. **Clip** (`timeline/ClipItem.tsx`): 使用 SVG path，生成闭合路径的面积填充，支持立体声双轨道和淡入淡出效果

两者数据格式相同（min/max 数组），但渲染逻辑和样式完全独立。当前项目已有主题系统，但波形样式未接入主题配置。

**约束**:
- 必须保持现有性能（Piano Roll 有大量数据点，需要自适应采样）
- Clip 的立体声双轨道布局和淡入淡出效果需保留
- 不能破坏现有的 API 和数据流

## Goals / Non-Goals

**Goals:**
- 创建统一的波形数据处理和渲染工具函数
- 消除 Piano Roll 和 Clip 之间的代码重复
- 统一波形视觉样式（颜色、透明度、描边）
- 支持主题化配置
- 保持或改进现有性能

**Non-Goals:**
- 不修改 backend 波形数据格式或 API
- 不改变 Clip 的立体声双轨道布局逻辑
- 不重构整个 Piano Roll 或 Timeline 组件架构
- 不引入新的第三方渲染库

## Decisions

### 1. 模块结构: 创建新的共享工具文件

**决策**: 在 `frontend/src/utils/` 下创建 `waveformRenderer.ts`，包含通用的波形渲染函数。

**理由**: 
- Piano Roll 和 Clip 在不同组件层级，提取到 `utils/` 可被两者引用
- 避免循环依赖（不放在 `components/shared/`）
- 与现有的 `pitch_utils.ts` 等工具文件保持一致的组织结构

**备选方案**: 
- ❌ 在 `components/layout/` 下创建共享组件 → 会导致组件层次混乱
- ❌ 在 Piano Roll 内部抽取并导出 → Clip 引用会破坏模块边界

### 2. 渲染方式: 保留双实现（Canvas + SVG）

**决策**: 提供两套渲染函数 `renderWaveformCanvas()` 和 `renderWaveformSvg()`，而不是统一为单一实现。

**理由**:
- Piano Roll 在高频重绘场景下 Canvas 性能更优（拖动、缩放）
- Clip 使用 SVG 可以利用浏览器的矢量缩放和缓存优化
- 现有实现已证明各自场景下的性能，强行统一可能降低体验
- 共享数据处理逻辑（采样、归一化）即可消除大部分重复

**备选方案**:
- ❌ 全部使用 Canvas → Clip 需要额外处理 SVG viewBox 映射
- ❌ 全部使用 SVG → Piano Roll 重绘性能降低

### 3. 样式统一: 采用 Clip 的描边+填充风格

**决策**: 将 Piano Roll 的纯填充改为类似 Clip 的"填充+描边"风格，颜色从主题系统读取。

**当前样式对比**:
- Piano Roll: 纯填充 `rgba(120,180,255,0.28)`，无描边
- Clip: 填充 `rgba(255,255,255,0.22)` + 描边 `rgba(255,255,255,0.75)`

**新统一样式**:
- 填充: `rgba(255,255,255,0.2)` （保持 Clip 的半透明白色）
- 描边: `rgba(255,255,255,0.7)` （增强边界清晰度）
- 从主题读取: `theme.waveform.fill` 和 `theme.waveform.stroke`

**理由**:
- 白色半透明在深色背景下适配性更好
- 描边可以增强波形边界识别度
- 主题化支持未来自定义配色

**备选方案**:
- ❌ 保持 Piano Roll 的蓝色 → 与 Clip 视觉不一致
- ❌ 完全去掉描边 → 降低波形边界清晰度

### 4. 数据处理: 提取公共采样和归一化逻辑

**决策**: 创建 `processWaveformPeaks()` 函数统一处理以下逻辑：
- 自适应采样（根据目标宽度调整 stride）
- 时间范围裁剪（仅处理可见区域）
- 振幅归一化和缩放

**理由**:
- 两处实现都需要相同的采样和裁剪逻辑
- 统一处理确保 Piano Roll 和 Clip 的波形密度计算一致
- 便于未来优化（如 WebWorker 异步处理大数据集）

### 5. 淡入淡出: 保留 Clip 特有逻辑

**决策**: 淡入淡出效果保留在 `ClipItem.tsx` 中，不纳入共享工具。

**理由**:
- Piano Roll 不需要淡入淡出效果（背景波形）
- Clip 的淡入淡出与 fade curve 类型（sine/linear/expo）耦合，属于业务逻辑
- 共享工具只负责"纯渲染"层，不处理业务特有的增益调制

## Risks / Trade-offs

### 风险 1: 样式统一可能引起用户不适应
**风险**: Piano Roll 用户习惯了蓝色波形，改为白色可能感到陌生。  
**缓解**: 
- 通过主题系统提供配色选项
- 在 Release Notes 中说明视觉改进

### 风险 2: 性能回归
**风险**: 抽取公共逻辑可能引入额外函数调用开销。  
**缓解**: 
- 保留现有的采样优化（stride）
- 实现后进行性能对比测试（渲染 10000+ 数据点）
- 必要时使用 `useMemo` 缓存处理结果

### 风险 3: 代码迁移引入的 bug
**风险**: 重构可能导致波形绘制错位或振幅计算错误。  
**缓解**: 
- 分阶段迁移：先 Piano Roll，再 Clip
- 保留原有实现作为参考，验证一致性后再删除
- 添加单元测试验证采样和归一化逻辑

### Trade-off: Canvas 和 SVG 双实现增加维护成本
**权衡**: 虽然保留两套渲染函数，但共享数据处理逻辑已减少 70% 的重复代码。未来如需完全统一，可以通过 OffscreenCanvas 或 Canvas-to-SVG 转换实现。

## Migration Plan

**实施顺序**:
1. 创建 `waveformRenderer.ts` 和数据处理函数（无副作用）
2. 迁移 Piano Roll: 替换渲染逻辑，验证视觉和性能
3. 迁移 Clip: 替换 SVG path 生成，保留淡入淡出
4. 添加主题配置支持
5. 移除旧代码和调试日志

**回滚策略**:
- 保留原始实现在独立分支
- 如发现性能或视觉问题，可快速 revert 单个文件
- 使用 Feature Flag 控制新旧实现切换（可选）

## Open Questions

1. **是否需要为 Clip 添加 Canvas 渲染模式？**  
   当前 Clip 数量较少（通常 <100 个），SVG 性能足够。但如果未来支持"千轨千 Clip"场景，可能需要 Canvas 降级模式。

2. **主题配置的颗粒度？**  
   是否只提供 `waveform.fill/stroke`，还是细分为 `pianoRoll.waveform` 和 `clip.waveform`？

3. **是否支持波形颜色跟随轨道颜色？**  
   部分 DAW 支持波形继承轨道配色，是否需要此特性？
