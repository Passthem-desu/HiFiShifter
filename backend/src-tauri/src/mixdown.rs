use crate::state::{Clip, TimelineState, Track};
use crate::time_stretch::{time_stretch_interleaved, StretchAlgorithm};
use hound::{SampleFormat, WavReader, WavSpec, WavWriter};
use std::collections::{HashMap, HashSet};
use std::path::Path;

#[derive(Debug, Clone)]
pub struct MixdownOptions {
    pub sample_rate: u32,
    pub start_sec: f64,
    pub end_sec: Option<f64>,
}

#[derive(Debug, Clone)]
pub struct MixdownResult {
    pub sample_rate: u32,
    pub duration_sec: f64,
}

fn beat_sec(bpm: f64) -> f64 {
    60.0 / bpm.max(1e-6)
}

fn clamp01(x: f32) -> f32 {
    if x < 0.0 {
        0.0
    } else if x > 1.0 {
        1.0
    } else {
        x
    }
}

fn clamp11(x: f32) -> f32 {
    if x < -1.0 {
        -1.0
    } else if x > 1.0 {
        1.0
    } else {
        x
    }
}

fn is_wav_path(path: &str) -> bool {
    Path::new(path)
        .extension()
        .and_then(|e| e.to_str())
        .map(|e| e.eq_ignore_ascii_case("wav"))
        .unwrap_or(false)
}

fn read_wav_f32_interleaved(path: &Path) -> Option<(u32, u16, Vec<f32>)> {
    let mut reader = WavReader::open(path).ok()?;
    let spec = reader.spec();
    if spec.sample_rate == 0 || spec.channels == 0 {
        return None;
    }

    let channels = spec.channels;
    let sample_rate = spec.sample_rate;

    // Read samples to f32 interleaved in [-1, 1].
    let mut out: Vec<f32> = Vec::with_capacity(reader.duration() as usize);

    match (spec.sample_format, spec.bits_per_sample) {
        (SampleFormat::Int, 16) => {
            for s in reader.samples::<i16>() {
                let v = s.ok()? as f32 / i16::MAX as f32;
                out.push(v);
            }
        }
        (SampleFormat::Int, 24) | (SampleFormat::Int, 32) => {
            // hound reads 24-bit packed into i32.
            for s in reader.samples::<i32>() {
                let v = s.ok()? as f32 / i32::MAX as f32;
                out.push(v);
            }
        }
        (SampleFormat::Float, 32) => {
            for s in reader.samples::<f32>() {
                out.push(s.ok()?);
            }
        }
        _ => return None,
    }

    Some((sample_rate, channels, out))
}

fn linear_resample_interleaved(
    input: &[f32],
    channels: usize,
    in_rate: u32,
    out_rate: u32,
) -> Vec<f32> {
    if input.is_empty() || channels == 0 {
        return vec![];
    }
    if in_rate == out_rate {
        return input.to_vec();
    }

    let in_frames = input.len() / channels;
    if in_frames < 2 {
        return input.to_vec();
    }

    let ratio = out_rate as f64 / in_rate as f64;
    let out_frames = ((in_frames as f64) * ratio).round().max(1.0) as usize;
    let mut out = vec![0.0f32; out_frames * channels];

    for of in 0..out_frames {
        let t_in = (of as f64) / ratio;
        let i0 = t_in.floor() as isize;
        let frac = (t_in - (i0 as f64)) as f32;
        let i0 = i0.clamp(0, (in_frames - 1) as isize) as usize;
        let i1 = (i0 + 1).min(in_frames - 1);

        for ch in 0..channels {
            let a = input[i0 * channels + ch];
            let b = input[i1 * channels + ch];
            out[of * channels + ch] = a + (b - a) * frac;
        }
    }

    out
}

fn build_parent_map(tracks: &[Track]) -> HashMap<String, Option<String>> {
    let mut map = HashMap::new();
    for t in tracks {
        map.insert(t.id.clone(), t.parent_id.clone());
    }
    map
}

fn track_lineage(track_id: &str, parent_map: &HashMap<String, Option<String>>) -> Vec<String> {
    let mut out = Vec::new();
    let mut cur = Some(track_id.to_string());
    let mut safety = 0;
    while let Some(id) = cur {
        out.push(id.clone());
        cur = parent_map.get(&id).and_then(|p| p.clone());
        safety += 1;
        if safety > 2048 {
            break;
        }
    }
    out
}

fn compute_track_gains(tracks: &[Track]) -> HashMap<String, (f32, bool, bool)> {
    let parent_map = build_parent_map(tracks);
    let by_id: HashMap<String, Track> = tracks.iter().cloned().map(|t| (t.id.clone(), t)).collect();

    let any_solo = tracks.iter().any(|t| t.solo);
    let mut out = HashMap::new();

    for t in tracks {
        let lineage = track_lineage(&t.id, &parent_map);

        let mut gain = 1.0f32;
        let mut muted = false;
        let mut soloed = false;
        for id in &lineage {
            if let Some(node) = by_id.get(id) {
                gain *= clamp01(node.volume);
                muted |= node.muted;
                soloed |= node.solo;
            }
        }

        // If any solo exists, only soloed lineages are audible.
        if any_solo {
            out.insert(t.id.clone(), (gain, muted, soloed));
        } else {
            out.insert(t.id.clone(), (gain, muted, true));
        }
    }

    out
}

fn clip_source_bounds_sec(clip: &Clip, bpm: f64) -> Option<(f64, f64)> {
    let duration_sec = clip.duration_sec?;
    if !(duration_sec.is_finite() && duration_sec > 0.0) {
        return None;
    }
    let bs = beat_sec(bpm);
    let trim_start_sec = (clip.trim_start_beat.max(0.0)) * bs;
    let trim_end_sec = (clip.trim_end_beat.max(0.0)) * bs;
    let max_end_sec = (duration_sec - trim_end_sec).max(trim_start_sec);
    Some((trim_start_sec, max_end_sec))
}

pub fn render_mixdown_wav(
    timeline: &TimelineState,
    output_path: &Path,
    opts: MixdownOptions,
) -> Result<MixdownResult, String> {
    let bpm = timeline.bpm;
    if !(bpm.is_finite() && bpm > 0.0) {
        return Err("invalid bpm".to_string());
    }

    let out_rate = opts.sample_rate.max(8000);
    let out_channels: u16 = 2;
    let bs = beat_sec(bpm);

    let project_sec = (timeline.project_beats.max(0.0)) * bs;
    let start_sec = opts.start_sec.max(0.0);
    let end_sec = opts.end_sec.unwrap_or(project_sec).max(start_sec);
    let duration_sec = (end_sec - start_sec).max(0.0);
    let out_frames = (duration_sec * out_rate as f64).round().max(1.0) as usize;
    let mut mix = vec![0.0f32; out_frames * out_channels as usize];

    let track_gain = compute_track_gains(&timeline.tracks);

    // Precompute audible tracks set.
    let mut audible_tracks: HashSet<String> = HashSet::new();
    for (tid, (_gain, muted, solo_ok)) in &track_gain {
        if !*muted && *solo_ok {
            audible_tracks.insert(tid.clone());
        }
    }

    for clip in &timeline.clips {
        if clip.muted {
            continue;
        }
        if !audible_tracks.contains(&clip.track_id) {
            continue;
        }
        let Some(source_path) = clip.source_path.as_ref() else {
            continue;
        };
        if !is_wav_path(source_path) {
            // MVP: only WAV sources are mixed.
            continue;
        }

        let (track_gain_value, _tmuted, _solo_ok) = track_gain
            .get(&clip.track_id)
            .cloned()
            .unwrap_or((1.0, false, true));
        let gain = (clip.gain.max(0.0) * track_gain_value).clamp(0.0, 4.0);
        if gain <= 0.0 {
            continue;
        }

        // Timeline placement.
        let clip_start_sec = (clip.start_beat.max(0.0)) * bs;
        let clip_timeline_len_sec = (clip.length_beats.max(0.0)) * bs;
        if !(clip_timeline_len_sec.is_finite() && clip_timeline_len_sec > 0.0) {
            continue;
        }
        let clip_end_sec = clip_start_sec + clip_timeline_len_sec;

        // Check overlap with requested render window.
        if clip_end_sec <= start_sec || clip_start_sec >= end_sec {
            continue;
        }

        // Determine source segment in seconds.
        let (src_start_sec, src_max_end_sec) = match clip_source_bounds_sec(clip, bpm) {
            Some(v) => v,
            None => continue,
        };

        let playback_rate = clip.playback_rate as f64;
        let playback_rate = if playback_rate.is_finite() && playback_rate > 0.0 {
            playback_rate
        } else {
            1.0
        };

        // Time-stretch model: timeline length is fixed; source consumed scales by playbackRate.
        let desired_src_len_sec = clip_timeline_len_sec * playback_rate;
        let src_end_sec = (src_start_sec + desired_src_len_sec).min(src_max_end_sec);
        if src_end_sec - src_start_sec <= 1e-6 {
            continue;
        }

        // Decode WAV.
        let (in_rate, in_channels, pcm) = match read_wav_f32_interleaved(Path::new(source_path)) {
            Some(v) => v,
            None => continue,
        };

        let in_channels_usize = in_channels as usize;
        let in_frames = pcm.len() / in_channels_usize;
        if in_frames < 2 {
            continue;
        }

        // Slice source by time in its own rate.
        let src_i0 = (src_start_sec * in_rate as f64).floor().max(0.0) as usize;
        let src_i1 = (src_end_sec * in_rate as f64).ceil().max(src_i0 as f64) as usize;
        let src_i1 = src_i1.min(in_frames);
        if src_i1 <= src_i0 + 1 {
            continue;
        }

        let segment = &pcm[(src_i0 * in_channels_usize)..(src_i1 * in_channels_usize)];
        let segment = linear_resample_interleaved(segment, in_channels_usize, in_rate, out_rate);

        // Convert to stereo if needed.
        let segment = if in_channels == 1 {
            let frames = segment.len();
            let mut stereo = Vec::with_capacity(frames * 2);
            for s in segment {
                stereo.push(s);
                stereo.push(s);
            }
            stereo
        } else if in_channels >= 2 {
            // Use first two channels.
            let frames = segment.len() / in_channels_usize;
            let mut stereo = Vec::with_capacity(frames * 2);
            for f in 0..frames {
                stereo.push(segment[f * in_channels_usize]);
                stereo.push(segment[f * in_channels_usize + 1]);
            }
            stereo
        } else {
            continue;
        };

        let target_frames_total = (clip_timeline_len_sec * out_rate as f64).round().max(1.0) as usize;
        let segment = time_stretch_interleaved(
            &segment,
            2,
            out_rate,
            target_frames_total,
            StretchAlgorithm::RubberBand,
        );

        // Apply fades (linear) and gain.
        let fade_in_frames = ((clip.fade_in_beats.max(0.0) * bs) * out_rate as f64)
            .round()
            .max(0.0) as usize;
        let fade_out_frames = ((clip.fade_out_beats.max(0.0) * bs) * out_rate as f64)
            .round()
            .max(0.0) as usize;

        let mut segment = segment;
        let seg_frames = segment.len() / 2;

        for f in 0..seg_frames {
            let mut g = gain;
            if fade_in_frames > 0 && f < fade_in_frames {
                g *= (f as f32 / fade_in_frames as f32).clamp(0.0, 1.0);
            }
            if fade_out_frames > 0 && f + fade_out_frames > seg_frames {
                let remain = seg_frames.saturating_sub(f);
                g *= (remain as f32 / fade_out_frames as f32).clamp(0.0, 1.0);
            }

            segment[f * 2] *= g;
            segment[f * 2 + 1] *= g;
        }

        // Mix into output, considering overlap window.
        let clip_window_start = clip_start_sec.max(start_sec);
        let clip_window_end = clip_end_sec.min(end_sec);
        let window_len_sec = (clip_window_end - clip_window_start).max(0.0);
        if window_len_sec <= 1e-9 {
            continue;
        }

        let out_offset_frames = ((clip_window_start - start_sec) * out_rate as f64).round().max(0.0) as usize;
        let seg_offset_frames = ((clip_window_start - clip_start_sec) * out_rate as f64).round().max(0.0) as usize;
        let frames_to_mix = ((window_len_sec) * out_rate as f64).round().max(0.0) as usize;

        let max_frames_to_mix = frames_to_mix
            .min(out_frames.saturating_sub(out_offset_frames))
            .min(seg_frames.saturating_sub(seg_offset_frames));
        if max_frames_to_mix == 0 {
            continue;
        }

        for f in 0..max_frames_to_mix {
            let oi = (out_offset_frames + f) * 2;
            let si = (seg_offset_frames + f) * 2;
            mix[oi] += segment[si];
            mix[oi + 1] += segment[si + 1];
        }
    }

    // Write WAV 16-bit.
    let spec = WavSpec {
        channels: out_channels,
        sample_rate: out_rate,
        bits_per_sample: 16,
        sample_format: SampleFormat::Int,
    };
    let mut writer = WavWriter::create(output_path, spec).map_err(|e| e.to_string())?;

    for s in mix {
        let v = clamp11(s);
        let i = (v * i16::MAX as f32) as i16;
        writer.write_sample(i).map_err(|e| e.to_string())?;
    }
    writer.finalize().map_err(|e| e.to_string())?;

    Ok(MixdownResult {
        sample_rate: out_rate,
        duration_sec,
    })
}
