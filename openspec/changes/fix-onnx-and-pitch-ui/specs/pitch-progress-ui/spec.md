## ADDED Requirements

### Requirement: Backend SHALL expose pitch analysis progress state
The system SHALL maintain a shared progress state during pitch analysis operations, including total workload, completed items, current task description, and elapsed time.

#### Scenario: Progress state initialization
- **WHEN** pitch analysis task starts (multi-clip or single long clip)
- **THEN** progress state SHALL be initialized with total_clips count and start timestamp

#### Scenario: Progress state update
- **WHEN** each clip completes F0 extraction
- **THEN** completed_clips counter SHALL increment and current_task SHALL update to next clip name

#### Scenario: Progress state reset
- **WHEN** pitch analysis task completes or fails
- **THEN** progress state SHALL be cleared to allow new task tracking

### Requirement: Backend SHALL provide progress query command
The system SHALL expose a Tauri IPC command returning current pitch analysis progress.

#### Scenario: Query during active analysis
- **WHEN** frontend calls get_pitch_analysis_progress() during ongoing analysis
- **THEN** system SHALL return PitchProgressPayload with {total, completed, current_task, elapsed_ms}

#### Scenario: Query when no analysis active
- **WHEN** frontend calls get_pitch_analysis_progress() with no active analysis
- **THEN** system SHALL return None or empty payload

### Requirement: Frontend SHALL display real-time progress indicator
The UI SHALL show a progress bar/indicator when pitch analysis is in progress.

#### Scenario: Progress bar appears on analysis start
- **WHEN** user triggers pitch analysis (clip edit, algorithm switch)
- **THEN** progress bar SHALL appear showing "Analyzing pitch (0/N clips)"

#### Scenario: Progress updates every 500ms
- **WHEN** analysis is ongoing
- **THEN** UI SHALL poll backend every 500ms and update progress bar percentage

#### Scenario: Progress bar disappears on completion
- **WHEN** analysis completes successfully
- **THEN** progress bar SHALL fade out after 1 second

#### Scenario: Progress shows estimated time remaining
- **WHEN** at least 2 clips have been processed
- **THEN** UI SHALL display estimated remaining time based on average clip processing duration

### Requirement: Progress SHALL include meaningful task descriptions
Progress current_task field SHALL contain human-readable descriptions.

#### Scenario: Task description shows clip name
- **WHEN** analyzing a named clip
- **THEN** current_task SHALL display "Analyzing: <clip_name>"

#### Scenario: Task description shows file name for unnamed clips
- **WHEN** analyzing unnamed clip
- **THEN** current_task SHALL display "Analyzing: <source_file_basename>"
