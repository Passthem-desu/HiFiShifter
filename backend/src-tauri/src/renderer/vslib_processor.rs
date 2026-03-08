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
    RenderContext, Renderer, RendererCapabilities,
};

// ─── VslibRenderer（Renderer trait stub，仅用于 renderer_id = "vslib"）─────────
//
// `Renderer::render()` 不会在 vslib 路径上被调用（实际合成走 VslibProcessor::process()），
// 这里只实现 id() 和其他必需方法，确保 get_renderer(VocalShifterVslib).id() 返回 "vslib"，
// 而不是 "world"（否则缓存 key 会与 world 碰撞，导致 vslib 永远被命中旧 world 缓存）。

#[cfg(feature = "vslib")]
pub struct VslibRenderer;

#[cfg(feature = "vslib")]
impl Renderer for VslibRenderer {
    fn id(&self) -> &str {
        "vslib"
    }

    fn display_name(&self) -> &str {
        "VocalShifter (vslib)"
    }

    fn kind(&self) -> crate::state::SynthPipelineKind {
        crate::state::SynthPipelineKind::VocalShifterVslib
    }

    fn is_available(&self) -> bool {
        true
    }

    fn render(&self, _ctx: &RenderContext<'_>) -> Result<Vec<f32>, String> {
        // vslib 通过 VslibProcessor（ClipProcessor）渲染，不走此路径。
        Err("VslibRenderer::render() 不应被直接调用；请使用 get_processor()".to_string())
    }

    fn capabilities(&self) -> RendererCapabilities {
        RendererCapabilities {
            supports_realtime: false,
            prefers_prerender: true,
            max_pitch_shift_semitones: 24.0,
        }
    }
}

// ─── feature-gated 辅助函数 ───────────────────────────────────────────────────

/// 返回 vslib 可用的 ASCII 安全临时目录。
///
/// vslib DLL 使用 Windows ANSI API（CP_ACP）打开文件，
/// 若 %TEMP% 含非 ASCII 字符（如中文用户名），会导致 VSERR_WAVEOPEN=4。
/// 按优先级尝试：%TEMP%（ASCII） → C:\Windows\Temp（可写验证） → %TEMP%（原回退）。
#[cfg(feature = "vslib")]
fn vslib_temp_dir() -> std::path::PathBuf {
    let t = std::env::temp_dir();
    if t.to_string_lossy().bytes().all(|b| b.is_ascii()) {
        return t;
    }
    // %TEMP% 含非 ASCII 字符（常见于中文 Windows 用户名）
    // C:\Windows\Temp 在标准 Windows 上始终是 ASCII，且普通用户可创建/删除自己的文件
    let win_temp = std::path::PathBuf::from(r"C:\Windows\Temp");
    if win_temp.is_dir() {
        let probe = win_temp.join(".hs_vslib_probe");
        if std::fs::write(&probe, b"").is_ok() {
            let _ = std::fs::remove_file(&probe);
            eprintln!("[vslib] %TEMP% is non-ASCII, using C:\\Windows\\Temp instead");
            return win_temp;
        }
    }
    // 最后回退：原始 temp 路径（vslib 可能报 VSERR_WAVEOPEN）
    eprintln!("[vslib] WARNING: temp dir is non-ASCII and C:\\Windows\\Temp is not writable; vslib will likely fail");
    t
}

/// 将单声道 f32 PCM 写入临时 WAV 文件（16-bit int），返回文件路径。
#[cfg(feature = "vslib")]
fn write_temp_wav_mono(pcm: &[f32], sample_rate: u32) -> Result<std::path::PathBuf, String> {
    use hound::{SampleFormat, WavSpec, WavWriter};
    let temp_dir = vslib_temp_dir();
    let uuid = uuid::Uuid::new_v4().to_string().replace('-', "");
    let path = temp_dir.join(format!("hs_vslib_{uuid}.wav"));
    let spec = WavSpec {
        channels: 1,
        sample_rate,
        bits_per_sample: 16,
        sample_format: SampleFormat::Int,
    };
    let mut w = WavWriter::create(&path, spec)
        .map_err(|e| format!("create temp WAV: {e}"))?;
    for &s in pcm {
        w.write_sample((s.clamp(-1.0, 1.0) * 32767.0).round() as i16)
            .map_err(|e| format!("write WAV sample: {e}"))?;
    }
    w.finalize().map_err(|e| format!("finalize WAV: {e}"))?;
    Ok(path)
}

/// RAII 辅助：drop 时删除临时文件。
#[cfg(feature = "vslib")]
struct TempFileGuard(std::path::PathBuf);

#[cfg(feature = "vslib")]
impl Drop for TempFileGuard {
    fn drop(&mut self) {
        let _ = std::fs::remove_file(&self.0);
    }
}

/// 在 `curve` 中按绝对时间插值（curve[i] = i * frame_period_ms/1000 秒）。
/// 返回 `None` 表示 curve 为空或未提供，调用方应使用默认值。
#[cfg(feature = "vslib")]
fn curve_at_abs_sec(
    curve: Option<&Vec<f32>>,
    abs_sec: f64,
    frame_period_ms: f64,
) -> Option<f32> {
    let c = curve?;
    if c.is_empty() {
        return None;
    }
    let fp = frame_period_ms.max(0.1);
    let idx_f = (abs_sec * 1000.0 / fp).max(0.0);
    if !idx_f.is_finite() {
        return None;
    }
    let i0 = idx_f.floor() as usize;
    let i1 = (i0 + 1).min(c.len().saturating_sub(1));
    let frac = (idx_f - i0 as f64).clamp(0.0, 1.0) as f32;
    let a = c.get(i0).copied().unwrap_or_else(|| *c.last().unwrap());
    let b = c.get(i1).copied().unwrap_or_else(|| *c.last().unwrap());
    Some(a + (b - a) * frac)
}

#[cfg(feature = "vslib")]
fn vslib_debug_enabled() -> bool {
    std::env::var("HIFISHIFTER_DEBUG_COMMANDS").ok().as_deref() == Some("1")
}

#[cfg(feature = "vslib")]
#[derive(Clone, Copy, Debug, Default)]
struct SampleStats<T> {
    nonzero: usize,
    peak: T,
    first_nonzero: Option<usize>,
}

#[cfg(feature = "vslib")]
fn sample_stats_f32(samples: &[f32]) -> SampleStats<f32> {
    let mut stats: SampleStats<f32> = SampleStats::default();
    for (index, sample) in samples.iter().copied().enumerate() {
        if sample.abs() > 1e-6 {
            stats.nonzero += 1;
            stats.first_nonzero.get_or_insert(index);
        }
        stats.peak = stats.peak.max(sample.abs());
    }
    stats
}

#[cfg(feature = "vslib")]
fn sample_stats_i16(samples: &[i16]) -> SampleStats<i16> {
    let mut stats: SampleStats<i16> = SampleStats::default();
    for (index, sample) in samples.iter().copied().enumerate() {
        if sample != 0 {
            stats.nonzero += 1;
            stats.first_nonzero.get_or_insert(index);
        }
        let abs = sample.saturating_abs();
        if abs > stats.peak {
            stats.peak = abs;
        }
    }
    stats
}

#[cfg(feature = "vslib")]
fn stereo_channel_stats(buf_stereo: &[i16]) -> (SampleStats<i16>, SampleStats<i16>) {
    let mut left = Vec::with_capacity(buf_stereo.len() / 2);
    let mut right = Vec::with_capacity(buf_stereo.len() / 2);
    for frame in buf_stereo.chunks_exact(2) {
        left.push(frame[0]);
        right.push(frame[1]);
    }
    (sample_stats_i16(&left), sample_stats_i16(&right))
}

#[cfg(feature = "vslib")]
fn stereo_i16_to_mono_f32(buf_stereo: &[i16]) -> Vec<f32> {
    let (left_stats, right_stats) = stereo_channel_stats(buf_stereo);
    let use_right_only = left_stats.nonzero == 0 && right_stats.nonzero > 0;
    let use_left_only = right_stats.nonzero == 0 && left_stats.nonzero > 0;

    buf_stereo
        .chunks_exact(2)
        .map(|frame| {
            let left = frame[0] as f32 / 32768.0;
            let right = frame[1] as f32 / 32768.0;
            if use_right_only {
                right
            } else if use_left_only {
                left
            } else {
                (left + right) * 0.5
            }
        })
        .collect()
}

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

    fn process(&self, ctx: &ClipProcessContext<'_>) -> Result<Vec<f32>, String> {
        use std::ffi::{c_int, CString};
        use crate::vslib::{
            check, VsProject,
            VslibAddItemEx, VslibSetItemInfo, VslibSetPitchArray,
            VslibGetCtrlPntInfoEx2, VslibSetCtrlPntInfoEx2,
            VslibAddTimeCtrlPnt, VslibGetMixData,
            VslibGetProjectInfo, VslibSetProjectInfo, VslibGetVersion,
            VSCPINFOEX2, VSPRJINFO,
            SYNTHMODE_MF, ANALYZE_OPTION_VOCAL_SHIFTER,
        };

        if ctx.mono_pcm.is_empty() {
            return Ok(vec![0.0f32; ctx.out_frames]);
        }

        // ── 1. 写入临时 WAV（单声道 16-bit）──────────────────────────────────
        let wav_path = write_temp_wav_mono(ctx.mono_pcm, ctx.sample_rate)?;
        let _guard = TempFileGuard(wav_path.clone());
        let debug = vslib_debug_enabled();

        let input_stats = sample_stats_f32(ctx.mono_pcm);
        let dll_version = unsafe { VslibGetVersion() };
        eprintln!(
            "[vslib] begin clip_id={} sr={} in_frames={} out_frames={} seg_start={:.3}s rate={:.3} frame_period_ms={:.3} pitch_frames={} input_nonzero={} input_peak={:.6} dll_version={} temp_wav={}",
            ctx.clip_id,
            ctx.sample_rate,
            ctx.mono_pcm.len(),
            ctx.out_frames,
            ctx.seg_start_sec,
            ctx.playback_rate,
            ctx.frame_period_ms,
            ctx.pitch_edit.len(),
            input_stats.nonzero,
            input_stats.peak,
            dll_version,
            wav_path.display(),
        );

        // vslib 期望 Windows ANSI 路径；对于纯 ASCII 路径 UTF-8 == ANSI。
        // 如果路径含非 ASCII 字符，CString::new 本身不失败，但 vslib 可能打不开文件。
        let path_str = wav_path.to_string_lossy();
        let c_path = CString::new(path_str.as_ref())
            .map_err(|_| "vslib: 临时 WAV 路径含非法字符（null byte）".to_string())?;

        // ── 2. 创建项目（RAII，drop 时自动 VslibDeleteProject）──────────────
        let proj = VsProject::create()
            .map_err(|e| format!("VslibCreateProject: {e}"))?;

        // ── 2b. 设置项目采样率（必须在 VslibAddItemEx 之前，否则返回 VSERR_FREQ=6）──
        //  vslib 项目默认 sampFreq=0，需要显式设置为 WAV 文件的采样率，
        //  否则内部分析频率计算失败。
        {
            let mut prj_info = unsafe { std::mem::zeroed::<VSPRJINFO>() };
            check(unsafe { VslibGetProjectInfo(proj.0, &mut prj_info) })
                .map_err(|e| format!("VslibGetProjectInfo: {e}"))?;
            prj_info.sampFreq = ctx.sample_rate as c_int;
            check(unsafe { VslibSetProjectInfo(proj.0, &mut prj_info) })
                .map_err(|e| format!("VslibSetProjectInfo: {e}"))?;
            if debug {
                eprintln!(
                    "[vslib] project_info: master_volume={:.3} samp_freq={}",
                    prj_info.masterVolume,
                    prj_info.sampFreq,
                );
            }
        }

        // ── 3. 加载 WAV 并全量分析（vslib 原生引擎）──────────────────────────
        //  nnOffset=36(C2)、nnRange=60(5 octaves to C7)——覆盖全部人声 MIDI 范围。
        //  C2(~65Hz) 起始可覆盖 bass/baritone 男声，nnRange=60 到 C7 覆盖女高音。
        //  原 nnOffset=48(C3) 会漏掉大部分男声基频（男声 F0 可低至 C2~E2）。
        let mut item_num: c_int = 0;
        check(unsafe {
            VslibAddItemEx(
                proj.0,
                c_path.as_ptr(),
                &mut item_num,
                36,  // nnOffset = C2 (MIDI 36, ~65 Hz)
                60,  // nnRange  = 5 octaves → C2..C7
                ANALYZE_OPTION_VOCAL_SHIFTER,
            )
        })
        .map_err(|e| format!("VslibAddItemEx: {e}"))?;

        // ── 4. 读取 item 元信息 ───────────────────────────────────────────────
        let mut info = proj
            .item_info(item_num)
            .map_err(|e| format!("VslibGetItemInfo: {e}"))?;
        let ctrl_pnt_num = info.ctrlPntNum;
        let ctrl_pnt_ps = info.ctrlPntPs;
        let sample_org = info.sampleOrg;

        eprintln!(
            "[vslib] item_info: item_num={} sample_org={} sample_edit={} ctrl_pnt_num={} ctrl_pnt_ps={} synth_mode={} track_num={} offset={} channel={}",
            item_num,
            info.sampleOrg,
            info.sampleEdit,
            info.ctrlPntNum,
            info.ctrlPntPs,
            info.synthMode,
            info.trackNum,
            info.offset,
            info.channel,
        );

        // 分析结果合法性检查：若 VocalShifter 引擎未能识别出任何控制点，
        // 后续 VslibGetMixSample 会返回 0，合成无法进行。
        if ctrl_pnt_num <= 0 || ctrl_pnt_ps <= 0 {
            return Err(format!(
                "vslib VocalShifter 分析未产生控制点 \
                 (ctrlPntNum={ctrl_pnt_num}, ctrlPntPs={ctrl_pnt_ps})。\
                 可能原因：音频过短、nnOffset 超出实际音高范围或 WAV 格式不支持"
            ));
        }

        // ── 5. 写入合成模式（SYNTHMODE_M / MF / P）───────────────────────────
        let synth_mode = ctx
            .extra_params
            .get("synth_mode")
            .copied()
            .map(|v| v as c_int)
            .unwrap_or(SYNTHMODE_MF);
        info.synthMode = synth_mode;
        check(unsafe { VslibSetItemInfo(proj.0, item_num, &mut info) })
            .map_err(|e| format!("VslibSetItemInfo: {e}"))?;
        eprintln!(
            "[vslib] synth_mode_applied: item_num={} synth_mode={}",
            item_num,
            synth_mode,
        );

        // ── 6. 批量写入目标音高（覆盖 vslib 自带分析结果）────────────────────
        //  ctx.pitch_edit[i] 为 timeline 时间索引的 MIDI（60.0 = C4），值 > 0 表示用户设定目标
        //  vslib pitData 单位 = MIDI*100（6000=C4），0 表示保留 vslib 自身分析音高
        //
        //  注意：VslibSetPitchArray 操作的是源音频时间轴（item 内部时间），
        //  而 ctx.pitch_edit 是 timeline 时间轴（已经过 playback_rate 拉伸）。
        //  源音频帧 k 对应 timeline 位置 = seg_start_sec + k*fp/playback_rate。
        if !ctx.pitch_edit.is_empty() && ctx.frame_period_ms > 0.0 {
            let frame_period_sec = ctx.frame_period_ms / 1000.0;
            // 源音频时长（n_frames 必须覆盖源音频，不能用输出时长）
            let source_dur_sec = ctx.mono_pcm.len() as f64 / ctx.sample_rate.max(1) as f64;
            let n_frames = ((source_dur_sec / frame_period_sec).ceil() as usize + 2)
                .min(ctx.pitch_edit.len());
            if n_frames > 0 {
                let playback_rate = ctx.playback_rate.max(1e-6);
                let mut pit_data: Vec<c_int> = (0..n_frames)
                    .map(|k| {
                        // 源帧 k → timeline 绝对时间
                        let timeline_sec =
                            ctx.seg_start_sec + (k as f64) * frame_period_sec / playback_rate;
                        let edit_idx =
                            (timeline_sec / frame_period_sec).floor().max(0.0) as usize;
                        let v = ctx.pitch_edit.get(edit_idx).copied().unwrap_or(0.0);
                        if v > 0.0 {
                            (v * 100.0).round() as c_int
                        } else {
                            0
                        }
                    })
                    .collect();
                if debug {
                    let nonzero = pit_data.iter().filter(|&&v| v != 0).count();
                    let first_nonzero = pit_data.iter().position(|&v| v != 0);
                    let min_pitch = pit_data.iter().copied().filter(|&v| v != 0).min();
                    let max_pitch = pit_data.iter().copied().filter(|&v| v != 0).max();
                    eprintln!(
                        "[vslib] pitch_array: clip_id={} seg_start={:.3}s n_frames={} source_dur={:.3}s rate={:.3} nonzero={} first_nonzero={:?} min={:?} max={:?} first={:?} last={:?}",
                        ctx.clip_id,
                        ctx.seg_start_sec,
                        n_frames,
                        source_dur_sec,
                        playback_rate,
                        nonzero,
                        first_nonzero,
                        min_pitch,
                        max_pitch,
                        pit_data.first().copied(),
                        pit_data.last().copied(),
                    );
                }
                check(unsafe {
                    VslibSetPitchArray(
                        proj.0,
                        item_num,
                        pit_data.as_mut_ptr(),
                        pit_data.len() as c_int,
                        frame_period_sec,
                    )
                })
                .map_err(|e| format!("VslibSetPitchArray: {e}"))?;
            }
        }

        // ── 7. 逐控制点写入 volume / dyn_edit / pan / formant / breathiness ──
        let has_curves = ctx.extra_curves.values().any(|v| !v.is_empty());
        if has_curves && ctrl_pnt_num > 0 && ctrl_pnt_ps > 0 {
            let cp_interval_sec = 1.0 / (ctrl_pnt_ps as f64);
            let fp = ctx.frame_period_ms;
            let seg_start = ctx.seg_start_sec;

            let volume_c = ctx.extra_curves.get("volume");
            let dyn_c = ctx.extra_curves.get("dyn_edit");
            let pan_c = ctx.extra_curves.get("pan");
            let formant_c = ctx.extra_curves.get("formant_shift_cents");
            let breathiness_c = ctx.extra_curves.get("breathiness");
            let sample_points = [0, ctrl_pnt_num / 2, ctrl_pnt_num - 1];

            for pnt in 0..ctrl_pnt_num {
                let at_abs = seg_start + (pnt as f64) * cp_interval_sec;
                let mut cp2 = unsafe { std::mem::zeroed::<VSCPINFOEX2>() };
                if check(unsafe {
                    VslibGetCtrlPntInfoEx2(proj.0, item_num, pnt, &mut cp2)
                })
                .is_err()
                {
                    continue;
                }

                if let Some(v) = curve_at_abs_sec(volume_c, at_abs, fp) {
                    cp2.volume = v as f64;
                }
                if let Some(v) = curve_at_abs_sec(dyn_c, at_abs, fp) {
                    cp2.dynEdit = v as f64;
                }
                if let Some(v) = curve_at_abs_sec(pan_c, at_abs, fp) {
                    cp2.pan = v as f64;
                }
                if let Some(v) = curve_at_abs_sec(formant_c, at_abs, fp) {
                    // formant_shift_cents 单位与 vslib VSCPINFOEX2.formant 单位相同（cent）
                    cp2.formant = v.round() as c_int;
                }
                if let Some(v) = curve_at_abs_sec(breathiness_c, at_abs, fp) {
                    cp2.breathiness = v.round() as c_int;
                }

                let _ = check(unsafe {
                    VslibSetCtrlPntInfoEx2(proj.0, item_num, pnt, &mut cp2)
                });

                if debug && sample_points.contains(&pnt) {
                    eprintln!(
                        "[vslib] ctrl_pnt[{}]: abs={:.3}s pit_edit={} pit_flag={} volume={:.3} dyn={:.3} pan={:.3} formant={} breathiness={}",
                        pnt,
                        at_abs,
                        cp2.pitEdit,
                        cp2.pitFlgEdit,
                        cp2.volume,
                        cp2.dynEdit,
                        cp2.pan,
                        cp2.formant,
                        cp2.breathiness,
                    );
                }
            }
        }

        // ── 8. Timing 控制点（时间拉伸）──────────────────────────────────────
        //  VslibAddTimeCtrlPnt 的 time1/time2 单位为毫秒（ms）。
        //  time1 = 音频总时长（ms），time2 = time1 / playback_rate（输出时长 ms）。
        //  playback_rate > 1 → 压缩（更少输出 ms），< 1 → 拉伸（更多输出 ms）。
        //  注意：即使此步骤失败也不中止，后续步骤仍可产生音高变化后的音频（不带时间拉伸）。
        if (ctx.playback_rate - 1.0).abs() > 1e-6 && sample_org > 0 {
            let sr = ctx.sample_rate.max(1) as f64;
            let source_ms = (sample_org as f64 * 1000.0 / sr).round() as c_int;
            let time2 = (source_ms as f64 / ctx.playback_rate).round() as c_int;
            eprintln!(
                "[vslib] time_stretch: clip_id={} sample_org={} source_ms={} time2={} rate={:.3}",
                ctx.clip_id, sample_org, source_ms, time2, ctx.playback_rate
            );
            if source_ms > 0 && time2 > 0 {
                if let Err(e) = check(unsafe {
                    VslibAddTimeCtrlPnt(proj.0, item_num, source_ms, time2)
                }) {
                    eprintln!(
                        "[vslib] WARNING: VslibAddTimeCtrlPnt({source_ms}, {time2}): {e} — time stretch skipped"
                    );
                }
            }
        }

        // ── 9. 获取输出帧数（触发 vslib 内部计算）──────────────────────────
        //  VslibGetMixSample 返回每声道帧数（frame count per channel），
        //  与 VSITEMINFO.sampleOrg 单位相同，与输出声道数无关。
        let mix_frames = proj
            .mix_sample()
            .map_err(|e| format!("VslibGetMixSample: {e}"))?;
        if mix_frames <= 0 {
            return Err("VslibGetMixSample returned 0 frames".into());
        }

        // ── 10. 读取混音 PCM（立体声 16-bit，与 sample1.c 一致）────────────────
        //  vslib 唯一经文档验证的输出模式是 channel=2（参考 sample1.c）。
        //
        //  关键：VslibGetMixData 的 size 参数是每声道帧数（frame count per channel），
        //  与 VslibGetMixSample 返回值单位相同。vslib 内部将 size × channel 转换为
        //  实际写入的 i16 数：size * 2 = mix_frames * 2 个 i16。
        //
        //  因此缓冲区需分配 mix_frames * 2 个 i16，但传给 size 只能是 mix_frames（帧数）。
        //  传 mix_frames * 2 会让 vslib 写入 (mix_frames * 2) * 2 = mix_frames * 4 个 i16
        //  → 越界写堆 → STATUS_HEAP_CORRUPTION (0xc0000374)。
        let mut buf_stereo = vec![0i16; (mix_frames as usize) * 2];
        check(unsafe {
            VslibGetMixData(
                proj.0,
                buf_stereo.as_mut_ptr() as *mut std::ffi::c_void,
                16,          // bit depth
                2,           // channel=2（立体声，与 sample1.c 一致）
                0,           // start（帧索引）
                mix_frames,  // size = 帧数（每声道），vslib 内部 × channel → 总 i16 数
            )
        })
        .map_err(|e| format!("VslibGetMixData(stereo): {e}"))?;

        let (left_stats, right_stats) = stereo_channel_stats(&buf_stereo);
        eprintln!(
            "[vslib] mix_data: mix_frames={} buf_i16={} left_nonzero={} left_peak={} left_first_nonzero={:?} right_nonzero={} right_peak={} right_first_nonzero={:?}",
            mix_frames,
            buf_stereo.len(),
            left_stats.nonzero,
            left_stats.peak,
            left_stats.first_nonzero,
            right_stats.nonzero,
            right_stats.peak,
            right_stats.first_nonzero,
        );
        if left_stats.nonzero == 0 && right_stats.nonzero > 0 {
            eprintln!(
                "[vslib] WARNING: left channel is silent while right channel has audio; downmix will use right channel"
            );
        } else if right_stats.nonzero == 0 && left_stats.nonzero > 0 {
            eprintln!(
                "[vslib] WARNING: right channel is silent while left channel has audio"
            );
        } else if left_stats.nonzero == 0 && right_stats.nonzero == 0 {
            eprintln!(
                "[vslib] WARNING: mix output is fully silent despite successful VslibGetMixData"
            );
        }

        // ── 11. 立体声 i16 → 单声道 f32，并对齐到 ctx.out_frames ──────────────
        //  默认使用双声道平均；如果某一侧完全静音，则退化为非静音侧，避免只取左声道时把有效输出吞掉。
        let mut out = stereo_i16_to_mono_f32(&buf_stereo);
        // trim / zero-pad：保证输出长度与调用方期望一致
        match out.len().cmp(&ctx.out_frames) {
            std::cmp::Ordering::Greater => out.truncate(ctx.out_frames),
            std::cmp::Ordering::Less => out.resize(ctx.out_frames, 0.0),
            std::cmp::Ordering::Equal => {}
        }

        let out_stats = sample_stats_f32(&out);
        eprintln!(
            "[vslib] mono_out: frames={} nonzero={} peak={:.6} first_nonzero={:?}",
            out.len(),
            out_stats.nonzero,
            out_stats.peak,
            out_stats.first_nonzero,
        );

        Ok(out)
    }
}

// ─── 静态描述符暴露（即使不启用 vslib feature 也可查询）──────────────────────

/// 返回 vslib 声码器参数描述符静态切片（供前端 UI 查询，不依赖 DLL）。
#[allow(dead_code)]
pub fn vslib_param_descriptors() -> &'static [ParamDescriptor] {
    VSLIB_PARAMS
}

#[cfg(all(test, feature = "vslib"))]
mod tests {
    use super::stereo_i16_to_mono_f32;

    #[test]
    fn stereo_to_mono_preserves_right_only_signal() {
        let mono = stereo_i16_to_mono_f32(&[0, 12000, 0, -12000]);
        assert_eq!(mono.len(), 2);
        assert!((mono[0] - (12000.0 / 32768.0)).abs() < 1e-6);
        assert!((mono[1] - (-12000.0 / 32768.0)).abs() < 1e-6);
    }

    #[test]
    fn stereo_to_mono_averages_balanced_channels() {
        let mono = stereo_i16_to_mono_f32(&[10000, 10000, -8000, -8000]);
        assert_eq!(mono.len(), 2);
        assert!((mono[0] - (10000.0 / 32768.0)).abs() < 1e-6);
        assert!((mono[1] - (-8000.0 / 32768.0)).abs() < 1e-6);
    }
}
