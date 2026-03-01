## ADDED Requirements

### Requirement: Waveform rendering SHALL use incremental drawing strategy
Large audio files MUST render in chunks to avoid blocking the UI thread.

#### Scenario: Small files render in single pass
- **WHEN** audio file duration < 30 seconds
- **THEN** waveform SHALL render in one frame without chunking

#### Scenario: Large files split into chunks
- **WHEN** audio file duration >= 30 seconds
- **THEN** waveform SHALL be divided into 5-second chunks for incremental rendering

#### Scenario: Chunks render sequentially via requestAnimationFrame
- **WHEN** incremental rendering starts
- **THEN** each chunk SHALL be drawn in a separate animation frame to maintain 60fps

### Requirement: Unrendered regions SHALL display placeholder graphics
During incremental rendering, incomplete portions MUST be visually indicated.

#### Scenario: Show skeleton loading for pending chunks
- **WHEN** chunk is not yet rendered
- **THEN** UI SHALL display a gray skeleton placeholder in that time range

#### Scenario: Skeleton disappears when chunk completes
- **WHEN** chunk finishes drawing
- **THEN** placeholder SHALL be replaced with actual waveform data

### Requirement: Viewport-based prioritization SHALL optimize visible area
Rendering SHALL prioritize chunks visible in the current viewport.

#### Scenario: Visible chunks render first
- **WHEN** incremental rendering starts
- **THEN** chunks in current viewport SHALL render before offscreen chunks

#### Scenario: Scrolling triggers priority rendering
- **WHEN** user scrolls to unrendered region
- **THEN** newly visible chunks SHALL render within 100ms

#### Scenario: Debounced scroll rendering
- **WHEN** user rapidly scrolls
- **THEN** rendering SHALL wait 100ms after scroll stops before prioritizing new viewport

### Requirement: Rendering progress SHALL be trackable
Frontend MUST know how much of the waveform has been rendered.

#### Scenario: Progress state tracks rendered chunks
- **WHEN** incremental rendering is active
- **THEN** frontend state SHALL maintain {total_chunks, rendered_chunks} counters

#### Scenario: Progress reaches 100% on completion
- **WHEN** all chunks are rendered
- **THEN** rendered_chunks SHALL equal total_chunks

### Requirement: Canvas SHALL support partial updates
Drawing operations MUST not redraw entire canvas on each chunk.

#### Scenario: New chunk draws only its region
- **WHEN** rendering chunk at time offset T
- **THEN** canvas drawing SHALL affect only pixels in range [T_start, T_end]

#### Scenario: Existing chunks remain unchanged
- **WHEN** new chunk is drawn
- **THEN** previously rendered chunks SHALL not be redrawn

### Requirement: Rendering SHALL be cancellable
User MUST be able to abort slow waveform rendering.

#### Scenario: Cancel active rendering
- **WHEN** user navigates away or closes waveform view during rendering
- **THEN** remaining chunks SHALL not be rendered and requestAnimationFrame SHALL be cancelled

#### Scenario: Restart rendering after cancellation
- **WHEN** user returns to waveform view after cancellation
- **THEN** rendering SHALL restart from beginning
