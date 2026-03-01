# Spec: Long Clip Chunked Processing

## ADDED Requirements

### Requirement: Chunked processing for long clips
The system SHALL split clips exceeding duration threshold into overlapping chunks for sequential processing.

#### Scenario: Default chunk size threshold
- **WHEN** clip duration exceeds 30 seconds
- **THEN** system SHALL split clip into 30-second chunks for analysis

#### Scenario: Custom chunk size via environment variable
- **WHEN** user sets `HIFISHIFTER_PITCH_CHUNK_SEC=60.0`
- **THEN** system SHALL use 60-second chunks instead of default

#### Scenario: Short clips not chunked
- **WHEN** clip duration is less than chunk threshold
- **THEN** system SHALL analyze entire clip without splitting

### Requirement: Context padding for chunk boundaries
The system SHALL add audio context padding around each chunk to eliminate WORLD edge artifacts.

#### Scenario: Default context padding
- **WHEN** extracting chunk from audio buffer
- **THEN** system SHALL add ±0.3 seconds context padding on both sides

#### Scenario: Custom context duration
- **WHEN** user sets `HIFISHIFTER_PITCH_CHUNK_CTX_SEC=0.5`
- **THEN** system SHALL use 0.5 seconds of context padding

#### Scenario: Context trimming after analysis
- **WHEN** WORLD analysis completes on padded chunk
- **THEN** system SHALL trim context frames from F0 output, keeping only core region

### Requirement: Crossfade merging at chunk boundaries
The system SHALL merge adjacent chunk F0 curves using linear crossfade to prevent discontinuities.

#### Scenario: Overlap region crossfade
- **WHEN** merging Chunk N and Chunk N+1
- **THEN** system SHALL linearly blend F0 values in the context overlap region (e.g., 0.3s)

#### Scenario: Smooth transition
- **WHEN** crossfade merge completes
- **THEN** F0 curve SHALL have no audible discontinuities at chunk boundaries (max slope change <0.5 semitones/frame)

#### Scenario: First and last chunks
- **WHEN** processing first or last chunk in clip
- **THEN** system SHALL apply crossfade only to interior boundary (no fade at clip edges)

### Requirement: Memory cap via chunking
The system SHALL limit peak memory usage regardless of clip duration through chunked processing.

#### Scenario: Memory cap for long clips
- **WHEN** analyzing 10-minute clip in 30-second chunks
- **THEN** peak memory SHALL be proportional to chunk size (~7 MB @ 44.1k stereo 30s), not total clip size

#### Scenario: Max segment truncation
- **WHEN** voiced segment exceeds `HIFISHIFTER_PITCH_MAX_SEGMENT_SEC` (default 60s)
- **THEN** system SHALL truncate segment at limit and pad remainder with f0=0.0

### Requirement: Per-chunk progress reporting
The system SHALL report progress at chunk granularity for long-running analyses.

#### Scenario: Chunk-level progress updates
- **WHEN** processing multi-chunk clip
- **THEN** system SHALL emit progress callback after each chunk completion

#### Scenario: Total chunks calculation
- **WHEN** analysis begins on multiple clips
- **THEN** system SHALL calculate total expected chunks across all clips and report cumulative progress

#### Scenario: Smooth progress for long clips
- **WHEN** analyzing single 300-second clip (10 chunks @ 30s)
- **THEN** progress SHALL update every 3-5 seconds (per chunk), not stay at 0% for minutes
