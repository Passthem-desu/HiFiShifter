# Spec: Pitch Analysis Sample Rate

## ADDED Requirements

### Requirement: Configurable analysis sample rate
The system SHALL allow configuration of the pitch analysis sample rate independently from the project sample rate.

#### Scenario: Default 16 kHz analysis
- **WHEN** pitch analysis is triggered without explicit configuration
- **THEN** system SHALL downsample audio to 16 kHz before WORLD analysis

#### Scenario: Custom analysis sample rate via environment variable
- **WHEN** user sets `HIFISHIFTER_PITCH_ANALYSIS_SR=22050`
- **THEN** system SHALL use 22.05 kHz as the analysis sample rate

#### Scenario: Analysis sample rate bounds
- **WHEN** user sets analysis sample rate outside 8000-44100 range
- **THEN** system SHALL clamp to nearest valid bound (8k or 44.1k)

### Requirement: Automatic resampling pipeline
The system SHALL automatically resample audio for analysis and maintain timeline alignment.

#### Scenario: Downsample before analysis
- **WHEN** project audio is at 44.1 kHz and analysis SR is 16 kHz
- **THEN** system SHALL resample input PCM to 16 kHz before calling WORLD

#### Scenario: Timeline alignment preserved
- **WHEN** F0 curve is computed at 16 kHz with 5ms frame period
- **THEN** output MIDI curve SHALL align with original clip timeline (no time scaling)

#### Scenario: No upsampling of F0 curve
- **WHEN** F0 analysis completes at lower sample rate
- **THEN** system SHALL NOT upsample F0 curve (already in timeline units per frame period)

### Requirement: Performance improvement validation
The system SHALL achieve measurable speedup from downsampling without quality loss.

#### Scenario: Sub-second analysis for 1-minute clip
- **WHEN** analyzing 1-minute vocal clip at 16 kHz
- **THEN** analysis time SHALL be under 1 second on modern CPU (i5-8400 or better)

#### Scenario: F0 accuracy maintained
- **WHEN** comparing 16 kHz vs 44.1 kHz analysis output
- **THEN** median pitch error SHALL be less than 0.5 cents (±0.0003 semitones)

#### Scenario: Memory reduction
- **WHEN** analyzing clip at 16 kHz instead of 44.1 kHz
- **THEN** peak memory usage SHALL be at most 40% of original (proportional to SR ratio)
