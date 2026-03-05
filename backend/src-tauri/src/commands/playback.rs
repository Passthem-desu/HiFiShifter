use crate::models::PlaybackStatePayload;
use crate::state::AppState;
use std::path::Path;
use tauri::Emitter;
use tauri::State;

use super::common::{
    guard_json_command, new_temp_wav_path, ok_bool, render_timeline_to_wav, PlaybackRenderingStateEvent,
};

// ===================== playback clock =====================




pub(super) fn play_original(state: State<'_, AppState>, start_sec: f64) -> serde_json::Value {
    guard_json_command("play_original", || {
        if std::env::var("HIFISHIFTER_DEBUG_COMMANDS").ok().as_deref() == Some("1") {
            eprintln!("play_original(start_sec={})", start_sec);
        }
        let timeline = state
            .timeline
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .clone();
        let bpm = timeline.bpm;
        let playhead_sec = timeline.playhead_sec;
        if !(bpm.is_finite() && bpm > 0.0) {
            return serde_json::json!({"ok": false, "error": "invalid bpm"});
        }
        let start_sec = playhead_sec.max(0.0) + start_sec.max(0.0);

        // 检测是否有活跃的 pitch edit
        let pitch_active = crate::pitch_editing::is_pitch_edit_active(&timeline);
        let pitch_backend_ok = crate::pitch_editing::is_pitch_edit_backend_available(&timeline);
        let need_prerender = pitch_active && pitch_backend_ok;

        if !need_prerender {
            // 无 pitch edit：直接走实时 clip mixing（零延迟）
            state.audio_engine.seek_sec(start_sec);
            state.audio_engine.update_timeline(timeline);
            state.audio_engine.set_playing(true, Some("original"));
            return serde_json::json!({"ok": true, "playing": "original", "start_sec": start_sec});
        }

        // ── 有 pitch edit：Clip 级增量预渲染 + 实时混音 ──────────────────────────
        // 后台线程按时间线顺序逐 clip 渲染，第一个 clip 渲染完即开始播放
        // 播放过程中继续后台渲染后续 clip，音频回调中遇到未合成 clip 时静音等待
        if let Some(app) = state.app_handle.get().cloned() {
            let engine = state.audio_engine.clone();
            let tl_for_render = timeline.clone();
            let render_start_sec = start_sec;
            let engine_sr = state.audio_engine.sample_rate_hz();

            std::thread::spawn(move || {
                // 推送渲染开始
                let _ = app.emit(
                    "playback_rendering_state",
                    PlaybackRenderingStateEvent {
                        active: true,
                        progress: Some(0.0),
                        target: Some("original".to_string()),
                    },
                );

                // 收集需要预渲染的 clip 列表，按时间线顺序排序
                let mut clips_to_render = collect_clips_needing_render(&tl_for_render, engine_sr);
                clips_to_render.sort_by(|a, b| {
                    a.clip.start_sec.total_cmp(&b.clip.start_sec)
                });
                
                let total = clips_to_render.len().max(1);
                let mut rendered_count = 0u32;
                let mut any_error = false;
                let mut first_clip_rendered = false;

                for clip_render_info in &clips_to_render {
                    // 检查缓存是否已命中
                    {
                        let mut cache = crate::synth_clip_cache::global_rendered_clip_cache()
                            .lock()
                            .unwrap_or_else(|e| e.into_inner());
                        if cache.get(&clip_render_info.cache_key).is_some() {
                            rendered_count += 1;
                            let progress = rendered_count as f64 / total as f64;
                            let _ = app.emit(
                                "playback_rendering_state",
                                PlaybackRenderingStateEvent {
                                    active: true,
                                    progress: Some(progress),
                                    target: Some("original".to_string()),
                                },
                            );
                            
                            // 如果这是第一个clip且缓存命中，立即开始播放
                            if !first_clip_rendered {
                                first_clip_rendered = true;
                                engine.seek_sec(render_start_sec);
                                engine.update_timeline(tl_for_render.clone());
                                engine.set_playing(true, Some("original"));
                            }
                            continue;
                        }
                    }

                    // 缓存未命中：调用渲染器
                    match render_single_clip(
                        &tl_for_render,
                        &clip_render_info.clip,
                        clip_render_info.sr,
                    ) {
                        Ok(stereo_pcm) => {
                            let frames = (stereo_pcm.len() / 2) as u64;
                            let entry = crate::synth_clip_cache::RenderedClipCacheEntry {
                                pcm_stereo: std::sync::Arc::new(stereo_pcm),
                                frames,
                                sample_rate: clip_render_info.sr,
                            };
                            let mut cache = crate::synth_clip_cache::global_rendered_clip_cache()
                                .lock()
                                .unwrap_or_else(|e| e.into_inner());
                            cache.insert(clip_render_info.cache_key.clone(), entry);
                            
                            // 更新clip渲染状态为已完成
                            if let Ok(mut state_mgr) = crate::clip_rendering_state::global_clip_rendering_state().lock() {
                                state_mgr.set_state(
                                    &clip_render_info.clip.id,
                                    crate::clip_rendering_state::ClipRenderingState::Ready,
                                    1.0,
                                    None
                                );
                            }
                        }
                        Err(e) => {
                            eprintln!(
                                "play_original: clip render failed: clip_id={} err={}",
                                clip_render_info.clip.id, e
                            );
                            any_error = true;
                            
                            // 标记clip渲染失败
                            if let Ok(mut state_mgr) = crate::clip_rendering_state::global_clip_rendering_state().lock() {
                                state_mgr.set_state(
                                    &clip_render_info.clip.id,
                                    crate::clip_rendering_state::ClipRenderingState::Failed,
                                    0.0,
                                    Some(e.clone())
                                );
                            }
                        }
                    }

                    rendered_count += 1;
                    let progress = rendered_count as f64 / total as f64;
                    let _ = app.emit(
                        "playback_rendering_state",
                        PlaybackRenderingStateEvent {
                            active: true,
                            progress: Some(progress),
                            target: Some("original".to_string()),
                        },
                    );

                    // 第一个clip渲染完成后立即开始播放
                    if !first_clip_rendered {
                        first_clip_rendered = true;
                        engine.seek_sec(render_start_sec);
                        engine.update_timeline(tl_for_render.clone());
                        engine.set_playing(true, Some("original"));
                    }
                }

                // 推送渲染完成
                let _ = app.emit(
                    "playback_rendering_state",
                    PlaybackRenderingStateEvent {
                        active: false,
                        progress: Some(1.0),
                        target: Some("original".to_string()),
                    },
                );
            });
        }

        serde_json::json!({"ok": true, "playing": "original", "start_sec": start_sec, "prerendering": true})
    })
}

// ─── Clip 级预渲染辅助 ─────────────────────────────────────────────────────────

/// 需要预渲染的单个 clip 的信息。
struct ClipRenderInfo {
    clip: crate::state::Clip,
    cache_key: crate::synth_clip_cache::RenderedClipCacheKey,
    sr: u32,
}

/// 收集 timeline 中所有需要预渲染的 clip。
///
/// 返回值中只包含需要 pitch edit 的 clip。
fn collect_clips_needing_render(
    timeline: &crate::state::TimelineState,
    engine_sr: u32,
) -> Vec<ClipRenderInfo> {
    let mut out = Vec::new();
    let sr = if engine_sr > 0 { engine_sr } else { 44100 };

    for clip in &timeline.clips {
        if clip.muted {
            continue;
        }
        let Some(source_path) = clip.source_path.as_deref() else {
            continue;
        };
        
        // 使用新的检测逻辑：检查clip是否需要pitch edit
        let clip_start_sec = clip.start_sec.max(0.0);
        let needs_pitch_edit = crate::pitch_editing::does_clip_need_pitch_edit(
            timeline,
            clip,
            clip_start_sec,
        );
        
        if !needs_pitch_edit {
            continue;
        }

        let playback_rate = {
            let r = clip.playback_rate as f64;
            if r.is_finite() && r > 0.0 { r } else { 1.0 }
        };
        let start_frame = (clip.start_sec.max(0.0) * sr as f64).round().max(0.0) as u64;
        let end_frame = start_frame
            + (clip.length_sec.max(0.0) * sr as f64).round().max(1.0) as u64;

        // 获取pitch edit参数
        let Some(clip_root) = timeline.resolve_root_track_id(&clip.track_id) else {
            continue;
        };
        let entry = match timeline.params_by_root_track.get(&clip_root) {
            Some(e) => e,
            None => continue,
        };
        let pitch_edit = entry.pitch_edit.as_slice();
        let frame_period_ms = entry.frame_period_ms.max(0.1);

        let param_hash = crate::synth_clip_cache::compute_rendered_clip_hash(
            &clip.id,
            source_path,
            start_frame,
            end_frame,
            sr,
            pitch_edit,
            frame_period_ms,
            playback_rate,
        );
        let cache_key = crate::synth_clip_cache::RenderedClipCacheKey {
            clip_id: clip.id.clone(),
            param_hash,
        };

        out.push(ClipRenderInfo {
            clip: clip.clone(),
            cache_key,
            sr,
        });
    }
    out
}

/// 渲染单个 clip 的完整 stereo PCM（从源文件解码 → resample → pitch edit → stereo）。
///
/// 复用 mixdown.rs 中的解码和 resample 逻辑，通过 Renderer trait 调用 pitch edit。
fn render_single_clip(
    timeline: &crate::state::TimelineState,
    clip: &crate::state::Clip,
    out_rate: u32,
) -> Result<Vec<f32>, String> {
    let source_path = clip
        .source_path
        .as_deref()
        .ok_or_else(|| "clip has no source_path".to_string())?;

    let debug = std::env::var("HIFISHIFTER_DEBUG_COMMANDS").ok().as_deref() == Some("1");

    // 1. 解码源文件
    let (in_rate, in_channels, pcm) =
        crate::audio_utils::decode_audio_f32_interleaved(std::path::Path::new(source_path))?;
    let in_channels_usize = in_channels as usize;
    let in_frames = pcm.len() / in_channels_usize;
    if in_frames < 2 {
        return Err("source audio too short".to_string());
    }

    // 2. 源裁剪
    let playback_rate = {
        let r = clip.playback_rate as f64;
        if r.is_finite() && r > 0.0 { r } else { 1.0 }
    };
    let trim_start_sec = clip.trim_start_sec.max(0.0);
    let trim_end_sec = clip.trim_end_sec.max(0.0);
    let pre_silence_sec = (-clip.trim_start_sec).max(0.0) / playback_rate.max(1e-6);

    let total_sec = crate::mixdown::clip_duration_sec_from_wav(in_rate, in_channels, &pcm)
        .ok_or_else(|| "cannot determine clip duration".to_string())?;
    if !(total_sec.is_finite() && total_sec > 0.0) {
        return Err("invalid clip duration".to_string());
    }

    let src_end_limit_sec = (total_sec - trim_end_sec).max(trim_start_sec);
    if src_end_limit_sec - trim_start_sec <= 1e-9 {
        return Err("trimmed clip too short".to_string());
    }

    // 3. 切片 + resample
    let src_i0 = (trim_start_sec * in_rate as f64).floor().max(0.0) as usize;
    let src_i1 = ((src_end_limit_sec * in_rate as f64).ceil().max(src_i0 as f64) as usize)
        .min(in_frames);
    if src_i1 <= src_i0 + 1 {
        return Err("source slice too short".to_string());
    }

    let segment = &pcm[(src_i0 * in_channels_usize)..(src_i1 * in_channels_usize)];
    let segment =
        crate::mixdown::linear_resample_interleaved(segment, in_channels_usize, in_rate, out_rate);

    // 4. 转 stereo
    let segment = if in_channels == 1 {
        let frames = segment.len();
        let mut stereo = Vec::with_capacity(frames * 2);
        for s in segment {
            stereo.push(s);
            stereo.push(s);
        }
        stereo
    } else if in_channels >= 2 {
        let frames = segment.len() / in_channels_usize;
        let mut stereo = Vec::with_capacity(frames * 2);
        for f in 0..frames {
            stereo.push(segment[f * in_channels_usize]);
            stereo.push(segment[f * in_channels_usize + 1]);
        }
        stereo
    } else {
        return Err("unsupported channel count".to_string());
    };

    // 5. 时间拉伸（playback_rate != 1）
    let mut segment = segment;
    if (playback_rate - 1.0).abs() > 1e-6 {
        let seg_frames_in = segment.len() / 2;
        let target_frames = ((seg_frames_in as f64) / playback_rate).round().max(2.0) as usize;
        segment = crate::time_stretch::time_stretch_interleaved(
            &segment,
            2,
            out_rate,
            target_frames,
            crate::time_stretch::StretchAlgorithm::RubberBand,
        );
    }

    // 6. Pitch edit（核心：通过 Renderer trait 应用音高编辑）
    let clip_start_sec = clip.start_sec.max(0.0);
    let seg_start_sec = clip_start_sec + pre_silence_sec;
    let seg_frames = segment.len() / 2;
    if seg_frames >= 16 {
        match crate::pitch_editing::maybe_apply_pitch_edit_to_clip_segment(
            timeline,
            clip,
            clip_start_sec,
            seg_start_sec,
            out_rate,
            &mut segment,
        ) {
            Ok(true) => {
                if debug {
                    eprintln!(
                        "render_single_clip: pitch_edit applied to clip_id={}",
                        &clip.id
                    );
                }
            }
            Ok(false) => {}
            Err(e) => {
                if debug {
                    eprintln!(
                        "render_single_clip: pitch_edit error for clip_id={}: {}",
                        &clip.id, e
                    );
                }
            }
        }
    }

    // 7. 前置静音（负 trim_start 导致的 pre-silence）
    if pre_silence_sec > 1e-6 {
        let pre_frames = (pre_silence_sec * out_rate as f64).round().max(0.0) as usize;
        let mut with_silence = vec![0.0f32; pre_frames * 2];
        with_silence.extend_from_slice(&segment);
        segment = with_silence;
    }

    // 8. 截断到 clip 的时间线长度
    let clip_timeline_frames =
        (clip.length_sec.max(0.0) * out_rate as f64).round().max(1.0) as usize;
    let clip_stereo_len = clip_timeline_frames * 2;
    if segment.len() > clip_stereo_len {
        segment.truncate(clip_stereo_len);
    } else if segment.len() < clip_stereo_len {
        // 不够长时补零（正常情况下不应发生）
        segment.resize(clip_stereo_len, 0.0);
    }

    Ok(segment)
}




pub(super) fn play_synthesized(state: State<'_, AppState>, start_sec: f64) -> serde_json::Value {
    guard_json_command("play_synthesized", || {
        if std::env::var("HIFISHIFTER_DEBUG_COMMANDS").ok().as_deref() == Some("1") {
            eprintln!("play_synthesized(start_sec={})", start_sec);
        }
        let (bpm, playhead_sec) = {
            let tl = state.timeline.lock().unwrap_or_else(|e| e.into_inner());
            (tl.bpm, tl.playhead_sec)
        };
        if !(bpm.is_finite() && bpm > 0.0) {
            return serde_json::json!({"ok": false, "error": "invalid bpm"});
        }
        let start_sec = playhead_sec.max(0.0) + start_sec.max(0.0);

        let mut synthesized_path = {
            state
                .runtime
                .lock()
                .unwrap_or_else(|e| e.into_inner())
                .synthesized_wav_path
                .clone()
        };

        if synthesized_path.is_none() {
            // Render on-demand.
            let out_path = match new_temp_wav_path("synth") {
                Ok(p) => p,
                Err(e) => return serde_json::json!({"ok": false, "error": e}),
            };
            if let Err(e) = render_timeline_to_wav(&state, &out_path, 0.0, None) {
                return serde_json::json!({"ok": false, "error": e});
            }
            synthesized_path = Some(out_path.display().to_string());
            let mut rt = state.runtime.lock().unwrap_or_else(|e| e.into_inner());
            rt.has_synthesized = true;
            rt.synthesized_wav_path = synthesized_path.clone();
        }

        let Some(p) = synthesized_path.as_deref() else {
            return serde_json::json!({"ok": false, "error": "synth path missing"});
        };
        let path = Path::new(p);
        state.audio_engine.play_file(path, start_sec, "synthesized");
        serde_json::json!({"ok": true, "playing": "synthesized", "start_sec": start_sec})
    })
}




pub(super) fn stop_audio(state: State<'_, AppState>) -> serde_json::Value {
    state.audio_engine.stop();
    ok_bool()
}




pub(super) fn get_playback_state(state: State<'_, AppState>) -> PlaybackStatePayload {
    let pb = state.audio_engine.snapshot_state();
    PlaybackStatePayload {
        ok: true,
        is_playing: pb.is_playing,
        target: pb.target,
        base_sec: pb.base_sec,
        position_sec: pb.position_sec,
        duration_sec: pb.duration_sec,
    }
}
