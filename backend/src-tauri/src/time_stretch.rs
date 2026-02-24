#[allow(dead_code)]
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum StretchAlgorithm {
    /// Current fallback: linear resampling in the time domain.
    /// NOTE: This changes pitch/formants when the ratio != 1.
    LinearResample,

    /// High-quality time-stretch (pitch-preserving) via Rubber Band Library (GPL).
    ///
    /// Implementation uses the C API (`rubberband-c.h`) loaded dynamically at runtime
    /// from `rubberband.dll`. If the DLL is missing, we fall back to `LinearResample`.
    RubberBand,

    /// Desired: zplane Elastique (Soloist) time-stretch preserving pitch + formants.
    /// This requires integrating the Elastique SDK (commercial).
    ElastiqueSoloist,
}

pub fn time_stretch_interleaved(
    input: &[f32],
    channels: usize,
    sample_rate: u32,
    out_frames: usize,
    algorithm: StretchAlgorithm,
) -> Vec<f32> {
    match algorithm {
        StretchAlgorithm::LinearResample => {
            linear_time_stretch_interleaved(input, channels, out_frames)
        }
        StretchAlgorithm::RubberBand => {
            // Rubber Band uses time ratio = out / in.
            let in_frames = if channels == 0 {
                0
            } else {
                input.len() / channels
            };
            if in_frames < 2 || out_frames < 2 {
                return linear_time_stretch_interleaved(input, channels, out_frames);
            }
            let ratio = (out_frames as f64) / (in_frames as f64);

            match crate::rubberband::try_time_stretch_interleaved_offline(
                input,
                channels,
                sample_rate.max(1),
                ratio,
                out_frames,
            ) {
                Ok(mut out) => {
                    // Ensure requested length. Rubber Band may output slightly different size.
                    let got_frames = out.len() / channels.max(1);
                    if got_frames == out_frames {
                        out
                    } else if got_frames > out_frames {
                        out.truncate(out_frames * channels);
                        out
                    } else {
                        out.resize(out_frames * channels, 0.0);
                        out
                    }
                }
                Err(e) => {
                    if std::env::var("HIFISHIFTER_DEBUG_COMMANDS").ok().as_deref() == Some("1") {
                        eprintln!("time_stretch: RubberBand unavailable, falling back: {e}");
                    }
                    linear_time_stretch_interleaved(input, channels, out_frames)
                }
            }
        }
        StretchAlgorithm::ElastiqueSoloist => {
            // TODO: integrate Elastique SDK and implement true pitch/formant-preserving stretch.
            // For now, fall back to the existing linear method to keep the app functional.
            linear_time_stretch_interleaved(input, channels, out_frames)
        }
    }
}

fn linear_time_stretch_interleaved(input: &[f32], channels: usize, out_frames: usize) -> Vec<f32> {
    if input.is_empty() || channels == 0 {
        return vec![];
    }
    let in_frames = input.len() / channels;
    if in_frames == 0 {
        return vec![];
    }
    if in_frames == out_frames {
        return input.to_vec();
    }
    if out_frames <= 1 || in_frames <= 1 {
        let mut out = vec![0.0f32; out_frames * channels];
        let copy_frames = in_frames.min(out_frames);
        out[..copy_frames * channels].copy_from_slice(&input[..copy_frames * channels]);
        return out;
    }

    let mut out = vec![0.0f32; out_frames * channels];
    let scale = (in_frames - 1) as f64 / (out_frames - 1) as f64;

    for of in 0..out_frames {
        let t_in = (of as f64) * scale;
        let i0 = t_in.floor() as usize;
        let i1 = (i0 + 1).min(in_frames - 1);
        let frac = (t_in - (i0 as f64)) as f32;
        for ch in 0..channels {
            let a = input[i0 * channels + ch];
            let b = input[i1 * channels + ch];
            out[of * channels + ch] = a + (b - a) * frac;
        }
    }

    out
}
