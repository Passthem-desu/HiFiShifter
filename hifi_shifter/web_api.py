from __future__ import annotations

import pathlib
import base64
import tempfile
import uuid
import traceback
import time
import threading
from dataclasses import dataclass, field, asdict
from itertools import count

import numpy as np
import sounddevice as sd
import soundfile as sf
import webview
from scipy.io import wavfile
import math

from .audio_processor import AudioProcessor


@dataclass
class _PlaybackClipPlan:
    clip_id: str
    dst_start: int
    render_len: int
    src_audio: np.ndarray
    src_start: int
    gain: float
    fade_in: np.ndarray | None
    fade_out: np.ndarray | None
    fade_out_start: int


@dataclass
class SessionState:
    audio_path: str | None = None
    sample_rate: int | None = None
    original_audio: np.ndarray | None = None
    base_f0_midi: np.ndarray | None = None
    edited_f0_midi: np.ndarray | None = None
    mel = None
    synthesized_audio: np.ndarray | None = None
    playback_target: str | None = None
    playback_started_at: float | None = None
    playback_start_sec: float = 0.0
    playback_duration_sec: float = 0.0
    bpm: float = 120.0
    playhead_beat: float = 0.0
    project_beats: float = 64.0
    tracks: dict[str, 'TrackState'] = field(default_factory=dict)
    track_order: list[str] = field(default_factory=list)
    clips: dict[str, 'ClipState'] = field(default_factory=dict)
    selected_track_id: str | None = None
    selected_clip_id: str | None = None


@dataclass
class TrackState:
    id: str
    name: str
    parent_id: str | None = None
    child_track_ids: list[str] = field(default_factory=list)
    muted: bool = False
    solo: bool = False
    volume: float = 0.9
    clip_ids: list[str] = field(default_factory=list)


@dataclass
class ClipState:
    id: str
    track_id: str
    name: str
    start_beat: float
    length_beats: float
    color: str = 'emerald'
    source_path: str | None = None
    duration_sec: float = 0.0
    waveform_preview: list[float] = field(default_factory=list)
    pitch_range: dict[str, float] = field(default_factory=lambda: {'min': -24.0, 'max': 24.0})
    gain: float = 1.0
    muted: bool = False
    trim_start_beat: float = 0.0
    trim_end_beat: float = 0.0
    playback_rate: float = 1.0
    fade_in_beats: float = 0.0
    fade_out_beats: float = 0.0


class HifiShifterWebAPI:
    """JS-callable backend API for pywebview.

    All heavy logic remains in Python. Frontend only handles UI rendering.
    """

    def __init__(self):
        self.processor = AudioProcessor()
        self.state = SessionState()
        self._track_seq = count(1)
        self._clip_seq = count(1)
        self._audio_cache: dict[str, tuple[int, np.ndarray]] = {}
        self._render_cache: dict[tuple, np.ndarray] = {}
        self._playback_stream: sd.OutputStream | None = None
        self._playback_plan: dict[str, object] | None = None
        self._playback_lock = threading.Lock()
        self._init_default_timeline()
        self._try_load_default_model()

    def _init_default_timeline(self):
        track_id = self._new_track_id()
        self.state.tracks[track_id] = TrackState(id=track_id, name='Main', parent_id=None, muted=False, solo=False, volume=0.9)
        self.state.track_order = [track_id]
        self.state.selected_track_id = track_id
        self.state.selected_clip_id = None

    def _try_load_default_model(self):
        try:
            self.load_default_model()
        except Exception:
            pass

    def _new_track_id(self) -> str:
        return f'track_{next(self._track_seq)}'

    def _new_clip_id(self) -> str:
        return f'clip_{next(self._clip_seq)}'

    def _get_selected_track_id(self) -> str:
        if self.state.selected_track_id and self.state.selected_track_id in self.state.tracks:
            return self.state.selected_track_id
        if self.state.track_order:
            return self.state.track_order[0]
        track_id = self._new_track_id()
        self.state.tracks[track_id] = TrackState(id=track_id, name='Main', parent_id=None)
        self.state.track_order = [track_id]
        self.state.selected_track_id = track_id
        return track_id

    def _flatten_track_ids(self):
        ordered: list[tuple[str, int]] = []

        def visit(track_id: str, depth: int):
            track = self.state.tracks.get(track_id)
            if not track:
                return
            ordered.append((track_id, depth))
            for child_id in track.child_track_ids:
                visit(child_id, depth + 1)

        for root_id in self.state.track_order:
            visit(root_id, 0)
        return ordered

    def _get_descendant_track_ids(self, track_id: str):
        result: list[str] = []

        def visit(current_id: str):
            current = self.state.tracks.get(current_id)
            if not current:
                return
            result.append(current_id)
            for child_id in current.child_track_ids:
                visit(child_id)

        visit(track_id)
        return result

    def _update_project_beats_from_clips(self):
        max_end = 0.0
        for clip in self.state.clips.values():
            max_end = max(max_end, clip.start_beat + clip.length_beats)
        self.state.project_beats = max(8.0, float(np.ceil(max_end + 4.0)))

    def _track_lineage(self, track_id: str):
        lineage: list[TrackState] = []
        current = self.state.tracks.get(track_id)
        safety = 0
        while current and safety < 2000:
            lineage.append(current)
            if not current.parent_id:
                break
            current = self.state.tracks.get(current.parent_id)
            safety += 1
        return lineage

    def _effective_track_gain_and_mute(self, track_id: str):
        gain = 1.0
        muted = False
        for track in self._track_lineage(track_id):
            gain *= float(np.clip(track.volume, 0.0, 1.0))
            muted = muted or bool(track.muted)
        return gain, muted

    def _is_track_audible_under_solo(self, track_id: str, has_any_solo: bool):
        if not has_any_solo:
            return True
        return any(track.solo for track in self._track_lineage(track_id))

    def _serialize_timeline(self):
        tracks = []
        for track_id, depth in self._flatten_track_ids():
            track = self.state.tracks.get(track_id)
            if not track:
                continue
            tracks.append({
                'id': track.id,
                'name': track.name,
                'parent_id': track.parent_id,
                'depth': depth,
                'child_track_ids': list(track.child_track_ids),
                'muted': track.muted,
                'solo': track.solo,
                'volume': track.volume,
            })

        clips = []
        for clip in self.state.clips.values():
            clips.append({
                'id': clip.id,
                'track_id': clip.track_id,
                'name': clip.name,
                'start_beat': clip.start_beat,
                'length_beats': clip.length_beats,
                'color': clip.color,
                'source_path': clip.source_path,
                'duration_sec': clip.duration_sec,
                'waveform_preview': clip.waveform_preview,
                'pitch_range': clip.pitch_range,
                'gain': clip.gain,
                'muted': clip.muted,
                'trim_start_beat': clip.trim_start_beat,
                'trim_end_beat': clip.trim_end_beat,
                'playback_rate': clip.playback_rate,
                'fade_in_beats': clip.fade_in_beats,
                'fade_out_beats': clip.fade_out_beats,
            })

        clips.sort(key=lambda item: (item['track_id'], item['start_beat']))
        return {
            'tracks': tracks,
            'clips': clips,
            'selected_track_id': self.state.selected_track_id,
            'selected_clip_id': self.state.selected_clip_id,
            'bpm': self.state.bpm,
            'playhead_beat': self.state.playhead_beat,
            'project_beats': self.state.project_beats,
        }

    def ping(self):
        return {'ok': True, 'message': 'pong'}

    def get_runtime_info(self):
        playback = self._get_playback_state_internal()
        return {
            'ok': True,
            'device': self.processor.device,
            'model_loaded': self.processor.model is not None,
            'audio_loaded': self.state.audio_path is not None,
            'has_synthesized': self.state.synthesized_audio is not None,
            'is_playing': playback['is_playing'],
            'playback_target': playback['target'],
            'timeline': self._serialize_timeline(),
        }

    def get_timeline_state(self):
        try:
            return {
                'ok': True,
                **self._serialize_timeline(),
            }
        except Exception as exc:
            return self._error('get_timeline_state_failed', exc)

    def add_track(self, name: str | None = None, parent_track_id: str | None = None, index: int | None = None):
        try:
            track_id = self._new_track_id()
            display_name = (name or '').strip() or f'Track {len(self.state.tracks) + 1}'

            if parent_track_id is not None and parent_track_id not in self.state.tracks:
                raise RuntimeError('父轨道不存在。')

            self.state.tracks[track_id] = TrackState(
                id=track_id,
                name=display_name,
                parent_id=parent_track_id,
            )

            if parent_track_id is None:
                insert_index = len(self.state.track_order) if index is None else int(np.clip(index, 0, len(self.state.track_order)))
                self.state.track_order.insert(insert_index, track_id)
            else:
                parent_track = self.state.tracks[parent_track_id]
                insert_index = len(parent_track.child_track_ids) if index is None else int(np.clip(index, 0, len(parent_track.child_track_ids)))
                parent_track.child_track_ids.insert(insert_index, track_id)

            self.state.selected_track_id = track_id
            return {
                'ok': True,
                'track': asdict(self.state.tracks[track_id]),
                **self._serialize_timeline(),
            }
        except Exception as exc:
            return self._error('add_track_failed', exc)

    def remove_track(self, track_id: str):
        try:
            track = self.state.tracks.get(track_id)
            if not track:
                raise RuntimeError('轨道不存在。')
            if len(self.state.tracks) <= 1:
                raise RuntimeError('至少保留一条轨道。')

            target_ids = set(self._get_descendant_track_ids(track_id))
            if len(self.state.tracks) - len(target_ids) <= 0:
                raise RuntimeError('至少保留一条轨道。')

            for child_track_id in target_ids:
                child_track = self.state.tracks.get(child_track_id)
                if not child_track:
                    continue
                for clip_id in list(child_track.clip_ids):
                    self.state.clips.pop(clip_id, None)

            if track.parent_id and track.parent_id in self.state.tracks:
                parent = self.state.tracks[track.parent_id]
                parent.child_track_ids = [item for item in parent.child_track_ids if item != track_id]
            else:
                self.state.track_order = [item for item in self.state.track_order if item != track_id]

            for child_track_id in target_ids:
                self.state.tracks.pop(child_track_id, None)

            if self.state.selected_track_id == track_id:
                flattened = self._flatten_track_ids()
                self.state.selected_track_id = flattened[0][0] if flattened else None
            if self.state.selected_clip_id and self.state.selected_clip_id not in self.state.clips:
                self.state.selected_clip_id = None

            self._update_project_beats_from_clips()

            return {
                'ok': True,
                **self._serialize_timeline(),
            }
        except Exception as exc:
            return self._error('remove_track_failed', exc)

    def move_track(self, track_id: str, target_index: int, parent_track_id: str | None = None):
        try:
            track = self.state.tracks.get(track_id)
            if not track:
                raise RuntimeError('轨道不存在。')

            if parent_track_id is not None:
                if parent_track_id not in self.state.tracks:
                    raise RuntimeError('目标父轨道不存在。')
                if parent_track_id == track_id:
                    raise RuntimeError('轨道不能成为自己的子轨道。')
                if parent_track_id in set(self._get_descendant_track_ids(track_id)):
                    raise RuntimeError('目标父轨道不能是当前轨道的子轨道。')

            if track.parent_id and track.parent_id in self.state.tracks:
                parent = self.state.tracks[track.parent_id]
                parent.child_track_ids = [item for item in parent.child_track_ids if item != track_id]
            else:
                self.state.track_order = [item for item in self.state.track_order if item != track_id]

            track.parent_id = parent_track_id
            if parent_track_id is None:
                index = int(np.clip(target_index, 0, len(self.state.track_order)))
                self.state.track_order.insert(index, track_id)
            else:
                parent = self.state.tracks[parent_track_id]
                index = int(np.clip(target_index, 0, len(parent.child_track_ids)))
                parent.child_track_ids.insert(index, track_id)

            return {
                'ok': True,
                **self._serialize_timeline(),
            }
        except Exception as exc:
            return self._error('move_track_failed', exc)

    def set_project_length(self, project_beats: float):
        try:
            beats = max(4.0, float(project_beats))
            self.state.project_beats = beats
            return {
                'ok': True,
                'project_beats': self.state.project_beats,
                **self._serialize_timeline(),
            }
        except Exception as exc:
            return self._error('set_project_length_failed', exc)

    def set_track_state(self, track_id: str, muted: bool | None = None, solo: bool | None = None, volume: float | None = None):
        try:
            track = self.state.tracks.get(track_id)
            if not track:
                raise RuntimeError('轨道不存在。')

            if muted is not None:
                track.muted = bool(muted)
            if solo is not None:
                track.solo = bool(solo)
            if volume is not None:
                track.volume = float(np.clip(volume, 0.0, 1.0))

            return {
                'ok': True,
                'track': asdict(track),
                **self._serialize_timeline(),
            }
        except Exception as exc:
            return self._error('set_track_state_failed', exc)

    def select_track(self, track_id: str):
        try:
            if track_id not in self.state.tracks:
                raise RuntimeError('轨道不存在。')
            self.state.selected_track_id = track_id
            return {
                'ok': True,
                **self._serialize_timeline(),
            }
        except Exception as exc:
            return self._error('select_track_failed', exc)

    def add_clip(
        self,
        track_id: str | None = None,
        name: str | None = None,
        start_beat: float | None = None,
        length_beats: float | None = None,
        source_path: str | None = None,
    ):
        try:
            target_track_id = track_id or self._get_selected_track_id()
            if target_track_id not in self.state.tracks:
                raise RuntimeError('轨道不存在。')

            clip_id = self._new_clip_id()
            clip = ClipState(
                id=clip_id,
                track_id=target_track_id,
                name=(name or '').strip() or 'New Clip.wav',
                start_beat=max(
                    0.0,
                    float(
                        start_beat
                        if start_beat is not None
                        else self.state.playhead_beat
                    ),
                ),
                length_beats=max(
                    0.0,
                    float(length_beats if length_beats is not None else 2.0),
                ),
                source_path=source_path,
            )

            self.state.clips[clip_id] = clip
            self.state.tracks[target_track_id].clip_ids.append(clip_id)
            self.state.selected_clip_id = clip_id
            self.state.selected_track_id = target_track_id
            self._update_project_beats_from_clips()

            return {
                'ok': True,
                'clip': asdict(clip),
                **self._serialize_timeline(),
            }
        except Exception as exc:
            return self._error('add_clip_failed', exc)

    def remove_clip(self, clip_id: str):
        try:
            clip = self.state.clips.pop(clip_id, None)
            if not clip:
                raise RuntimeError('音频块不存在。')

            track = self.state.tracks.get(clip.track_id)
            if track:
                track.clip_ids = [item for item in track.clip_ids if item != clip_id]

            if self.state.selected_clip_id == clip_id:
                self.state.selected_clip_id = None

            self._update_project_beats_from_clips()

            return {
                'ok': True,
                **self._serialize_timeline(),
            }
        except Exception as exc:
            return self._error('remove_clip_failed', exc)

    def move_clip(self, clip_id: str, start_beat: float, track_id: str | None = None):
        try:
            clip = self.state.clips.get(clip_id)
            if not clip:
                raise RuntimeError('音频块不存在。')

            clip.start_beat = max(0.0, float(start_beat))

            if track_id and track_id != clip.track_id:
                if track_id not in self.state.tracks:
                    raise RuntimeError('目标轨道不存在。')
                old_track = self.state.tracks.get(clip.track_id)
                if old_track:
                    old_track.clip_ids = [item for item in old_track.clip_ids if item != clip.id]
                clip.track_id = track_id
                self.state.tracks[track_id].clip_ids.append(clip.id)

            self._update_project_beats_from_clips()

            return {
                'ok': True,
                'clip': asdict(clip),
                **self._serialize_timeline(),
            }
        except Exception as exc:
            return self._error('move_clip_failed', exc)

    def set_clip_state(
        self,
        clip_id: str,
        length_beats: float | None = None,
        gain: float | None = None,
        muted: bool | None = None,
        trim_start_beat: float | None = None,
        trim_end_beat: float | None = None,
        playback_rate: float | None = None,
        fade_in_beats: float | None = None,
        fade_out_beats: float | None = None,
    ):
        try:
            clip = self.state.clips.get(clip_id)
            if not clip:
                raise RuntimeError('音频块不存在。')

            if length_beats is not None:
                # Allow shrinking to a line in UI; treat <= 0 as "no audible segment".
                clip.length_beats = max(0.0, float(length_beats))
            if gain is not None:
                clip.gain = float(np.clip(gain, 0.0, 2.0))
            if muted is not None:
                clip.muted = bool(muted)
            if trim_start_beat is not None:
                clip.trim_start_beat = max(0.0, float(trim_start_beat))
            if trim_end_beat is not None:
                clip.trim_end_beat = max(0.0, float(trim_end_beat))
            if playback_rate is not None:
                clip.playback_rate = float(np.clip(playback_rate, 0.25, 4.0))
            if fade_in_beats is not None:
                clip.fade_in_beats = max(0.0, float(fade_in_beats))
            if fade_out_beats is not None:
                clip.fade_out_beats = max(0.0, float(fade_out_beats))

            self._update_project_beats_from_clips()

            return {
                'ok': True,
                'clip': asdict(clip),
                **self._serialize_timeline(),
            }
        except Exception as exc:
            return self._error('set_clip_state_failed', exc)

    def split_clip(self, clip_id: str, split_beat: float):
        """Split a clip into two clips at split_beat.

        The split beat is in project/timeline beats (same coordinate as ClipState.start_beat).
        """
        try:
            clip = self.state.clips.get(clip_id)
            if not clip:
                raise RuntimeError('音频块不存在。')

            split_beat_f = float(split_beat)
            if not (clip.start_beat < split_beat_f < clip.start_beat + clip.length_beats):
                raise RuntimeError('分割点必须位于音频块内部。')

            track = self.state.tracks.get(clip.track_id)
            if not track:
                raise RuntimeError('轨道不存在。')

            left_len = split_beat_f - clip.start_beat
            right_len = (clip.start_beat + clip.length_beats) - split_beat_f

            # Trim semantics: trim_start_beat/trim_end_beat are in source-beat units
            # (beats mapped to seconds by BPM), trimming from source start/end.
            # Splitting keeps the same source, but changes which region is used.

            new_clip_id = self._new_clip_id()
            wp = clip.waveform_preview
            if isinstance(wp, dict):
                waveform_preview = {
                    'l': list(wp.get('l', []) or []),
                    'r': list(wp.get('r', []) or []),
                }
            else:
                waveform_preview = list(wp) if isinstance(wp, list) else []
            new_clip = ClipState(
                id=new_clip_id,
                track_id=clip.track_id,
                name=f"{clip.name} (split)",
                start_beat=split_beat_f,
                length_beats=max(0.0, float(right_len)),
                color=clip.color,
                source_path=clip.source_path,
                duration_sec=clip.duration_sec,
                waveform_preview=waveform_preview,
                pitch_range=dict(clip.pitch_range),
                gain=clip.gain,
                muted=clip.muted,
                trim_start_beat=max(0.0, float(clip.trim_start_beat + left_len)),
                trim_end_beat=max(0.0, float(clip.trim_end_beat)),
                playback_rate=clip.playback_rate,
                fade_in_beats=0.0,
                fade_out_beats=clip.fade_out_beats,
            )

            # Adjust original clip to be the left part.
            clip.length_beats = max(0.0, float(left_len))
            clip.trim_end_beat = max(0.0, float(clip.trim_end_beat + right_len))
            clip.fade_out_beats = 0.0

            # Keep order: insert right clip right after left clip.
            if clip_id in track.clip_ids:
                idx = track.clip_ids.index(clip_id)
                track.clip_ids.insert(idx + 1, new_clip_id)
            else:
                track.clip_ids.append(new_clip_id)

            self.state.clips[new_clip_id] = new_clip
            self.state.selected_clip_id = new_clip_id

            self._update_project_beats_from_clips()

            return {
                'ok': True,
                'clip': asdict(clip),
                'new_clip': asdict(new_clip),
                **self._serialize_timeline(),
            }
        except Exception as exc:
            return self._error('split_clip_failed', exc)

    def glue_clips(self, clip_ids: list[str]):
        """Glue multiple clips on the same track into a new rendered clip."""
        try:
            if not isinstance(clip_ids, (list, tuple)):
                raise RuntimeError('参数 clip_ids 必须为数组。')
            ids = [str(x) for x in clip_ids if str(x).strip()]
            ids = list(dict.fromkeys(ids))
            if len(ids) < 2:
                raise RuntimeError('请至少选择 2 个音频块进行胶合。')

            clips: list[ClipState] = []
            for cid in ids:
                clip = self.state.clips.get(cid)
                if not clip:
                    raise RuntimeError(f'音频块不存在: {cid}')
                clips.append(clip)

            track_id = clips[0].track_id
            if any(c.track_id != track_id for c in clips):
                raise RuntimeError('胶合仅支持同一轨道内的音频块。')
            track = self.state.tracks.get(track_id)
            if not track:
                raise RuntimeError('轨道不存在。')

            bpm = max(1.0, float(self.state.bpm))
            glue_start_beat = min(float(c.start_beat) for c in clips)
            glue_end_beat = max(float(c.start_beat) + float(c.length_beats) for c in clips)
            glue_start_sec = max(0.0, glue_start_beat * 60.0 / bpm)
            glue_end_sec = max(glue_start_sec, glue_end_beat * 60.0 / bpm)

            sample_rate = int(self.state.sample_rate or self.processor.config.get('audio_sample_rate', 44100))
            total_len = int(round((glue_end_sec - glue_start_sec) * sample_rate))
            if total_len <= 0:
                raise RuntimeError('胶合长度无效。')

            def _fade_in_curve(n: int) -> np.ndarray:
                if n <= 1:
                    return np.ones(max(0, n), dtype=np.float32)
                t = np.linspace(0.0, 1.0, num=n, endpoint=True, dtype=np.float32)
                return np.sin(t * (math.pi / 2.0)).astype(np.float32)

            def _fade_out_curve(n: int) -> np.ndarray:
                if n <= 1:
                    return np.ones(max(0, n), dtype=np.float32)
                t = np.linspace(0.0, 1.0, num=n, endpoint=True, dtype=np.float32)
                return np.cos(t * (math.pi / 2.0)).astype(np.float32)

            mix = np.zeros(total_len, dtype=np.float32)
            for clip in clips:
                resolved = self._resolve_clip_audio(clip, 'original')
                if not resolved:
                    continue
                src_sr, src_audio = resolved
                clip_audio = self._resample_linear(src_audio, src_sr, sample_rate)
                clip_audio = self._time_stretch_linear(clip_audio, clip.playback_rate)

                src_total_sec = float(clip_audio.size) / float(sample_rate) if sample_rate > 0 else 0.0
                trim_start_sec = max(0.0, float(clip.trim_start_beat) * 60.0 / bpm)
                trim_end_sec = max(0.0, float(clip.trim_end_beat) * 60.0 / bpm)
                available_sec = max(0.0, src_total_sec - trim_start_sec - trim_end_sec)
                desired_sec = max(0.0, float(clip.length_beats) * 60.0 / bpm)
                render_sec = min(desired_sec, available_sec)
                if render_sec <= 1e-6:
                    continue

                start_idx_in_src = int(round(trim_start_sec * sample_rate))
                end_idx_in_src = min(
                    clip_audio.size,
                    start_idx_in_src + int(round(render_sec * sample_rate)),
                )
                if end_idx_in_src <= start_idx_in_src:
                    continue
                segment = clip_audio[start_idx_in_src:end_idx_in_src]
                segment = segment * float(np.clip(float(clip.gain), 0.0, 2.0))

                fade_in_sec = max(0.0, float(getattr(clip, 'fade_in_beats', 0.0)) * 60.0 / bpm)
                fade_out_sec = max(0.0, float(getattr(clip, 'fade_out_beats', 0.0)) * 60.0 / bpm)
                if segment.size > 1:
                    if fade_in_sec > 1e-6:
                        n = int(round(fade_in_sec * sample_rate))
                        n = max(0, min(n, segment.size))
                        if n > 1:
                            segment[:n] *= _fade_in_curve(n)
                    if fade_out_sec > 1e-6:
                        n = int(round(fade_out_sec * sample_rate))
                        n = max(0, min(n, segment.size))
                        if n > 1:
                            segment[-n:] *= _fade_out_curve(n)

                clip_start_sec = max(0.0, float(clip.start_beat) * 60.0 / bpm)
                dst_start = int(round((clip_start_sec - glue_start_sec) * sample_rate))
                if dst_start < 0:
                    trim = -dst_start
                    if trim >= segment.size:
                        continue
                    segment = segment[trim:]
                    dst_start = 0
                dst_end = min(mix.size, dst_start + segment.size)
                if dst_end <= dst_start:
                    continue
                mix[dst_start:dst_end] += segment[: dst_end - dst_start]

            mix = np.clip(mix, -1.0, 1.0)

            out_dir = pathlib.Path(tempfile.gettempdir()) / 'hifishifter_glue'
            out_dir.mkdir(parents=True, exist_ok=True)
            out_path = out_dir / f'glue_{uuid.uuid4().hex}.wav'
            sf.write(str(out_path), mix, sample_rate)

            # Remove old clips
            for cid in ids:
                if cid in self.state.clips:
                    del self.state.clips[cid]
            track.clip_ids = [cid for cid in track.clip_ids if cid not in set(ids)]

            # Create new glued clip
            sr, channels = self._load_audio_for_preview(str(out_path))
            duration_sec = float(channels[0].size / sr) if sr > 0 and channels else 0.0
            if len(channels) >= 2:
                waveform_preview = {
                    'l': self._compute_waveform_preview(channels[0]),
                    'r': self._compute_waveform_preview(channels[1]),
                }
            else:
                waveform_preview = self._compute_waveform_preview(channels[0] if channels else np.zeros(0, dtype=np.float32))

            new_clip_id = self._new_clip_id()
            new_clip = ClipState(
                id=new_clip_id,
                track_id=track_id,
                name='Glued.wav',
                start_beat=float(glue_start_beat),
                length_beats=max(0.25, float(duration_sec * bpm / 60.0) if duration_sec > 0 else float(glue_end_beat - glue_start_beat)),
                color='emerald',
                source_path=str(out_path),
                duration_sec=duration_sec,
                waveform_preview=waveform_preview,
                pitch_range={'min': -24.0, 'max': 24.0},
                gain=1.0,
                muted=False,
                trim_start_beat=0.0,
                trim_end_beat=0.0,
                playback_rate=1.0,
                fade_in_beats=0.0,
                fade_out_beats=0.0,
            )
            self.state.clips[new_clip_id] = new_clip
            track.clip_ids.append(new_clip_id)
            self.state.selected_clip_id = new_clip_id

            self._update_project_beats_from_clips()

            return {
                'ok': True,
                'clip': asdict(new_clip),
                **self._serialize_timeline(),
            }
        except Exception as exc:
            return self._error('glue_clips_failed', exc)

    def get_track_summary(self, track_id: str | None = None):
        try:
            target_track_id = track_id or self._get_selected_track_id()
            if target_track_id not in self.state.tracks:
                raise RuntimeError('轨道不存在。')

            descendant_ids = set(self._get_descendant_track_ids(target_track_id))
            target_clips = [
                clip
                for clip in self.state.clips.values()
                if clip.track_id in descendant_ids
            ]
            target_clips.sort(key=lambda item: item.start_beat)

            waveform: list[float] = []
            for clip in target_clips:
                waveform.extend(clip.waveform_preview)
                if len(waveform) >= 320:
                    break
            waveform = waveform[:320]

            pitch_min = None
            pitch_max = None
            for clip in target_clips:
                pmin = clip.pitch_range.get('min')
                pmax = clip.pitch_range.get('max')
                if pmin is None or pmax is None:
                    continue
                pitch_min = pmin if pitch_min is None else min(pitch_min, pmin)
                pitch_max = pmax if pitch_max is None else max(pitch_max, pmax)

            return {
                'ok': True,
                'track_id': target_track_id,
                'clip_count': len(target_clips),
                'waveform_preview': waveform,
                'pitch_range': {
                    'min': float(pitch_min if pitch_min is not None else -24.0),
                    'max': float(pitch_max if pitch_max is not None else 24.0),
                },
            }
        except Exception as exc:
            return self._error('get_track_summary_failed', exc)

    def select_clip(self, clip_id: str | None):
        try:
            if clip_id is None:
                self.state.selected_clip_id = None
                return {
                    'ok': True,
                    **self._serialize_timeline(),
                }

            clip = self.state.clips.get(clip_id)
            if not clip:
                raise RuntimeError('音频块不存在。')

            self.state.selected_clip_id = clip_id
            self.state.selected_track_id = clip.track_id
            return {
                'ok': True,
                **self._serialize_timeline(),
            }
        except Exception as exc:
            return self._error('select_clip_failed', exc)

    def set_transport(self, playhead_beat: float | None = None, bpm: float | None = None):
        try:
            should_restart_playback = False
            if bpm is not None:
                prev_bpm = float(self.state.bpm or 120.0)
                next_bpm = float(np.clip(bpm, 10.0, 300.0))
                if prev_bpm <= 0:
                    prev_bpm = 120.0
                ratio = next_bpm / prev_bpm

                # Keep absolute seconds stable by scaling beats-based timeline.
                self.state.bpm = next_bpm
                self.state.playhead_beat = max(0.0, float(self.state.playhead_beat) * ratio)

                for clip in self.state.clips.values():
                    clip.start_beat = max(0.0, float(clip.start_beat) * ratio)
                    clip.length_beats = max(0.1, float(clip.length_beats) * ratio)
                    clip.trim_start_beat = max(0.0, float(clip.trim_start_beat) * ratio)
                    clip.trim_end_beat = max(0.0, float(clip.trim_end_beat) * ratio)
                    clip.fade_in_beats = max(0.0, float(clip.fade_in_beats) * ratio)
                    clip.fade_out_beats = max(0.0, float(clip.fade_out_beats) * ratio)

                self.state.project_beats = max(4.0, float(self.state.project_beats) * ratio)
                self._update_project_beats_from_clips()
            if playhead_beat is not None:
                self.state.playhead_beat = max(0.0, float(playhead_beat))
                if self.state.playback_target and self.state.playback_started_at is not None:
                    should_restart_playback = True

            if should_restart_playback:
                target = self.state.playback_target
                if target:
                    # Keep seek responsive by restarting playback using the low-latency stream path.
                    self._start_stream_playback(target, float(self.state.playhead_beat))
            return {
                'ok': True,
                'playhead_beat': self.state.playhead_beat,
                'bpm': self.state.bpm,
                **self._serialize_timeline(),
            }
        except Exception as exc:
            return self._error('set_transport_failed', exc)

    def load_default_model(self):
        try:
            root = pathlib.Path(__file__).resolve().parents[1]
            default_dir = root / 'pc_nsf_hifigan_44.1k_hop512_128bin_2025.02'
            if not default_dir.exists():
                raise FileNotFoundError(f'默认模型目录不存在: {default_dir}')
            return self.load_model(str(default_dir))
        except Exception as exc:
            return self._error('load_default_model_failed', exc)

    def load_model(self, model_dir: str):
        try:
            config = self.processor.load_model(model_dir)
            return {
                'ok': True,
                'config': {
                    'audio_sample_rate': int(config['audio_sample_rate']),
                    'audio_num_mel_bins': int(config['audio_num_mel_bins']),
                    'hop_size': int(config['hop_size']),
                    'fmin': float(config.get('fmin', 40)),
                    'fmax': float(config.get('fmax', 16000)),
                },
            }
        except Exception as exc:
            return self._error('load_model_failed', exc)

    def process_audio(self, audio_path: str):
        try:
            audio_np, sr, mel, f0_midi, segments = self.processor.process_audio(audio_path)
            self.state.audio_path = str(audio_path)
            self.state.sample_rate = int(sr)
            self.state.original_audio = np.asarray(audio_np, dtype=np.float32)
            self.state.mel = mel
            self.state.base_f0_midi = np.array(f0_midi, copy=True)
            self.state.edited_f0_midi = np.array(f0_midi, copy=True)
            self.state.synthesized_audio = None

            duration_sec = float(len(audio_np) / sr) if sr > 0 else 0.0
            preview_segments = [list(map(int, seg)) for seg in segments[:100]]

            clip_samples = np.asarray(audio_np, dtype=np.float32)
            bins = 220
            if clip_samples.size == 0:
                waveform_preview: list[float] = []
            else:
                chunk = max(1, int(np.ceil(clip_samples.size / bins)))
                waveform_preview = []
                for idx in range(0, clip_samples.size, chunk):
                    part = clip_samples[idx : idx + chunk]
                    if part.size == 0:
                        continue
                    peak = float(np.max(np.abs(part)))
                    waveform_preview.append(peak)

            valid_f0 = np.asarray(f0_midi, dtype=np.float32)
            valid_f0 = valid_f0[~np.isnan(valid_f0)]
            if valid_f0.size > 0:
                pitch_min = float(np.floor(np.min(valid_f0) - 2.0))
                pitch_max = float(np.ceil(np.max(valid_f0) + 2.0))
            else:
                pitch_min = -24.0
                pitch_max = 24.0

            track_id = self._get_selected_track_id()
            linked_clip: ClipState | None = None
            for clip in self.state.clips.values():
                if clip.source_path == str(audio_path):
                    linked_clip = clip
                    break

            if linked_clip is None:
                clip_id = self._new_clip_id()
                linked_clip = ClipState(
                    id=clip_id,
                    track_id=track_id,
                    name=pathlib.Path(str(audio_path)).name,
                    start_beat=float(self.state.playhead_beat),
                    length_beats=max(1.0, duration_sec * self.state.bpm / 60.0),
                    color='emerald',
                    source_path=str(audio_path),
                    duration_sec=duration_sec,
                    waveform_preview=waveform_preview,
                    pitch_range={'min': pitch_min, 'max': pitch_max},
                )
                self.state.clips[clip_id] = linked_clip
                self.state.tracks[track_id].clip_ids.append(clip_id)
            else:
                linked_clip.duration_sec = duration_sec
                linked_clip.waveform_preview = waveform_preview
                linked_clip.pitch_range = {'min': pitch_min, 'max': pitch_max}
                linked_clip.length_beats = max(1.0, duration_sec * self.state.bpm / 60.0)

            self.state.selected_clip_id = linked_clip.id
            self.state.selected_track_id = linked_clip.track_id
            self._update_project_beats_from_clips()

            return {
                'ok': True,
                'audio': {
                    'path': str(audio_path),
                    'sample_rate': int(sr),
                    'duration_sec': duration_sec,
                },
                'feature': {
                    'mel_shape': list(mel.shape),
                    'f0_frames': int(len(f0_midi)),
                    'segment_count': int(len(segments)),
                    'segments_preview': preview_segments,
                    'waveform_preview': waveform_preview,
                    'pitch_range': {
                        'min': pitch_min,
                        'max': pitch_max,
                    },
                },
                'timeline': self._serialize_timeline(),
            }
        except Exception as exc:
            return self._error('process_audio_failed', exc)

    def set_pitch_shift(self, semitones: float):
        try:
            if self.state.base_f0_midi is None:
                raise RuntimeError('请先处理音频。')

            semitones = float(semitones)
            edited = np.array(self.state.base_f0_midi, copy=True)
            mask = ~np.isnan(edited)
            edited[mask] = edited[mask] + semitones
            self.state.edited_f0_midi = edited
            return {
                'ok': True,
                'pitch_shift': semitones,
                'frames': int(len(edited)),
            }
        except Exception as exc:
            return self._error('set_pitch_shift_failed', exc)

    def synthesize(self):
        try:
            if self.state.mel is None or self.state.edited_f0_midi is None:
                raise RuntimeError('请先加载并处理音频。')

            synthesized = self.processor.synthesize(self.state.mel, self.state.edited_f0_midi)
            synthesized = np.asarray(synthesized, dtype=np.float32)
            self.state.synthesized_audio = synthesized
            sr = int(self.state.sample_rate or self.processor.config.get('audio_sample_rate', 44100))
            return {
                'ok': True,
                'sample_rate': sr,
                'num_samples': int(synthesized.shape[-1]),
                'duration_sec': float(synthesized.shape[-1] / sr),
            }
        except Exception as exc:
            return self._error('synthesize_failed', exc)

    def _load_audio_file_mono(self, source_path: str):
        cached = self._audio_cache.get(source_path)
        if cached is not None:
            return cached

        audio: np.ndarray
        sample_rate: int
        load_error: Exception | None = None

        # Prefer soundfile for wav/flac/ogg etc.
        try:
            data, sr = sf.read(source_path, always_2d=True)
            sample_rate = int(sr)
            audio = np.mean(np.asarray(data, dtype=np.float32), axis=1)
        except Exception as exc:
            load_error = exc
            # Fallback to librosa (handles more formats if backend is available).
            try:
                import librosa  # local import to keep startup lightweight

                audio, sr = librosa.load(source_path, sr=None, mono=True)
                sample_rate = int(sr)
                audio = np.asarray(audio, dtype=np.float32)
                load_error = None
            except Exception:
                # Final fallback to scipy wavfile for plain WAV.
                sample_rate, data = wavfile.read(source_path)
                audio = np.asarray(data)
                if audio.ndim == 2:
                    audio = np.mean(audio.astype(np.float32), axis=1)

                if np.issubdtype(audio.dtype, np.integer):
                    max_val = float(np.iinfo(audio.dtype).max)
                    if max_val > 0:
                        audio = audio.astype(np.float32) / max_val
                    else:
                        audio = audio.astype(np.float32)
                else:
                    audio = audio.astype(np.float32)

        if load_error is not None:
            # If we reached here, both sf + librosa failed and wavfile succeeded or raised.
            # Keep original error context for debugging in caller.
            pass

        self._audio_cache[source_path] = (int(sample_rate), audio)
        return int(sample_rate), audio

    def _compute_waveform_preview(self, audio: np.ndarray, bins: int = 1024) -> list[float]:
        audio = np.asarray(audio, dtype=np.float32)
        if audio.size == 0:
            return []
        bins = int(max(16, bins))
        chunk = max(1, int(np.ceil(audio.size / bins)))
        waveform_preview: list[float] = []
        for idx in range(0, audio.size, chunk):
            part = audio[idx : idx + chunk]
            if part.size == 0:
                continue
            waveform_preview.append(float(np.max(np.abs(part))))
        return waveform_preview

    def _load_audio_for_preview(self, source_path: str):
        """Load audio for waveform preview.

        Returns: (sample_rate, channels)
        - channels: list of 1 or 2 mono float32 arrays.
        """
        # soundfile first (fast for wav/flac/ogg)
        try:
            data, sr = sf.read(source_path, always_2d=True)
            sr = int(sr)
            data = np.asarray(data, dtype=np.float32)
            if data.shape[1] <= 1:
                return sr, [data[:, 0]]
            return sr, [data[:, 0], data[:, 1]]
        except Exception:
            pass

        # librosa fallback (can decode more formats depending on backend)
        try:
            import librosa

            y, sr = librosa.load(source_path, sr=None, mono=False)
            sr = int(sr)
            y = np.asarray(y, dtype=np.float32)
            if y.ndim == 1:
                return sr, [y]
            if y.shape[0] >= 2:
                return sr, [y[0], y[1]]
            return sr, [y[0]]
        except Exception:
            # last resort: mono loader
            sr, mono = self._load_audio_file_mono(source_path)
            return int(sr), [np.asarray(mono, dtype=np.float32)]

    def import_audio_item(self, audio_path: str, track_id: str | None = None, start_beat: float | None = None):
        """Import an audio file into the timeline.

        - If track_id is provided, place the item onto that track.
        - If track_id is None, create a new track.
        - If start_beat is provided, place the item at that beat (clamped to >= 0).

        This is a lightweight path: it does NOT run analysis (mel/f0) or require model.
        """
        try:
            audio_path = str(audio_path)
            source_path = str(pathlib.Path(audio_path))
            if not pathlib.Path(source_path).exists():
                raise FileNotFoundError(f'音频文件不存在: {source_path}')

            sr, channels = self._load_audio_for_preview(source_path)
            duration_sec = float(channels[0].size / sr) if sr > 0 and channels else 0.0
            if len(channels) >= 2:
                waveform_preview = {
                    'l': self._compute_waveform_preview(channels[0]),
                    'r': self._compute_waveform_preview(channels[1]),
                }
            else:
                waveform_preview = self._compute_waveform_preview(channels[0] if channels else np.zeros(0, dtype=np.float32))

            if track_id is not None:
                track_id = str(track_id).strip() or None

            if track_id is None:
                stem = pathlib.Path(source_path).stem.strip() or 'Imported'
                target_track_id = self._new_track_id()
                self.state.tracks[target_track_id] = TrackState(
                    id=target_track_id,
                    name=stem,
                    parent_id=None,
                    muted=False,
                    solo=False,
                    volume=0.9,
                )
                self.state.track_order.append(target_track_id)
            else:
                if track_id not in self.state.tracks:
                    raise RuntimeError('目标轨道不存在。')
                target_track_id = track_id

            self.state.selected_track_id = target_track_id

            clip_id = self._new_clip_id()
            start_beat_value = 0.0
            if start_beat is not None:
                start_beat_value = max(0.0, float(start_beat))
            clip = ClipState(
                id=clip_id,
                track_id=target_track_id,
                name=pathlib.Path(source_path).name,
                start_beat=start_beat_value,
                length_beats=max(0.25, float(duration_sec * self.state.bpm / 60.0) if duration_sec > 0 else 2.0),
                color='emerald',
                source_path=source_path,
                duration_sec=duration_sec,
                waveform_preview=waveform_preview,
                pitch_range={'min': -24.0, 'max': 24.0},
            )
            self.state.clips[clip_id] = clip
            self.state.tracks[target_track_id].clip_ids.append(clip_id)
            self.state.selected_clip_id = clip_id

            self._update_project_beats_from_clips()

            return {
                'ok': True,
                'track': asdict(self.state.tracks[target_track_id]),
                'clip': asdict(clip),
                **self._serialize_timeline(),
            }
        except Exception as exc:
            return self._error('import_audio_item_failed', exc)

    def import_audio_bytes(self, file_name: str, base64_data: str, track_id: str | None = None, start_beat: float | None = None):
        """Import audio from bytes when the WebView cannot provide a local path.

        The frontend passes a base64 payload (DataURL body). We persist it to a
        temp file and reuse the existing import_audio_item pipeline.
        """
        try:
            name = (file_name or '').strip() or 'dropped-audio'
            suffix = pathlib.Path(name).suffix or '.bin'
            drop_dir = pathlib.Path(tempfile.gettempdir()) / 'hifishifter_drops'
            drop_dir.mkdir(parents=True, exist_ok=True)
            tmp_path = drop_dir / f'{uuid.uuid4().hex}{suffix}'

            raw = base64.b64decode(base64_data, validate=False)
            tmp_path.write_bytes(raw)

            res = self.import_audio_item(str(tmp_path), track_id=track_id, start_beat=start_beat)
            if not isinstance(res, dict) or not res.get('ok'):
                return res

            # Preserve the original imported file name for UI display.
            # import_audio_item uses the persisted temp path's basename; override it.
            display_name = pathlib.Path(name).name.strip() or 'Imported'
            clip_id = (res.get('clip') or {}).get('id')
            if clip_id and clip_id in self.state.clips:
                self.state.clips[clip_id].name = display_name

            # If a new track was auto-created (track_id is None), keep the original stem.
            created_track_id = (res.get('track') or {}).get('id')
            if track_id is None and created_track_id and created_track_id in self.state.tracks:
                stem = pathlib.Path(display_name).stem.strip() or 'Imported'
                self.state.tracks[created_track_id].name = stem

            # Return a fresh serialization so frontend gets updated names.
            out: dict = {'ok': True, **self._serialize_timeline()}
            if created_track_id and created_track_id in self.state.tracks:
                out['track'] = asdict(self.state.tracks[created_track_id])
            if clip_id and clip_id in self.state.clips:
                out['clip'] = asdict(self.state.clips[clip_id])
            return out
        except Exception as exc:
            return self._error('import_audio_bytes_failed', exc)

    def _resample_linear(self, audio: np.ndarray, from_sr: int, to_sr: int):
        if from_sr == to_sr or audio.size <= 1:
            return np.asarray(audio, dtype=np.float32)
        duration = float(audio.size) / float(from_sr)
        dst_len = max(1, int(round(duration * to_sr)))
        src_pos = np.linspace(0.0, 1.0, num=audio.size, endpoint=True)
        dst_pos = np.linspace(0.0, 1.0, num=dst_len, endpoint=True)
        return np.interp(dst_pos, src_pos, audio).astype(np.float32)

    def _time_stretch_linear(self, audio: np.ndarray, rate: float):
        if audio.size <= 1:
            return np.asarray(audio, dtype=np.float32)
        rate = float(np.clip(rate, 0.25, 4.0))
        if abs(rate - 1.0) < 1e-6:
            return np.asarray(audio, dtype=np.float32)
        dst_len = max(1, int(round(audio.size / rate)))
        src_pos = np.linspace(0.0, 1.0, num=audio.size, endpoint=True)
        dst_pos = np.linspace(0.0, 1.0, num=dst_len, endpoint=True)
        return np.interp(dst_pos, src_pos, audio).astype(np.float32)

    def _resolve_clip_audio(self, clip: ClipState, target: str):
        if target == 'synthesized' and self.state.synthesized_audio is not None and self.state.sample_rate:
            if clip.source_path == self.state.audio_path:
                return int(self.state.sample_rate), np.asarray(self.state.synthesized_audio, dtype=np.float32)

        if not clip.source_path:
            return None
        source_path = str(pathlib.Path(clip.source_path))
        if not pathlib.Path(source_path).exists():
            return None
        return self._load_audio_file_mono(source_path)

    def _mix_project_audio(self, target: str, start_beat: float):
        sample_rate = int(self.state.sample_rate or self.processor.config.get('audio_sample_rate', 44100))
        bpm = max(1.0, float(self.state.bpm))
        start_beat = max(0.0, float(start_beat))
        start_sec = start_beat * 60.0 / bpm

        has_any_solo = any(track.solo for track in self.state.tracks.values())

        def _fade_in_curve(n: int) -> np.ndarray:
            if n <= 1:
                return np.ones(max(0, n), dtype=np.float32)
            t = np.linspace(0.0, 1.0, num=n, endpoint=True, dtype=np.float32)
            return np.sin(t * (math.pi / 2.0)).astype(np.float32)

        def _fade_out_curve(n: int) -> np.ndarray:
            if n <= 1:
                return np.ones(max(0, n), dtype=np.float32)
            t = np.linspace(0.0, 1.0, num=n, endpoint=True, dtype=np.float32)
            return np.cos(t * (math.pi / 2.0)).astype(np.float32)

        active_clips: list[tuple[ClipState, float, float]] = []
        max_end_sec = start_sec
        for clip in self.state.clips.values():
            if clip.muted:
                continue
            track = self.state.tracks.get(clip.track_id)
            if not track:
                continue
            if track.muted:
                continue
            if has_any_solo and not track.solo:
                continue

            track_gain = float(np.clip(getattr(track, 'volume', 1.0), 0.0, 2.0))

            desired_sec = max(0.0, float(clip.length_beats) * 60.0 / bpm)
            if desired_sec <= 1e-6:
                continue

            clip_start_sec = max(0.0, float(clip.start_beat) * 60.0 / bpm)

            # Buffer sizing: assume the clip occupies its timeline duration.
            # Actual audio is cropped to available source region later.
            clip_end_sec = clip_start_sec + desired_sec

            active_clips.append((clip, track_gain, desired_sec))
            max_end_sec = max(max_end_sec, clip_end_sec)

        if not active_clips:
            return sample_rate, np.zeros(0, dtype=np.float32)

        total_len = int(round(max(0.0, max_end_sec - start_sec) * sample_rate))
        if total_len <= 0:
            return sample_rate, np.zeros(0, dtype=np.float32)

        mix = np.zeros(total_len, dtype=np.float32)

        for clip, track_gain, desired_sec in active_clips:
            resolved = self._resolve_clip_audio(clip, target)
            if not resolved:
                continue
            src_sr, src_audio = resolved
            clip_audio = self._resample_linear(src_audio, src_sr, sample_rate)
            clip_audio = self._time_stretch_linear(clip_audio, clip.playback_rate)

            src_total_sec = float(clip_audio.size) / float(sample_rate) if sample_rate > 0 else 0.0
            trim_start_sec = max(0.0, float(clip.trim_start_beat) * 60.0 / bpm)
            trim_end_sec = max(0.0, float(clip.trim_end_beat) * 60.0 / bpm)
            available_sec = max(0.0, src_total_sec - trim_start_sec - trim_end_sec)
            render_sec = min(max(0.0, desired_sec), available_sec)
            if render_sec <= 1e-6:
                continue

            start_idx_in_src = int(round(trim_start_sec * sample_rate))
            end_idx_in_src = min(
                clip_audio.size,
                start_idx_in_src + int(round(render_sec * sample_rate)),
            )
            if end_idx_in_src <= start_idx_in_src:
                continue

            segment = clip_audio[start_idx_in_src:end_idx_in_src]
            segment = segment * float(np.clip(track_gain * float(clip.gain), 0.0, 2.0))

            # Apply clip fades (curved), after trims and gain.
            fade_in_sec = max(0.0, float(getattr(clip, 'fade_in_beats', 0.0)) * 60.0 / bpm)
            fade_out_sec = max(0.0, float(getattr(clip, 'fade_out_beats', 0.0)) * 60.0 / bpm)
            if segment.size > 1:
                if fade_in_sec > 1e-6:
                    n = int(round(fade_in_sec * sample_rate))
                    n = max(0, min(n, segment.size))
                    if n > 1:
                        segment[:n] *= _fade_in_curve(n)
                if fade_out_sec > 1e-6:
                    n = int(round(fade_out_sec * sample_rate))
                    n = max(0, min(n, segment.size))
                    if n > 1:
                        segment[-n:] *= _fade_out_curve(n)

            clip_start_sec = max(0.0, float(clip.start_beat) * 60.0 / bpm)
            dst_start = int(round((clip_start_sec - start_sec) * sample_rate))
            if dst_start < 0:
                trim = -dst_start
                if trim >= segment.size:
                    continue
                segment = segment[trim:]
                dst_start = 0

            dst_end = min(mix.size, dst_start + segment.size)
            if dst_end <= dst_start:
                continue
            mix[dst_start:dst_end] += segment[: dst_end - dst_start]

        mix = np.clip(mix, -1.0, 1.0)
        return sample_rate, mix.astype(np.float32)

    def play_original(self, start_sec: float = 0.0):
        try:
            playhead_beat = self.state.playhead_beat
            return self._start_stream_playback('original', playhead_beat)
        except Exception as exc:
            return self._error('play_original_failed', exc)

    def play_synthesized(self, start_sec: float = 0.0):
        try:
            playhead_beat = self.state.playhead_beat
            return self._start_stream_playback('synthesized', playhead_beat)
        except Exception as exc:
            return self._error('play_synthesized_failed', exc)

    def stop_audio(self):
        try:
            self._stop_playback_stream()
            sd.stop()
            self._clear_playback_state()
            return {'ok': True}
        except Exception as exc:
            return self._error('stop_audio_failed', exc)

    def _stop_playback_stream(self):
        with self._playback_lock:
            stream = self._playback_stream
            self._playback_stream = None
            self._playback_plan = None
        if stream is None:
            return
        try:
            stream.stop()
        except Exception:
            pass
        try:
            stream.close()
        except Exception:
            pass

    def _get_cached_clip_audio(self, clip: ClipState, target: str, sample_rate: int) -> np.ndarray | None:
        resolved = self._resolve_clip_audio(clip, target)
        if not resolved:
            return None
        src_sr, src_audio = resolved
        src_sr = int(src_sr)
        sample_rate = int(sample_rate)
        if sample_rate <= 0 or src_sr <= 0:
            return None

        cache_key: tuple
        # File-backed audio
        if clip.source_path:
            try:
                p = pathlib.Path(str(clip.source_path))
                st = p.stat() if p.exists() else None
                mtime_ns = int(st.st_mtime_ns) if st else 0
                size = int(st.st_size) if st else 0
                cache_key = (
                    'file',
                    target,
                    str(p),
                    mtime_ns,
                    size,
                    src_sr,
                    sample_rate,
                    float(getattr(clip, 'playback_rate', 1.0)),
                )
            except Exception:
                cache_key = (
                    'file',
                    target,
                    str(clip.source_path),
                    src_sr,
                    sample_rate,
                    float(getattr(clip, 'playback_rate', 1.0)),
                )
        else:
            # In-memory synthesized audio
            cache_key = (
                'mem',
                target,
                id(src_audio),
                int(getattr(src_audio, 'shape', [0])[-1] if hasattr(src_audio, 'shape') else 0),
                src_sr,
                sample_rate,
                float(getattr(clip, 'playback_rate', 1.0)),
            )

        cached = self._render_cache.get(cache_key)
        if cached is not None:
            return cached

        audio = self._resample_linear(np.asarray(src_audio, dtype=np.float32), src_sr, sample_rate)
        audio = self._time_stretch_linear(audio, float(getattr(clip, 'playback_rate', 1.0)))
        self._render_cache[cache_key] = audio
        return audio

    def _build_stream_mix_plan(self, target: str, start_beat: float):
        sample_rate = int(self.state.sample_rate or self.processor.config.get('audio_sample_rate', 44100))
        bpm = max(1.0, float(self.state.bpm))
        start_beat = max(0.0, float(start_beat))
        start_sec = start_beat * 60.0 / bpm

        has_any_solo = any(track.solo for track in self.state.tracks.values())
        clips: list[_PlaybackClipPlan] = []
        max_end_sec = start_sec

        for clip in self.state.clips.values():
            if clip.muted:
                continue
            track = self.state.tracks.get(clip.track_id)
            if not track:
                continue
            if track.muted:
                continue
            if has_any_solo and not track.solo:
                continue

            track_gain = float(np.clip(getattr(track, 'volume', 1.0), 0.0, 2.0))
            desired_sec = max(0.0, float(clip.length_beats) * 60.0 / bpm)
            if desired_sec <= 1e-6:
                continue
            clip_start_sec = max(0.0, float(clip.start_beat) * 60.0 / bpm)
            clip_end_sec = clip_start_sec + desired_sec
            max_end_sec = max(max_end_sec, clip_end_sec)

            clip_audio = self._get_cached_clip_audio(clip, target, sample_rate)
            if clip_audio is None or clip_audio.size <= 1:
                continue

            src_total_sec = float(clip_audio.size) / float(sample_rate)
            trim_start_sec = max(0.0, float(clip.trim_start_beat) * 60.0 / bpm)
            trim_end_sec = max(0.0, float(clip.trim_end_beat) * 60.0 / bpm)
            available_sec = max(0.0, src_total_sec - trim_start_sec - trim_end_sec)
            render_sec = min(max(0.0, desired_sec), available_sec)
            if render_sec <= 1e-6:
                continue

            src_start = int(round(trim_start_sec * sample_rate))
            render_len = int(round(render_sec * sample_rate))
            if render_len <= 0:
                continue
            if src_start < 0:
                src_start = 0
            if src_start >= clip_audio.size:
                continue
            if src_start + render_len > clip_audio.size:
                render_len = int(clip_audio.size - src_start)
            if render_len <= 0:
                continue

            fade_in_sec = max(0.0, float(getattr(clip, 'fade_in_beats', 0.0)) * 60.0 / bpm)
            fade_out_sec = max(0.0, float(getattr(clip, 'fade_out_beats', 0.0)) * 60.0 / bpm)
            fade_in_n = int(round(fade_in_sec * sample_rate)) if fade_in_sec > 1e-6 else 0
            fade_out_n = int(round(fade_out_sec * sample_rate)) if fade_out_sec > 1e-6 else 0
            fade_in_n = max(0, min(fade_in_n, render_len))
            fade_out_n = max(0, min(fade_out_n, render_len))

            fade_in = None
            if fade_in_n > 1:
                t = np.linspace(0.0, 1.0, num=fade_in_n, endpoint=True, dtype=np.float32)
                fade_in = np.sin(t * (math.pi / 2.0)).astype(np.float32)

            fade_out = None
            if fade_out_n > 1:
                t = np.linspace(0.0, 1.0, num=fade_out_n, endpoint=True, dtype=np.float32)
                fade_out = np.cos(t * (math.pi / 2.0)).astype(np.float32)

            gain = float(np.clip(track_gain * float(getattr(clip, 'gain', 1.0)), 0.0, 2.0))
            dst_start = int(round((clip_start_sec - start_sec) * sample_rate))
            fade_out_start = max(0, render_len - (fade_out_n if fade_out is not None else 0))
            clips.append(
                _PlaybackClipPlan(
                    clip_id=str(clip.id),
                    dst_start=dst_start,
                    render_len=render_len,
                    src_audio=clip_audio,
                    src_start=src_start,
                    gain=gain,
                    fade_in=fade_in,
                    fade_out=fade_out,
                    fade_out_start=fade_out_start,
                )
            )

        total_len = int(round(max(0.0, max_end_sec - start_sec) * sample_rate))
        if total_len <= 0 or not clips:
            return sample_rate, 0, []
        return sample_rate, total_len, clips

    def _start_stream_playback(self, target: str, anchor_beat: float):
        anchor_beat = max(0.0, float(anchor_beat))
        # Stop any existing stream first.
        self._stop_playback_stream()
        sd.stop()

        try:
            sample_rate, total_len, clips = self._build_stream_mix_plan(target, anchor_beat)
            if total_len <= 0 or not clips:
                duration_sec = self._project_duration_sec_from_beat(anchor_beat)
                payload = self._start_virtual_playback(target, duration_sec, 0.0)
                payload['anchorBeat'] = anchor_beat
                payload['clipId'] = None
                payload['playing'] = target
                return payload

            # Freeze plan for callback thread.
            plan = {
                'sample_rate': int(sample_rate),
                'total_len': int(total_len),
                'clips': clips,
            }

            # Use a small blocksize for lower latency. Keep mono output for now.
            pos = 0

            def callback(outdata, frames, _time_info, status):
                nonlocal pos
                if status:
                    # Keep callback running even if backend reports xruns.
                    pass
                sr = plan['sample_rate']
                total = plan['total_len']
                clip_plans: list[_PlaybackClipPlan] = plan['clips']

                if pos >= total:
                    outdata.fill(0)
                    raise sd.CallbackStop

                block_len = min(int(frames), int(total - pos))
                out = np.zeros(int(frames), dtype=np.float32)

                block_start = int(pos)
                block_end = int(pos + block_len)

                for c in clip_plans:
                    clip_start = int(c.dst_start)
                    clip_end = int(c.dst_start + c.render_len)
                    if clip_end <= block_start or clip_start >= block_end:
                        continue

                    overlap_start = max(block_start, clip_start)
                    overlap_end = min(block_end, clip_end)
                    n = int(overlap_end - overlap_start)
                    if n <= 0:
                        continue

                    out_off = int(overlap_start - block_start)
                    rel0 = int(overlap_start - clip_start)
                    src0 = int(c.src_start + rel0)
                    src1 = int(src0 + n)
                    if src0 < 0:
                        # Shouldn't happen, but keep safe.
                        trim = -src0
                        src0 = 0
                        out_off += trim
                    if src1 > c.src_audio.size:
                        src1 = int(c.src_audio.size)
                    n2 = int(src1 - src0)
                    if n2 <= 0 or out_off >= out.size:
                        continue

                    seg = np.asarray(c.src_audio[src0:src1], dtype=np.float32) * float(c.gain)

                    # Fade-in
                    if c.fade_in is not None and rel0 < c.fade_in.size:
                        k = int(min(n2, int(c.fade_in.size - rel0)))
                        if k > 0:
                            seg[:k] *= c.fade_in[rel0 : rel0 + k]

                    # Fade-out
                    if c.fade_out is not None:
                        if rel0 + n2 > c.fade_out_start:
                            i_start = int(max(0, c.fade_out_start - rel0))
                            f0 = int(max(0, rel0 - c.fade_out_start))
                            k = int(
                                min(
                                    n2 - i_start,
                                    int(c.fade_out.size - f0),
                                )
                            )
                            if k > 0:
                                seg[i_start : i_start + k] *= c.fade_out[f0 : f0 + k]

                    out[out_off : out_off + n2] += seg[:n2]

                np.clip(out, -1.0, 1.0, out=out)
                if outdata.ndim == 2 and outdata.shape[1] >= 1:
                    outdata[:block_len, 0] = out[:block_len]
                    if block_len < frames:
                        outdata[block_len:, 0] = 0
                else:
                    outdata[:block_len] = out[:block_len]
                    if block_len < frames:
                        outdata[block_len:] = 0

                pos = int(pos + frames)

            def finished():
                # Stream ended normally; clear state.
                self._stop_playback_stream()
                self._clear_playback_state()

            stream = sd.OutputStream(
                samplerate=int(sample_rate),
                channels=1,
                dtype='float32',
                blocksize=256,
                latency='low',
                callback=callback,
                finished_callback=finished,
            )

            with self._playback_lock:
                self._playback_stream = stream
                self._playback_plan = plan

            stream.start()

            self.state.playback_target = target
            self.state.playback_started_at = time.monotonic()
            self.state.playback_start_sec = 0.0
            self.state.playback_duration_sec = float(total_len / sample_rate)

            return {
                'ok': True,
                'playing': target,
                'start_sec': 0.0,
                'duration_sec': self.state.playback_duration_sec,
                'is_playing': True,
                'anchorBeat': anchor_beat,
                'clipId': None,
            }
        except Exception:
            # Fallback to the old full-mix path if the stream backend is unavailable.
            playhead_beat = anchor_beat
            sample_rate, mixed = self._mix_project_audio(target, playhead_beat)
            if mixed.size == 0:
                duration_sec = self._project_duration_sec_from_beat(playhead_beat)
                payload = self._start_virtual_playback(target, duration_sec, 0.0)
                payload['anchorBeat'] = anchor_beat
                payload['clipId'] = None
                payload['playing'] = target
                return payload
            payload = self._start_playback(target, mixed, sample_rate, 0.0)
            payload['anchorBeat'] = anchor_beat
            payload['clipId'] = None
            return payload

    def get_playback_state(self):
        try:
            payload = self._get_playback_state_internal()
            return {
                'ok': True,
                **payload,
            }
        except Exception as exc:
            return self._error('get_playback_state_failed', exc)

    def close_window(self):
        try:
            if not webview.windows:
                return {'ok': True}
            webview.windows[0].destroy()
            return {'ok': True}
        except Exception as exc:
            return self._error('close_window_failed', exc)

    def open_audio_dialog(self):
        try:
            if not webview.windows:
                raise RuntimeError('窗口尚未准备好。')

            result = webview.windows[0].create_file_dialog(
                webview.OPEN_DIALOG,
                allow_multiple=False,
                file_types=('Audio Files (*.wav;*.flac;*.mp3;*.ogg;*.m4a)', 'All files (*.*)'),
            )
            if not result:
                return {'ok': True, 'canceled': True}

            if isinstance(result, (list, tuple)):
                audio_path = str(result[0])
            else:
                audio_path = str(result)

            return {
                'ok': True,
                'canceled': False,
                'path': audio_path,
            }
        except Exception as exc:
            return self._error('open_audio_dialog_failed', exc)

    def pick_output_path(self):
        try:
            if not webview.windows:
                raise RuntimeError('窗口尚未准备好。')

            result = webview.windows[0].create_file_dialog(
                webview.SAVE_DIALOG,
                save_filename='output.wav',
                file_types=('WAV file (*.wav)', 'All files (*.*)'),
            )
            if not result:
                return {'ok': True, 'canceled': True}

            if isinstance(result, (list, tuple)):
                output_path = str(result[0])
            else:
                output_path = str(result)

            return {
                'ok': True,
                'canceled': False,
                'path': output_path,
            }
        except Exception as exc:
            return self._error('pick_output_path_failed', exc)

    def save_synthesized(self, output_path: str):
        try:
            if self.state.synthesized_audio is None:
                raise RuntimeError('当前没有可保存的合成结果。')

            output = pathlib.Path(output_path)
            output.parent.mkdir(parents=True, exist_ok=True)
            sr = int(self.state.sample_rate or self.processor.config.get('audio_sample_rate', 44100))
            wavfile.write(str(output), sr, self.state.synthesized_audio.astype(np.float32))
            return {
                'ok': True,
                'path': str(output),
                'sample_rate': sr,
                'num_samples': int(self.state.synthesized_audio.shape[-1]),
            }
        except Exception as exc:
            return self._error('save_synthesized_failed', exc)

    def _start_playback(self, target: str, audio: np.ndarray, sample_rate: int, start_sec: float):
        sample_rate = int(sample_rate)
        if sample_rate <= 0:
            raise RuntimeError('无效采样率，无法播放。')

        start_sec = max(0.0, float(start_sec))
        start_idx = int(round(start_sec * sample_rate))
        start_idx = max(0, min(start_idx, int(audio.shape[-1])))

        sd.stop()
        chunk = np.asarray(audio[start_idx:], dtype=np.float32)
        if chunk.size <= 0:
            self._clear_playback_state()
            return {
                'ok': True,
                'playing': target,
                'start_sec': start_sec,
                'duration_sec': float(audio.shape[-1] / sample_rate),
                'is_playing': False,
            }

        # Try lower-latency playback; fall back to default on unsupported backends.
        try:
            sd.play(
                chunk,
                sample_rate,
                blocking=False,
                latency='low',
                blocksize=512,
            )
        except Exception:
            sd.play(chunk, sample_rate)
        self.state.playback_target = target
        self.state.playback_started_at = time.monotonic()
        self.state.playback_start_sec = start_sec
        self.state.playback_duration_sec = float(audio.shape[-1] / sample_rate)

        return {
            'ok': True,
            'playing': target,
            'start_sec': start_sec,
            'duration_sec': self.state.playback_duration_sec,
            'is_playing': True,
        }

    def _project_duration_sec_from_beat(self, start_beat: float) -> float:
        bpm = max(1.0, float(self.state.bpm or 120.0))
        start_beat = max(0.0, float(start_beat))
        project_beats = max(0.0, float(self.state.project_beats or 0.0))
        remaining_beats = max(0.0, project_beats - start_beat)
        # Ensure transport can move even when project length is 0.
        return max(1.0, remaining_beats * 60.0 / bpm)

    def _start_virtual_playback(self, target: str, duration_sec: float, start_sec: float):
        """Start a silent playback clock without audio output.

        This keeps the transport moving even when there's no audio to play.
        """
        duration_sec = max(0.0, float(duration_sec))
        start_sec = max(0.0, float(start_sec))

        sd.stop()
        self.state.playback_target = target
        self.state.playback_started_at = time.monotonic()
        self.state.playback_start_sec = start_sec
        self.state.playback_duration_sec = duration_sec

        return {
            'ok': True,
            'playing': target,
            'start_sec': start_sec,
            'duration_sec': duration_sec,
            'is_playing': True,
        }

    def _clear_playback_state(self):
        self.state.playback_target = None
        self.state.playback_started_at = None
        self.state.playback_start_sec = 0.0
        self.state.playback_duration_sec = 0.0

    def _get_playback_state_internal(self):
        target = self.state.playback_target
        started_at = self.state.playback_started_at
        if not target or started_at is None:
            return {
                'is_playing': False,
                'target': None,
                'position_sec': 0.0,
                'duration_sec': 0.0,
            }

        elapsed = max(0.0, time.monotonic() - started_at)
        position = self.state.playback_start_sec + elapsed
        duration = float(self.state.playback_duration_sec)
        if position >= duration:
            self._clear_playback_state()
            return {
                'is_playing': False,
                'target': target,
                'position_sec': duration,
                'duration_sec': duration,
            }

        return {
            'is_playing': True,
            'target': target,
            'position_sec': position,
            'duration_sec': duration,
        }

    def _error(self, code: str, exc: Exception):
        return {
            'ok': False,
            'error': {
                'code': code,
                'message': str(exc),
                'traceback': traceback.format_exc(limit=3),
            },
        }
