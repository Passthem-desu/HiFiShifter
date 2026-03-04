//! 澹扮爜鍣ㄧ绾挎娊璞″眰銆?
//!
//! 閫氳繃 [`VocoderPipeline`] trait 灏嗗悎鎴愰摼璺笌璋冪敤鏂硅В鑰︼紝
//! 鏈潵鏂板澹扮爜鍣ㄥ彧闇€瀹炵幇璇?trait 骞跺湪 [`get_pipeline`] 涓敞鍐岋紝
//! 鏃犻渶淇敼 `pitch_editing.rs` 绛夋牳蹇冮€昏緫銆?

use crate::state::SynthPipelineKind;

// 鈹€鈹€鈹€ 涓婁笅鏂?鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€

/// 浼犻€掔粰澹扮爜鍣ㄧ殑澶勭悊涓婁笅鏂囷紙鍊熺敤锛岄浂鎷疯礉锛夈€?
pub struct VocoderContext<'a> {
    /// 鍗曞０閬?PCM 杈撳叆锛坒32锛屽凡褰掍竴鍖栵級銆?
    pub mono_pcm: &'a [f32],
    /// 閲囨牱鐜囷紙Hz锛夈€?
    pub sample_rate: u32,
    /// 褰撳墠鐗囨鍦ㄦ椂闂磋酱涓婄殑璧峰鏃堕棿锛堢锛夈€?
    pub seg_start_sec: f64,
    /// 褰撳墠鐗囨鍦ㄦ椂闂磋酱涓婄殑缁撴潫鏃堕棿锛堢锛夈€?
    pub seg_end_sec: f64,
    /// 鎵€灞?Clip 鍦ㄦ椂闂磋酱涓婄殑璧峰鏃堕棿锛堢锛夛紝鐢ㄤ簬 MIDI 鏇茬嚎瀵归綈銆?
    pub clip_start_sec: f64,
    /// 鍒嗘瀽甯у懆鏈燂紙姣锛夈€?
    pub frame_period_ms: f64,
    /// 鍏ㄥ眬 pitch_edit 鏇茬嚎锛堢粷瀵?MIDI锛? 琛ㄧず鏃犵紪杈戯級銆?
    pub pitch_edit: &'a [f32],
    /// Clip 鍘熷 MIDI 鏇茬嚎锛堟椂闂磋酱瀵归綈锛夈€?
    pub clip_midi: &'a [f32],
    /// 鎵€灞?Clip 鐨勫敮涓€鏍囪瘑锛岀敤浜?per-segment 鎺ㄧ悊缂撳瓨銆?
    pub clip_id: &'a str,
}

// 鈹€鈹€鈹€ Trait 鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€

/// 澹扮爜鍣ㄧ绾挎帴鍙ｃ€?
///
/// 瀹炵幇鑰呭繀椤绘槸 `Send + Sync`锛屼互渚垮湪澶氱嚎绋嬫覆鏌撲腑瀹夊叏浣跨敤銆?
pub trait VocoderPipeline: Send + Sync {
    /// 杩斿洖璇ョ绾垮搴旂殑 [`SynthPipelineKind`]銆?
    fn kind(&self) -> SynthPipelineKind;

    /// 妫€鏌ュ悗绔槸鍚﹀彲鐢紙鍔ㄦ€佸簱宸插姞杞?/ ONNX 妯″瀷宸插氨缁瓑锛夈€?
    fn is_available(&self) -> bool;

    /// 瀵硅緭鍏?PCM 鎵ц闊抽珮缂栬緫锛岃繑鍥炲鐞嗗悗鐨勫崟澹伴亾 PCM銆?
    fn process(&self, ctx: &VocoderContext<'_>) -> Result<Vec<f32>, String>;
}

// 鈹€鈹€鈹€ 杈呭姪鍑芥暟锛堜緵瀹炵幇鍐呴儴浣跨敤锛夆攢鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€

/// 鍦?pitch_edit 鏇茬嚎涓彃鍊硷紝杩斿洖鐩爣 MIDI锛堟棤缂栬緫鏃惰繑鍥?None锛夈€?
fn edit_midi_at_time_or_none(
    frame_period_ms: f64,
    pitch_edit: &[f32],
    abs_time_sec: f64,
) -> Option<f64> {
    if !(abs_time_sec.is_finite() && abs_time_sec >= 0.0) {
        return None;
    }
    let fp = frame_period_ms.max(0.1);
    let idx_f = (abs_time_sec * 1000.0) / fp;
    if !(idx_f.is_finite() && idx_f >= 0.0) {
        return None;
    }
    let i0 = idx_f.floor() as isize;
    if i0 < 0 {
        return None;
    }
    let i0 = i0 as usize;
    if i0 >= pitch_edit.len() {
        return None;
    }
    let i1 = (i0 + 1).min(pitch_edit.len().saturating_sub(1));
    let frac = (idx_f - (i0 as f64)).clamp(0.0, 1.0);

    let e0 = pitch_edit.get(i0).copied().unwrap_or(0.0) as f64;
    let e1 = pitch_edit.get(i1).copied().unwrap_or(0.0) as f64;

    let e0 = if e0.is_finite() && e0 > 0.0 { Some(e0) } else { None };
    let e1 = if e1.is_finite() && e1 > 0.0 { Some(e1) } else { None };

    match (e0, e1) {
        (None, None) => None,
        (Some(v), None) | (None, Some(v)) => Some(v),
        (Some(a), Some(b)) => {
            let v = a + (b - a) * frac;
            if v.is_finite() && v > 0.0 { Some(v) } else { None }
        }
    }
}

/// 鍦?clip_midi 鏇茬嚎涓彃鍊硷紝杩斿洖鍘熷 MIDI锛堟棤鏁堟椂杩斿洖 0.0锛夈€?
fn clip_midi_at_time(
    frame_period_ms: f64,
    clip_start_sec: f64,
    clip_midi: &[f32],
    abs_time_sec: f64,
) -> f64 {
    if !(abs_time_sec.is_finite() && abs_time_sec >= clip_start_sec) {
        return 0.0;
    }
    let local_sec = abs_time_sec - clip_start_sec;
    let fp = frame_period_ms.max(0.1);
    let idx_f = (local_sec * 1000.0) / fp;
    if !(idx_f.is_finite() && idx_f >= 0.0) {
        return 0.0;
    }
    let i0 = idx_f.floor() as isize;
    if i0 < 0 {
        return 0.0;
    }
    let i0 = i0 as usize;
    if i0 >= clip_midi.len() {
        return 0.0;
    }
    let i1 = (i0 + 1).min(clip_midi.len().saturating_sub(1));
    let frac = (idx_f - (i0 as f64)).clamp(0.0, 1.0);

    let a = clip_midi.get(i0).copied().unwrap_or(0.0) as f64;
    let b = clip_midi.get(i1).copied().unwrap_or(0.0) as f64;

    let mut a = if a.is_finite() && a > 0.0 { a } else { 0.0 };
    let mut b = if b.is_finite() && b > 0.0 { b } else { 0.0 };
    if a <= 0.0 && b > 0.0 { a = b; }
    if b <= 0.0 && a > 0.0 { b = a; }
    if a <= 0.0 || b <= 0.0 { return 0.0; }

    let v = a + (b - a) * frac;
    if v.is_finite() { v } else { 0.0 }
}

// 鈹€鈹€鈹€ WorldVocoderPipeline 鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€

/// 鍩轰簬 WORLD 澹扮爜鍣ㄧ殑绠＄嚎瀹炵幇銆?
pub struct WorldVocoderPipeline;

impl VocoderPipeline for WorldVocoderPipeline {
    fn kind(&self) -> SynthPipelineKind {
        SynthPipelineKind::WorldVocoder
    }

    fn is_available(&self) -> bool {
        crate::world_vocoder::is_available()
    }

    fn process(&self, ctx: &VocoderContext<'_>) -> Result<Vec<f32>, String> {
        let f0_floor = 40.0;
        let f0_ceil = 1600.0;
        let fp = ctx.frame_period_ms;
        let clip_start = ctx.clip_start_sec;
        let pitch_edit = ctx.pitch_edit;
        let clip_midi = ctx.clip_midi;

        crate::world_vocoder::vocode_pitch_shift_chunked(
            ctx.mono_pcm,
            ctx.sample_rate,
            ctx.seg_start_sec,
            fp,
            f0_floor,
            f0_ceil,
            move |abs_time_sec| {
                let orig = clip_midi_at_time(fp, clip_start, clip_midi, abs_time_sec);
                if !(orig.is_finite() && orig > 0.0) {
                    return 0.0;
                }
                let target = match edit_midi_at_time_or_none(fp, pitch_edit, abs_time_sec) {
                    Some(v) => v,
                    None => orig,
                };
                let shift = (target - orig).clamp(-24.0, 24.0);
                if shift.is_finite() { shift } else { 0.0 }
            },
        )
    }
}

// 鈹€鈹€鈹€ NsfHifiganPipeline 鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€

/// 鍩轰簬 NSF-HiFiGAN ONNX 鐨勭绾垮疄鐜般€?
///
/// # F0 鏁版嵁婧?
///
/// `midi_at_time` 鍥炶皟涓?[`WorldVocoderPipeline`] 鍏辩敤鍚屼竴濂?F0 鏁版嵁婧愶細
/// - `clip_midi`锛氱敱 Harvest 鍒嗘瀽寰楀埌鐨勫師濮?MIDI 鏇茬嚎锛堟椂闂磋酱瀵归綈锛?
/// - `pitch_edit`锛氱敤鎴风紪杈戠殑鐩爣 MIDI 鏇茬嚎锛? 琛ㄧず鏃犵紪杈戯級
///
/// 涓ゆ潯閾捐矾鍒囨崲鏃舵棤闇€閲嶆柊鍒嗘瀽锛岀洿鎺ュ鐢ㄥ凡鏈夌殑 `clip_midi`銆?
/// 鑻?`clip_midi` 涓虹┖锛圚arvest 灏氭湭瀹屾垚锛夛紝鍒欒烦杩囨帹鐞嗗苟杩斿洖鍘熷 PCM銆?
pub struct NsfHifiganPipeline;

impl VocoderPipeline for NsfHifiganPipeline {
    fn kind(&self) -> SynthPipelineKind {
        SynthPipelineKind::NsfHifiganOnnx
    }

    fn is_available(&self) -> bool {
        crate::nsf_hifigan_onnx::is_available()
    }

    fn process(&self, ctx: &VocoderContext<'_>) -> Result<Vec<f32>, String> {
        let fp = ctx.frame_period_ms;
        let clip_start = ctx.clip_start_sec;
        let pitch_edit = ctx.pitch_edit;
        let clip_midi = ctx.clip_midi;

        // clip_midi 涓虹┖鏃舵槑纭烦杩囷紝涓?WORLD 閾捐矾琛屼负涓€鑷淬€?
        // Harvest 鍒嗘瀽灏氭湭瀹屾垚鏃?clip_midi 鍙兘涓虹┖锛屾鏃惰繑鍥炲師濮?PCM銆?
        if clip_midi.is_empty() {
            if std::env::var("HIFISHIFTER_DEBUG_COMMANDS").ok().as_deref() == Some("1") {
                eprintln!(
                    "NsfHifiganPipeline::process: clip_midi is empty (Harvest not ready?), \
                     skipping inference and returning original PCM"
                );
            }
            return Ok(ctx.mono_pcm.to_vec());
        }

        // 鈹€鈹€ 鏌ヨ per-segment 缂撳瓨 鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€
        // 鐢?clip_id + seg 鑼冨洿 + pitch_edit 鐗囨 璁＄畻 param_hash锛?
        // 瀹炵幇绂荤嚎娓叉煋璺緞鐨勬帹鐞嗙粨鏋滃鐢ㄣ€?
        let sr = ctx.sample_rate;
        let seg_start_frame = (ctx.seg_start_sec * sr as f64).round().max(0.0) as u64;
        let seg_end_frame = (ctx.seg_end_sec * sr as f64).round().max(0.0) as u64;
        let curves_snapshot = crate::pitch_editing::PitchCurvesSnapshot {
            frame_period_ms: fp,
            pitch_orig: vec![],  // 绂荤嚎璺緞涓嶉渶瑕?pitch_orig 鍙備笌 hash
            pitch_edit: pitch_edit.to_vec(),
        };
        let param_hash = crate::synth_clip_cache::compute_param_hash(
            ctx.clip_id,
            seg_start_frame,
            seg_end_frame,
            sr,
            &curves_snapshot,
        );
        let cache_key = crate::synth_clip_cache::SynthClipCacheKey {
            clip_id: ctx.clip_id.to_string(),
            param_hash,
        };

        // 鍛戒腑缂撳瓨锛氱洿鎺ヨ繑鍥?mono PCM锛堜粠 stereo 鍙栧乏澹伴亾锛?
        {
            let mut cache = crate::synth_clip_cache::global_synth_clip_cache()
                .lock()
                .unwrap_or_else(|e| e.into_inner());
            if let Some(entry) = cache.get(&cache_key) {
                let frames = (entry.pcm_stereo.len() / 2).min(ctx.mono_pcm.len());
                let mut mono_out = vec![0.0f32; ctx.mono_pcm.len()];
                for f in 0..frames {
                    mono_out[f] = entry.pcm_stereo[f * 2];
                }
                return Ok(mono_out);
            }
        }

        // 鏈懡涓細鎺ㄧ悊鍚庡啓鍏ョ紦瀛?
        // midi_at_time 鍥炶皟浣跨敤 clip_midi_at_time + edit_midi_at_time_or_none
        // 鐨勭粍鍚堥€昏緫锛屼笌 WorldVocoderPipeline 鍏辩敤鍚屼竴濂?F0 鏌ヨ璇箟銆?
        // 鍖哄埆锛歐ORLD 杩斿洖 semitone shift锛孫NNX 杩斿洖鐩爣缁濆 MIDI锛堟ā鍨嬭緭鍏ヨ涔変笉鍚岋級銆?
        let chunk_sec = crate::nsf_hifigan_onnx::env_chunk_sec();
        let overlap_sec = crate::nsf_hifigan_onnx::env_overlap_sec();

        let result = crate::nsf_hifigan_onnx::infer_pitch_edit_chunked(
            ctx.mono_pcm,
            sr,
            ctx.seg_start_sec,
            move |abs_time_sec| {
                // 鍘熷 MIDI锛堟潵鑷?Harvest锛屼笌 WORLD 閾捐矾鍏辩敤鍚屼竴鏁版嵁婧愶級
                let orig = clip_midi_at_time(fp, clip_start, clip_midi, abs_time_sec);
                if !(orig.is_finite() && orig > 0.0) {
                    return 0.0;
                }
                // 鐩爣 MIDI锛氭湁缂栬緫鏃剁敤缂栬緫鍊硷紝鍚﹀垯鐢ㄥ師濮嬪€硷紙淇濇寔闊抽珮涓嶅彉锛?
                let target = match edit_midi_at_time_or_none(fp, pitch_edit, abs_time_sec) {
                    Some(v) => v,
                    None => orig,
                };
                if target.is_finite() && target > 0.0 { target } else { 0.0 }
            },
            chunk_sec,
            overlap_sec,
        )?;

        // 鍐欏叆缂撳瓨锛坰tereo = mono 澶嶅埗鍒板弻澹伴亾锛?
        if !result.is_empty() {
            let mut stereo = Vec::with_capacity(result.len() * 2);
            for &v in &result {
                stereo.push(v);
                stereo.push(v);
            }
            let frames = result.len() as u64;
            let mut cache = crate::synth_clip_cache::global_synth_clip_cache()
                .lock()
                .unwrap_or_else(|e| e.into_inner());
            cache.insert(
                cache_key,
                crate::synth_clip_cache::SynthClipCacheEntry {
                    pcm_stereo: std::sync::Arc::new(stereo),
                    frames,
                    sample_rate: sr,
                },
            );
        }

        Ok(result)
    }
}

// 鈹€鈹€鈹€ 娉ㄥ唽琛?鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€

static WORLD_PIPELINE: WorldVocoderPipeline = WorldVocoderPipeline;
static NSF_PIPELINE: NsfHifiganPipeline = NsfHifiganPipeline;

/// 鏍规嵁 [`SynthPipelineKind`] 杩斿洖瀵瑰簲鐨勯潤鎬佺绾垮疄渚嬨€?
///
/// 浣跨敤闈欐€佸垎鍙戯紙`&'static dyn VocoderPipeline`锛夐伩鍏嶅爢鍒嗛厤锛?
/// 澹扮爜鍣ㄦ暟閲忓浐瀹氾紝闈欐€佸垎鍙戣冻澶熼珮鏁堛€?
pub fn get_pipeline(kind: SynthPipelineKind) -> &'static dyn VocoderPipeline {
    match kind {
        SynthPipelineKind::WorldVocoder => &WORLD_PIPELINE,
        SynthPipelineKind::NsfHifiganOnnx => &NSF_PIPELINE,
    }
}
