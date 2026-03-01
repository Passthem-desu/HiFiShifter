# Spec: VAD-Based Silence Skipping

## ADDED Requirements

### Requirement: RMS-based voice activity detection
The system SHALL detect voiced and unvoiced (silent) regions using RMS energy thresholding.

#### Scenario: Default RMS threshold
- **WHEN** VAD classifies audio frames without explicit configuration
- **THEN** system SHALL use 0.02 RMS threshold (~-34 dBFS)

#### Scenario: Custom RMS threshold via environment variable
- **WHEN** user sets `HIFISHIFTER_VAD_RMS_THRESHOLD=0.05`
- **THEN** system SHALL classify frames with RMS <0.05 as unvoiced

#### Scenario: 50ms window size
- **WHEN** computing RMS for VAD
- **THEN** system SHALL use 50ms non-overlapping windows for classification

#### Scenario: Voiced range extraction
- **WHEN** VAD completes on audio buffer
- **THEN** system SHALL return list of sample ranges classified as voiced (RMS ≥ threshold)

### Requirement: Adjacent voiced range merging
The system SHALL merge voiced ranges separated by short gaps to reduce fragmentation.

#### Scenario: Default merge gap threshold
- **WHEN** two voiced ranges are separated by less than 50ms
- **THEN** system SHALL merge them into single contiguous range

#### Scenario: Custom merge gap via environment variable
- **WHEN** user sets `HIFISHIFTER_VAD_MERGE_GAP_MS=100`
- **THEN** system SHALL merge ranges with gaps ≤100ms

#### Scenario: Prevent over-fragmentation
- **WHEN** brief signal dips create small gaps (e.g., plosives, breaths)
- **THEN** merged ranges SHALL span across gaps, avoiding excessive chunk splitting

### Requirement: Selective WORLD analysis on voiced segments
The system SHALL execute WORLD F0 detection only on voiced ranges, skipping unvoiced regions.

#### Scenario: WORLD calls limited to voiced ranges
- **WHEN** VAD identifies voiced and unvoiced regions
- **THEN** system SHALL invoke WORLD Harvest only on voiced sample ranges

#### Scenario: Unvoiced regions padded with zero F0
- **WHEN** unvoiced range is encountered in timeline
- **THEN** system SHALL fill corresponding F0 frames with 0.0 (no pitch)

#### Scenario: Timeline continuity preserved
- **WHEN** mixing voiced and unvoiced F0 segments
- **THEN** output F0 curve SHALL maintain correct temporal alignment (no gaps or overlaps)

### Requirement: Performance improvement from silence skipping
The system SHALL achieve measurable speedup by avoiding analysis of silent regions.

#### Scenario: Typical vocal recording speedup
- **WHEN** analyzing vocal recording with 30-50% silence
- **THEN** analysis time SHALL reduce by 30-50% compared to non-VAD baseline

#### Scenario: Skip ratio logging
- **WHEN** debug logging is enabled
- **THEN** system SHALL log percentage of silent frames skipped (e.g., "VAD: 45% voiced, skipped 55% silence")

### Requirement: Conservative threshold to avoid false negatives
The system SHALL use conservative RMS threshold to minimize risk of skipping actual voice content.

#### Scenario: Quiet voice detection
- **WHEN** audio contains whispered or soft singing (RMS ~0.01-0.03)
- **THEN** system SHALL still classify frames as voiced with default 0.02 threshold

#### Scenario: Room noise rejection
- **WHEN** audio contains typical room noise (RMS ~0.005)
- **THEN** system SHALL classify frames as unvoiced, skipping analysis

#### Scenario: Manual threshold adjustment for noisy recordings
- **WHEN** recording has high noise floor (RMS >0.02)
- **THEN** user SHALL be able to raise threshold via `HIFISHIFTER_VAD_RMS_THRESHOLD` to avoid false voiced detection
