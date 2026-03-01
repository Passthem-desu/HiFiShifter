## ADDED Requirements

### Requirement: UI SHALL display loading indicator during async operations
When pitch refresh or waveform loading is in progress, user MUST see visual feedback.

#### Scenario: Loading spinner appears on operation start
- **WHEN** user clicks refresh button and async task starts
- **THEN** UI SHALL display a loading spinner within 50ms

#### Scenario: Loading text describes current operation
- **WHEN** loading indicator is visible
- **THEN** text SHALL display operation description (e.g., "Refreshing pitch data...")

#### Scenario: Loading indicator disappears on completion
- **WHEN** async operation completes successfully
- **THEN** loading indicator SHALL fade out after showing success state for 500ms

#### Scenario: Error state replaces loading indicator
- **WHEN** async operation fails
- **THEN** loading indicator SHALL be replaced with error message and retry button

### Requirement: Progress percentage SHALL be displayed for trackable operations
Operations with progress tracking MUST show percentage completion.

#### Scenario: Progress bar shows percentage
- **WHEN** pitch refresh task reports progress
- **THEN** UI SHALL display progress bar with percentage (e.g., "45%")

#### Scenario: Progress updates every 500ms
- **WHEN** async operation is running
- **THEN** progress SHALL refresh at least every 500ms via polling

#### Scenario: Progress bar fills from 0% to 100%
- **WHEN** operation progresses
- **THEN** progress bar fill SHALL smoothly animate to new percentage

### Requirement: UI SHALL provide cancel button for long operations
User MUST be able to abort operations that take >2 seconds.

#### Scenario: Cancel button appears after 2 seconds
- **WHEN** operation runs longer than 2 seconds
- **THEN** UI SHALL show a "Cancel" button next to loading indicator

#### Scenario: Cancel button triggers abort command
- **WHEN** user clicks cancel button
- **THEN** frontend SHALL call cancel_pitch_task() or equivalent abort API

#### Scenario: Cancel button shows cancelling state
- **WHEN** user clicks cancel and abort is in progress
- **THEN** button SHALL change to "Cancelling..." with disabled state

#### Scenario: Cancel button disappears on completion
- **WHEN** operation completes or cancellation succeeds
- **THEN** cancel button SHALL be removed from UI

### Requirement: Estimated time remaining SHALL be shown when available
For operations with progress, system SHOULD estimate completion time.

#### Scenario: ETA calculated after 10% progress
- **WHEN** operation reaches 10% completion
- **THEN** UI SHALL display estimated time remaining (e.g., "~30s remaining")

#### Scenario: ETA updates as progress advances
- **WHEN** operation progresses beyond 10%
- **THEN** ETA SHALL recalculate every 5 seconds based on average speed

#### Scenario: ETA hidden if unreliable
- **WHEN** remaining time estimate varies >50% between updates
- **THEN** ETA SHALL be hidden and only percentage shown

### Requirement: Loading state SHALL block user interaction with affected component
UI MUST prevent conflicting actions during async operations.

#### Scenario: Refresh button disabled while loading
- **WHEN** pitch refresh is in progress
- **THEN** refresh button SHALL be disabled and show loading indicator inside

#### Scenario: Waveform edits blocked during rendering
- **WHEN** waveform incremental rendering is active
- **THEN** user SHALL not be able to add/edit clips in unrendered regions

#### Scenario: Component re-enabled on completion
- **WHEN** async operation completes
- **THEN** affected UI controls SHALL be re-enabled within 100ms

### Requirement: Loading state SHALL persist across component re-renders
React state management MUST preserve loading status during render cycles.

#### Scenario: Loading indicator survives parent re-render
- **WHEN** parent component re-renders while async operation is active
- **THEN** loading indicator SHALL remain visible without flickering

#### Scenario: Progress percentage survives re-render
- **WHEN** component re-renders during progress updates
- **THEN** progress bar SHALL maintain its current percentage
