from __future__ import annotations

import pathlib
import traceback
import time
from dataclasses import dataclass, field, asdict
from itertools import count

import numpy as np
import sounddevice as sd
import webview
from scipy.io import wavfile

from .audio_processor import AudioProcessor


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
                start_beat=max(0.0, float(start_beat if start_beat is not None else self.state.playhead_beat)),
                length_beats=max(0.25, float(length_beats if length_beats is not None else 2.0)),
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
    ):
        try:
            clip = self.state.clips.get(clip_id)
            if not clip:
                raise RuntimeError('音频块不存在。')

            if length_beats is not None:
                clip.length_beats = max(0.1, float(length_beats))
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

            self._update_project_beats_from_clips()

            return {
                'ok': True,
                'clip': asdict(clip),
                **self._serialize_timeline(),
            }
        except Exception as exc:
            return self._error('set_clip_state_failed', exc)

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
            if bpm is not None:
                self.state.bpm = float(np.clip(bpm, 10.0, 300.0))
            if playhead_beat is not None:
                self.state.playhead_beat = max(0.0, float(playhead_beat))
            return {
                'ok': True,
                'playhead_beat': self.state.playhead_beat,
                'bpm': self.state.bpm,
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

        self._audio_cache[source_path] = (int(sample_rate), audio)
        return int(sample_rate), audio

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

        active_clips: list[tuple[ClipState, float]] = []
        max_end_sec = start_sec
        for clip in self.state.clips.values():
            if clip.muted:
                continue
            if clip.track_id not in self.state.tracks:
                continue
            if not self._is_track_audible_under_solo(clip.track_id, has_any_solo):
                continue
            track_gain, track_muted = self._effective_track_gain_and_mute(clip.track_id)
            if track_muted or track_gain <= 0.0:
                continue

            clip_start_sec = max(0.0, clip.start_beat * 60.0 / bpm)
            clip_length_sec = max(0.0, clip.length_beats * 60.0 / bpm)
            if clip_start_sec + clip_length_sec <= start_sec:
                continue

            active_clips.append((clip, track_gain))
            max_end_sec = max(max_end_sec, clip_start_sec + clip_length_sec)

        if not active_clips:
            return sample_rate, np.zeros(0, dtype=np.float32)

        total_len = max(1, int(np.ceil((max_end_sec - start_sec) * sample_rate)))
        mix = np.zeros(total_len, dtype=np.float32)

        for clip, track_gain in active_clips:
            resolved = self._resolve_clip_audio(clip, target)
            if not resolved:
                continue
            src_sr, src_audio = resolved
            clip_audio = self._resample_linear(src_audio, src_sr, sample_rate)
            clip_audio = self._time_stretch_linear(clip_audio, clip.playback_rate)

            clip_total_sec = max(clip.length_beats * 60.0 / bpm, 1e-4)
            trim_start_sec = max(0.0, clip.trim_start_beat * 60.0 / bpm)
            trim_end_sec = max(0.0, clip.trim_end_beat * 60.0 / bpm)

            clip_available_sec = max(0.0, clip_total_sec - trim_start_sec - trim_end_sec)
            if clip_available_sec <= 1e-5:
                continue

            start_idx_in_src = int(round(trim_start_sec * sample_rate))
            end_idx_in_src = min(clip_audio.size, start_idx_in_src + int(round(clip_available_sec * sample_rate)))
            if end_idx_in_src <= start_idx_in_src:
                continue

            segment = clip_audio[start_idx_in_src:end_idx_in_src]
            segment = segment * float(np.clip(track_gain * clip.gain, 0.0, 2.0))

            clip_start_sec = max(0.0, clip.start_beat * 60.0 / bpm)
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
            sample_rate, mixed = self._mix_project_audio('original', playhead_beat)
            if mixed.size == 0:
                raise RuntimeError('当前时间点之后没有可播放的音频块。')
            return self._start_playback('original', mixed, sample_rate, 0.0)
        except Exception as exc:
            return self._error('play_original_failed', exc)

    def play_synthesized(self, start_sec: float = 0.0):
        try:
            playhead_beat = self.state.playhead_beat
            sample_rate, mixed = self._mix_project_audio('synthesized', playhead_beat)
            if mixed.size == 0:
                raise RuntimeError('当前时间点之后没有可播放的音频块。')
            return self._start_playback('synthesized', mixed, sample_rate, 0.0)
        except Exception as exc:
            return self._error('play_synthesized_failed', exc)

    def stop_audio(self):
        try:
            sd.stop()
            self._clear_playback_state()
            return {'ok': True}
        except Exception as exc:
            return self._error('stop_audio_failed', exc)

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

            return {
                'ok': True,
                'canceled': False,
                'path': str(result[0]),
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
