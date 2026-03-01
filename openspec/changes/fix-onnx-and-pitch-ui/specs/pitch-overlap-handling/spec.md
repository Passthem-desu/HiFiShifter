## ADDED Requirements

### Requirement: System SHALL detect overlapping clip time ranges
The pitch analysis cache layer SHALL identify when multiple clips share the same audio time range on the same track.

#### Scenario: Two clips fully overlapping
- **WHEN** Clip A spans [0s, 5s] and Clip B spans [0s, 5s] on Track 1
- **THEN** system SHALL recognize these as identical time ranges requiring single analysis

#### Scenario: Partial overlap detection
- **WHEN** Clip A spans [0s, 5s] and Clip B spans [3s, 8s] on Track 1
- **THEN** system SHALL detect [3s, 5s] as overlapping region

#### Scenario: No overlap on different tracks
- **WHEN** Clip A spans [0s, 5s] on Track 1 and Clip B spans [0s, 5s] on Track 2
- **THEN** system SHALL treat as separate ranges (track ID differs)

### Requirement: Cache keys SHALL incorporate time range hashing
Pitch analysis cache keys SHALL be computed from (track_id, time_range_hash) instead of clip_id alone.

#### Scenario: Same time range reuses cache
- **WHEN** two clips on same track have identical start/end times
- **THEN** system SHALL generate identical cache key and reuse cached pitch data

#### Scenario: Different time ranges have distinct keys
- **WHEN** two clips on same track have different time ranges
- **THEN** system SHALL generate distinct cache keys

#### Scenario: Clip boundary micro-adjustment tolerates fuzzy match
- **WHEN** clip boundary adjusted by ≤10ms
- **THEN** system SHALL still match existing cache entry (fuzzy tolerance)

### Requirement: System SHALL avoid redundant F0 extraction for overlapping ranges
When multiple clips cover the same audio region, F0 extraction SHALL occur only once.

#### Scenario: Second overlapping clip skips extraction
- **WHEN** Clip A at [0s, 5s] completes analysis, then Clip B at [0s, 5s] requests analysis
- **THEN** system SHALL retrieve cached result without invoking WORLD vocoder

#### Scenario: Partial overlap extracts only new regions
- **WHEN** Clip A at [0s, 5s] cached, Clip B at [3s, 8s] requests analysis
- **THEN** system SHALL extract F0 only for [5s, 8s] and merge with cached [3s, 5s]

### Requirement: Cache SHALL handle clip split/merge operations
When users split or merge clips, cache invalidation SHALL be minimal.

#### Scenario: Split clip reuses parent cache
- **WHEN** Clip A at [0s, 10s] splits into B [0s, 5s] and C [5s, 10s]
- **THEN** B and C SHALL derive pitch data from A's cache without re-extraction

#### Scenario: Merged clips create combined cache entry
- **WHEN** Clip A at [0s, 5s] and B at [5s, 10s] merge into C at [0s, 10s]
- **THEN** system SHALL combine cached segments or re-analyze as single unit

### Requirement: Overlap handling SHALL preserve pitch accuracy
Cache reuse for overlapping clips MUST NOT degrade pitch curve quality or introduce discontinuities.

#### Scenario: Cached pitch matches original extraction
- **WHEN** clip reuses cached pitch data
- **THEN** pitch curve SHALL be bit-identical to fresh extraction result

#### Scenario: Segment boundaries maintain continuity
- **WHEN** merging cached segments for partial overlaps
- **THEN** system SHALL apply crossfade at segment boundaries to avoid phase jumps
