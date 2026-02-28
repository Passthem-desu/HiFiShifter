# 实施计划：前端 Clip 操作优化

---

- [ ] 1. 重构 `TimelinePanel.tsx`：提取四个独立 hook
   - 新建 `components/layout/timeline/hooks/` 目录
   - 提取 `useClipDrag`：clip 拖拽移动和 Ctrl+拖拽复制逻辑
   - 提取 `useEditDrag`：trim/stretch/fade/gain 边缘拖拽逻辑
   - 提取 `useSlipDrag`：Alt+拖拽 slip-edit 逻辑
   - 提取 `useKeyboardShortcuts`：Delete、Ctrl+C/V、S 分割等快捷键逻辑
   - `TimelinePanel.tsx` 行数压缩到 600 行以内，功能行为不变
   - _需求：8.1、8.2、8.3、8.4_

- [ ] 2. 丰富右键上下文菜单（替换 `GlueContextMenu`）
   - 新建 `ClipContextMenu.tsx` 组件，支持单选和多选两种菜单模式
   - 单选菜单项：删除、静音/取消静音、重命名（触发需求3内联编辑）、复制、分割（播放头不在范围内时禁用）、颜色子菜单（emerald/blue/violet/amber）
   - 多选菜单项：删除所选、静音所选、取消静音所选、胶合（非同轨时禁用）
   - 点击菜单外部关闭菜单
   - _需求：1.1、1.2、1.3、1.4、1.5、1.6、1.7_

- [ ] 3. 实现 Clip 名称双击内联编辑
   - 修改 `ClipHeader.tsx`：名称区域双击切换为 `<input>` 输入框，自动全选内容
   - 阻止双击事件冒泡，避免触发拖拽或 seek
   - Enter / blur 提交（空字符串时保留原名），Escape 取消，均切回只读模式
   - 调用 `setClipStateRemote` 同步后端
   - 输入框样式宽度自适应 clip 宽度，与背景色保持对比度
   - _需求：2.1、2.2、2.3、2.4、2.5、2.6_

- [ ] 4. 实现 Clip 颜色乐观更新
   - 在 `sessionSlice.ts` 中新增 `optimisticUpdateClipColor` reducer，立即更新本地颜色
   - 右键菜单选色时先 dispatch 乐观更新，再异步调用 `setClipStateRemote`
   - 后端成功时以返回的 timeline 状态覆盖；失败时 dispatch 回滚 action
   - 四种颜色与现有 `--qt-highlight` CSS 变量体系对齐
   - _需求：3.1、3.2、3.3、3.4_

- [ ] 5. 改进增益调节交互
   - 修改 `ClipHeader.tsx`：增益文本区域双击弹出数值输入框（范围 -24 ~ +12 dB）
   - Enter / blur 时将输入值 clamp 后转线性增益，调用 `setClipStateRemote`；Escape 关闭不提交
   - 增益拖拽把手悬停时显示 tooltip："上下拖拽调节增益 / 双击输入精确值"
   - 保持现有垂直拖拽行为（每像素 0.25dB）不变
   - _需求：4.1、4.2、4.3、4.4、4.5_

- [ ] 6. 统一批量操作后的多选状态管理
   - 在 `timelineThunks.ts` 的批量删除 thunk 完成后，dispatch `clearMultiSelect`
   - 批量静音/取消静音完成后保持多选状态不变
   - 确认粘贴和 Ctrl+拖拽复制后自动选中新 clip 的现有行为不变
   - _需求：5.1、5.2、5.3、5.4_

- [ ] 7. 将 `createClipsRemote` 改为并行执行
   - 修改 `timelineThunks.ts` 中 `createClipsRemote`：将串行 `for...of await` 改为 `Promise.all` 并行调用
   - 保持返回值结构（`createdClipIds` 字段）与现有调用方兼容
   - 任意单个 clip 创建失败时通过 `rejectWithValue` 返回错误，已成功的不回滚
   - _需求：6.2、6.3、6.4_

- [ ] 8. 波形峰值缓存持久化到 `sessionStorage`
   - 修改 `useClipWaveformPeaks.ts`：请求前先查 `sessionStorage`（key：`hs_peaks_v1|{sourcePath}|{startSec}|{durationSec}|{columns}`），命中直接返回
   - 请求成功后将结果写入 `sessionStorage`
   - 实现简单 LRU 淘汰：条目超过 512 条时删除最旧条目
   - `sessionStorage` 写入失败时静默忽略
   - _需求：7.1、7.2、7.3、7.4_
