//! 通用 per-clip 合成结果缓存（WORLD / ONNX 共享）。
//!
//! 以 `(clip_id, param_hash)` 为 key，缓存合成结果（stereo interleaved PCM）。
//! 参数不变时直接复用缓存，避免重复合成；参数变化时自动失效并重新合成。
//!
//! # 设计
//! - 进程级全局 `Mutex<SynthClipCache>`，实时路径与离线路径共享
//! - LRU 淘汰，容量上限 64 个 clip
//! - `param_hash` 使用 FNV-1a 64-bit，覆盖 clip 时间参数 + pitch_edit 曲线片段

use std::collections::{HashMap, VecDeque};
use std::sync::{Mutex, OnceLock};
use std::sync::Arc;

use crate::pitch_editing::PitchCurvesSnapshot;

// ─── 缓存容量 ──────────────────────────────────────────────────────────────────

const DEFAULT_CAPACITY: usize = 64;

// ─── Key / Entry ───────────────────────────────────────────────────────────────

/// 缓存 key：clip 唯一标识 + 参数哈希。
#[derive(Debug, Clone, PartialEq, Eq, Hash)]
pub struct SynthClipCacheKey {
    pub clip_id: String,
    pub param_hash: u64,
}

/// 缓存 entry：合成结果（stereo interleaved PCM）。
#[derive(Debug, Clone)]
pub struct SynthClipCacheEntry {
    /// Stereo interleaved PCM，长度 = `frames * 2`。
    pub pcm_stereo: Arc<Vec<f32>>,
    /// 有效帧数。
    pub frames: u64,
    /// 采样率（Hz）。
    pub sample_rate: u32,
}

// ─── Cache ─────────────────────────────────────────────────────────────────────

/// LRU 缓存，存储 per-clip 合成结果（WORLD 和 ONNX 共享）。
pub struct SynthClipCache {
    inner: HashMap<SynthClipCacheKey, SynthClipCacheEntry>,
    /// 按访问顺序排列的 key 列表（front = 最近使用，back = 最久未使用）。
    order: VecDeque<SynthClipCacheKey>,
    capacity: usize,
}

impl SynthClipCache {
    /// 创建指定容量的缓存。
    pub fn new(capacity: usize) -> Self {
        Self {
            inner: HashMap::with_capacity(capacity),
            order: VecDeque::with_capacity(capacity),
            capacity: capacity.max(1),
        }
    }

    /// 查询缓存。命中时将 key 移到 front（最近使用）。
    pub fn get(&mut self, key: &SynthClipCacheKey) -> Option<&SynthClipCacheEntry> {
        if !self.inner.contains_key(key) {
            return None;
        }
        // 将命中的 key 移到 front
        if let Some(pos) = self.order.iter().position(|k| k == key) {
            let k = self.order.remove(pos).unwrap();
            self.order.push_front(k);
        }
        self.inner.get(key)
    }

    /// 插入缓存。若已满则淘汰最久未使用的 entry。
    pub fn insert(&mut self, key: SynthClipCacheKey, entry: SynthClipCacheEntry) {
        if self.inner.contains_key(&key) {
            // 更新已有 entry，移到 front
            self.inner.insert(key.clone(), entry);
            if let Some(pos) = self.order.iter().position(|k| k == &key) {
                let k = self.order.remove(pos).unwrap();
                self.order.push_front(k);
            }
            return;
        }

        // 容量已满时淘汰 back（最久未使用）
        while self.inner.len() >= self.capacity {
            if let Some(evict_key) = self.order.pop_back() {
                self.inner.remove(&evict_key);
            } else {
                break;
            }
        }

        self.order.push_front(key.clone());
        self.inner.insert(key, entry);
    }

    /// 使指定 clip_id 的所有缓存失效（不论 param_hash）。
    pub fn invalidate(&mut self, clip_id: &str) {
        let keys_to_remove: Vec<SynthClipCacheKey> = self
            .inner
            .keys()
            .filter(|k| k.clip_id == clip_id)
            .cloned()
            .collect();
        for k in &keys_to_remove {
            self.inner.remove(k);
            if let Some(pos) = self.order.iter().position(|o| o == k) {
                self.order.remove(pos);
            }
        }
    }

    /// 清空所有缓存。
    #[allow(dead_code)]
    pub fn clear(&mut self) {
        self.inner.clear();
        self.order.clear();
    }

    /// 当前缓存条目数。
    #[allow(dead_code)]
    pub fn len(&self) -> usize {
        self.inner.len()
    }
}

// ─── 全局实例 ──────────────────────────────────────────────────────────────────

static GLOBAL_SYNTH_CLIP_CACHE: OnceLock<Mutex<SynthClipCache>> = OnceLock::new();

/// 获取进程级全局合成 clip 缓存。
///
/// 首次调用时初始化，容量为 [`DEFAULT_CAPACITY`]（64）。
/// WORLD 和 ONNX 共享同一个缓存实例。
pub fn global_synth_clip_cache() -> &'static Mutex<SynthClipCache> {
    GLOBAL_SYNTH_CLIP_CACHE.get_or_init(|| Mutex::new(SynthClipCache::new(DEFAULT_CAPACITY)))
}

// ─── param_hash 计算 ───────────────────────────────────────────────────────────

/// 计算 clip 的参数哈希（FNV-1a 64-bit）。
///
/// 输入覆盖：
/// - `clip_id`：clip 唯一标识
/// - `start_frame` / `end_frame`：clip 在时间轴上的帧范围
/// - `sr`：采样率
/// - `pitch_edit` 曲线中与 clip 时间范围重叠的片段
///
/// 任意参数变化 → hash 变化 → 缓存失效 → 重新合成。
pub fn compute_param_hash(
    clip_id: &str,
    start_frame: u64,
    end_frame: u64,
    sr: u32,
    curves: &PitchCurvesSnapshot,
) -> u64 {
    // FNV-1a 64-bit 初始值
    let mut h: u64 = 14695981039346656037u64;

    macro_rules! mix_bytes {
        ($bytes:expr) => {
            for &b in $bytes {
                h ^= b as u64;
                h = h.wrapping_mul(1099511628211u64);
            }
        };
    }

    mix_bytes!(clip_id.as_bytes());
    mix_bytes!(&start_frame.to_le_bytes());
    mix_bytes!(&end_frame.to_le_bytes());
    mix_bytes!(&sr.to_le_bytes());

    // 混入与 clip 时间范围重叠的 pitch_edit 曲线片段
    let fp = curves.frame_period_ms.max(0.1);
    let start_sec = start_frame as f64 / sr.max(1) as f64;
    let end_sec = end_frame as f64 / sr.max(1) as f64;
    let start_idx = ((start_sec * 1000.0) / fp).floor().max(0.0) as usize;
    let end_idx = ((end_sec * 1000.0) / fp).ceil().max(0.0) as usize;

    let edit = &curves.pitch_edit;
    let lo = start_idx.min(edit.len());
    let hi = end_idx.min(edit.len());
    for &v in &edit[lo..hi] {
        mix_bytes!(&v.to_bits().to_le_bytes());
    }

    h
}

// ─── 整 Clip 渲染缓存（Phase 2: Clip 级预渲染 + 实时混音）────────────────────

/// 整 Clip 渲染缓存的容量上限。
const RENDERED_CLIP_CAPACITY: usize = 128;

/// 整 Clip 渲染缓存的 key。
#[derive(Debug, Clone, PartialEq, Eq, Hash)]
pub struct RenderedClipCacheKey {
    pub clip_id: String,
    /// 综合参数哈希（覆盖 pitch_edit + source_path + trim + playback_rate）。
    pub param_hash: u64,
}

/// 整 Clip 渲染缓存的 entry：预渲染后的完整 clip stereo PCM。
#[derive(Debug, Clone)]
pub struct RenderedClipCacheEntry {
    /// Stereo interleaved PCM（从 clip local frame 0 开始），长度 = clip_frames * 2。
    pub pcm_stereo: Arc<Vec<f32>>,
    /// clip 帧数。
    pub frames: u64,
    /// 采样率（Hz）。
    pub sample_rate: u32,
}

/// 整 Clip 渲染结果的 LRU 缓存。
///
/// 与 [`SynthClipCache`]（per-segment）共存，用于 Clip 级预渲染缓存。
/// audio callback 中通过 `EngineClip.rendered_pcm` 直接读取，不经过此缓存。
/// 此缓存主要在 `build_snapshot` 阶段查询并填充 `rendered_pcm`。
pub struct RenderedClipCache {
    inner: HashMap<RenderedClipCacheKey, RenderedClipCacheEntry>,
    order: VecDeque<RenderedClipCacheKey>,
    capacity: usize,
}

impl RenderedClipCache {
    /// 创建指定容量的缓存。
    pub fn new(capacity: usize) -> Self {
        Self {
            inner: HashMap::with_capacity(capacity),
            order: VecDeque::with_capacity(capacity),
            capacity: capacity.max(1),
        }
    }

    /// 查询缓存。命中时将 key 移到 front（最近使用）。
    pub fn get(&mut self, key: &RenderedClipCacheKey) -> Option<&RenderedClipCacheEntry> {
        if !self.inner.contains_key(key) {
            return None;
        }
        if let Some(pos) = self.order.iter().position(|k| k == key) {
            let k = self.order.remove(pos).unwrap();
            self.order.push_front(k);
        }
        self.inner.get(key)
    }

    /// 插入缓存。若已满则淘汰最久未使用的 entry。
    pub fn insert(&mut self, key: RenderedClipCacheKey, entry: RenderedClipCacheEntry) {
        if self.inner.contains_key(&key) {
            self.inner.insert(key.clone(), entry);
            if let Some(pos) = self.order.iter().position(|k| k == &key) {
                let k = self.order.remove(pos).unwrap();
                self.order.push_front(k);
            }
            return;
        }

        while self.inner.len() >= self.capacity {
            if let Some(evict_key) = self.order.pop_back() {
                self.inner.remove(&evict_key);
            } else {
                break;
            }
        }

        self.order.push_front(key.clone());
        self.inner.insert(key, entry);
    }

    /// 使指定 clip_id 的所有缓存失效（不论 param_hash）。
    pub fn invalidate(&mut self, clip_id: &str) {
        let keys_to_remove: Vec<RenderedClipCacheKey> = self
            .inner
            .keys()
            .filter(|k| k.clip_id == clip_id)
            .cloned()
            .collect();
        for k in &keys_to_remove {
            self.inner.remove(k);
            if let Some(pos) = self.order.iter().position(|o| o == k) {
                self.order.remove(pos);
            }
        }
    }

    /// 清空所有缓存。
    #[allow(dead_code)]
    pub fn clear(&mut self) {
        self.inner.clear();
        self.order.clear();
    }

    /// 当前缓存条目数。
    #[allow(dead_code)]
    pub fn len(&self) -> usize {
        self.inner.len()
    }
}

// ─── 整 Clip 渲染缓存全局实例 ─────────────────────────────────────────────────

static GLOBAL_RENDERED_CLIP_CACHE: OnceLock<Mutex<RenderedClipCache>> = OnceLock::new();

/// 获取进程级全局整 Clip 渲染缓存。
///
/// 首次调用时初始化，容量为 [`RENDERED_CLIP_CAPACITY`]（128）。
pub fn global_rendered_clip_cache() -> &'static Mutex<RenderedClipCache> {
    GLOBAL_RENDERED_CLIP_CACHE.get_or_init(|| {
        Mutex::new(RenderedClipCache::new(RENDERED_CLIP_CAPACITY))
    })
}

/// 计算整 Clip 渲染的参数哈希。
///
/// 输入覆盖：
/// - `clip_id`：clip 唯一标识
/// - `source_path`：源文件路径
/// - `start_frame` / `end_frame`：clip 在时间轴上的帧范围
/// - `sr`：采样率
/// - `pitch_edit` 曲线中与 clip 时间范围重叠的片段
/// - `playback_rate`：播放速率
pub fn compute_rendered_clip_hash(
    clip_id: &str,
    source_path: &str,
    start_frame: u64,
    end_frame: u64,
    sr: u32,
    pitch_edit: &[f32],
    frame_period_ms: f64,
    playback_rate: f64,
) -> u64 {
    let mut h: u64 = 14695981039346656037u64;

    macro_rules! mix_bytes {
        ($bytes:expr) => {
            for &b in $bytes {
                h ^= b as u64;
                h = h.wrapping_mul(1099511628211u64);
            }
        };
    }

    mix_bytes!(clip_id.as_bytes());
    mix_bytes!(source_path.as_bytes());
    mix_bytes!(&start_frame.to_le_bytes());
    mix_bytes!(&end_frame.to_le_bytes());
    mix_bytes!(&sr.to_le_bytes());
    mix_bytes!(&playback_rate.to_bits().to_le_bytes());

    // 混入与 clip 时间范围重叠的 pitch_edit 曲线片段
    let fp = frame_period_ms.max(0.1);
    let start_sec = start_frame as f64 / sr.max(1) as f64;
    let end_sec = end_frame as f64 / sr.max(1) as f64;
    let start_idx = ((start_sec * 1000.0) / fp).floor().max(0.0) as usize;
    let end_idx = ((end_sec * 1000.0) / fp).ceil().max(0.0) as usize;

    let lo = start_idx.min(pitch_edit.len());
    let hi = end_idx.min(pitch_edit.len());
    for &v in &pitch_edit[lo..hi] {
        mix_bytes!(&v.to_bits().to_le_bytes());
    }

    h
}
