# Pitch Analysis Performance Optimization for Long Clips

## Why

Current pitch analysis (`compute_pitch_curve`) can take minutes on long audio files (>5 minutes), blocking the UI and causing poor user experience. The entire audio is analyzed at 44.1 kHz, even though F0 detection only needs 8-16 kHz resolution. Additionally, silent/unvoiced regions are fully processed despite containing no pitch information. This change optimizes analysis speed by 5-10x through intelligent downsampling, chunked processing, and silence skipping.

## What Changes

- **Reduce analysis sample rate**: Downsample to 16 kHz (configurable) before WORLD analysis, dramatically reducing computation
- **Chunked long-clip processing**: Split clips longer than 30s into overlapping chunks with crossfade merging, preventing memory spikes and enabling parallel processing
- **VAD-based silence skipping**: Use RMS-based voice activity detection to skip silent regions, only analyzing voiced segments
- **Configurable thresholds**: Expose environment variables for analysis SR, chunk size, silence threshold, and parallel clip limit
- **Progress granularity**: Report per-chunk progress instead of per-clip for better UX on long files

## Capabilities

### New Capabilities
- `pitch-analysis-sr`: Configurable analysis sample rate with automatic resampling and upsampling pipeline
- `pitch-long-clip-chunked`: Chunked processing with context padding and crossfade merging for clips exceeding threshold
- `pitch-silence-skip`: VAD-based silence detection and segment skipping with configurable RMS threshold

### Modified Capabilities
<!-- No existing spec requirements are changing - this is purely performance optimization -->

## Impact

**Affected Code**:
- `backend/src-tauri/src/pitch_analysis.rs`: Core analysis pipeline modifications
- `backend/src-tauri/src/pitch_config.rs`: New configuration fields and environment variable loading
- `backend/src-tauri/src/commands/pitch_refresh_async.rs`: Progress reporting granularity changes

**Performance**:
- Analysis time: 60-90% reduction for long files (5+ minutes)
- Memory: Peak memory capped by chunk size (typically 30s audio ~7 MB @ 44.1k stereo)
- Parallelism: Can process multiple clips simultaneously with `HIFISHIFTER_PITCH_PARALLEL_CLIPS`

**Compatibility**:
- No breaking changes - all optimizations are transparent to existing code
- Output F0 curves maintain same format and timeline alignment
- Environment variables are optional (sensible defaults provided)
