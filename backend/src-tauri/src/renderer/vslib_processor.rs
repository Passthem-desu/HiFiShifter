//! VslibProcessor：基于 VocalShifter vslib 的原生全链路处理器。
//!
//! 仅在 `feature = "vslib"` 下编译（VocalShifter 仅限 Windows）。
//!
//! vslib 原生支持：
//! - 时间拉伸（Timing 控制点，不需要外部 RubberBand）
//! - 共振峰偏移（formant_shift_cents）
//! - 气声强度（breathiness）
//! - 合成模式（SYNTHMODE_M / SYNTHMODE_MF / SYNTHMODE_P）
//! - 逐控制点音量、强弱、声像曲线

use super::traits::{
    ClipProcessContext, ClipProcessor, ParamDescriptor, ParamKind, ProcessorCapabilities,
};

// ─── 静态参数描述符 ───────────────────────────────────────────────────────────

static VSLIB_PARAMS: &[ParamDescriptor] = &[
    // 合成模式（按钮切换）
    ParamDescriptor {
        id: "synth_mode",
        display_name: "合成模式",
        group: "合成",
        kind: ParamKind::StaticEnum {
            options: &[
                ("单音", 0),              // SYNTHMODE_M
                ("单音+共振峰补正", 1),   // SYNTHMODE_MF（默认）
                ("和音", 2),              // SYNTHMODE_P
            ],
            default_value: 1, // SYNTHMODE_MF
        },
    },
    // 音量（AutomationCurve）
    ParamDescriptor {
        id: "volume",
        display_name: "音量",
        group: "动态",
        kind: ParamKind::AutomationCurve {
            unit: "×",
            default_value: 1.0,
            min_value: 0.0,
            max_value: 4.0,
        },
    },
    // 强弱（AutomationCurve）
    ParamDescriptor {
        id: "dyn_edit",
        display_name: "强弱",
        group: "动态",
        kind: ParamKind::AutomationCurve {
            unit: "×",
            default_value: 1.0,
            min_value: 0.0,
            max_value: 4.0,
        },
    },
    // 声像（AutomationCurve）
    ParamDescriptor {
        id: "pan",
        display_name: "声像",
        group: "动态",
        kind: ParamKind::AutomationCurve {
            unit: "",
            default_value: 0.0,
            min_value: -1.0,
            max_value: 1.0,
        },
    },
    // 共振峰偏移（AutomationCurve）
    ParamDescriptor {
        id: "formant_shift_cents",
        display_name: "共振峰偏移",
        group: "声色",
        kind: ParamKind::AutomationCurve {
            unit: "cents",
            default_value: 0.0,
            min_value: -2400.0,
            max_value: 2400.0,
        },
    },
    // 气声强度（AutomationCurve）
    ParamDescriptor {
        id: "breathiness",
        display_name: "气声",
        group: "声色",
        kind: ParamKind::AutomationCurve {
            unit: "",
            default_value: 0.0,
            min_value: -10000.0,
            max_value: 10000.0,
        },
    },
    // NOTE: eq1 / eq2 / heq 不暴露给用户。
    // NOTE: nnOffset / nnRange 由后端分析阶段固定，不在此处声明。
];

// ─── VslibProcessor ───────────────────────────────────────────────────────────

/// 仅在 `feature = "vslib"` 下可用的 vslib 原生全链路处理器。
#[cfg(feature = "vslib")]
pub struct VslibProcessor;

#[cfg(feature = "vslib")]
impl ClipProcessor for VslibProcessor {
    fn id(&self) -> &str {
        "vslib"
    }

    fn display_name(&self) -> &str {
        "VocalShifter (vslib)"
    }

    fn is_available(&self) -> bool {
        // vslib DLL 加载状态由 crate::vslib 子模块维护。
        // 此处简单返回 true（DLL 加载失败时 process() 内部会报错）。
        true
    }

    fn capabilities(&self) -> ProcessorCapabilities {
        ProcessorCapabilities {
            handles_time_stretch: true, // 使用 Timing 控制点，不需要外部 RubberBand
            supports_formant: true,
            supports_breathiness: true,
        }
    }

    fn param_descriptors(&self) -> Vec<ParamDescriptor> {
        VSLIB_PARAMS.to_vec()
    }

    fn process(&self, _ctx: &ClipProcessContext<'_>) -> Result<Vec<f32>, String> {
        // TODO: vslib 全链路实现（Phase 3 stub）
        //
        // 实现步骤：
        // 1. VslibCreateProject
        // 2. 读取 synth_mode（extra_params["synth_mode"]，默认 SYNTHMODE_MF=1）
        // 3. 将 mono_pcm 写为临时 WAV（<exe_dir>/cache/vslib_tmp/<clip_id>_<uuid>.wav）
        // 4. VslibAddItemEx(wav_path, nn_offset, nn_range, option)
        //    (nnOffset / nnRange 由后端固定，来自音高分析阶段)
        // 5. VslibSetItemInfo → 写入 synthMode
        // 6. VslibSetPitchArray（pitch_edit 每帧）
        // 7. 逐控制点 VslibSetCtrlPntInfoEx2：
        //      volume   ← extra_curves["volume"]（缺失则保持默认 1.0）
        //      dyn_edit ← extra_curves["dyn_edit"]（缺失则保持默认 1.0）
        //      pan      ← extra_curves["pan"]（缺失则保持默认 0.0）
        //      formant  ← extra_curves["formant_shift_cents"]（仅 MF/P 模式有效）
        //      breathiness ← extra_curves["breathiness"]
        // 8. 若 playback_rate != 1.0 → VslibAddTimeCtrlPnt（Timing 控制点链）
        // 9. VslibGetMixData → 读取输出 PCM
        // 10. VslibDeleteProject；删除临时 WAV
        Err("VslibProcessor::process 尚未实现（Phase 3 stub）".into())
    }
}

// ─── 静态描述符暴露（即使不启用 vslib feature 也可查询）──────────────────────

/// 返回 vslib 声码器参数描述符静态切片（供前端 UI 查询，不依赖 DLL）。
#[allow(dead_code)]
pub fn vslib_param_descriptors() -> &'static [ParamDescriptor] {
    VSLIB_PARAMS
}
