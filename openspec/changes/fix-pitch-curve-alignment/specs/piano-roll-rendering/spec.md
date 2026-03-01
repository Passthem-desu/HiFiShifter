## ADDED Requirements

### Requirement: Pitch curve SHALL align with timeline at all zoom levels

The piano roll rendering system SHALL render pitch curves such that each data point's horizontal position corresponds exactly to its timestamp on the timeline axis, maintaining consistent alignment across all zoom levels and scroll positions.

#### Scenario: Pitch curve starts at audio start time
- **WHEN** an audio clip starts at timeline position T seconds
- **THEN** the first pitch curve data point SHALL be rendered at the horizontal pixel position corresponding to T seconds on the timeline

#### Scenario: Pitch curve maintains alignment during zoom
- **WHEN** user changes zoom level (pixels per beat)
- **THEN** all pitch curve points SHALL remain horizontally aligned with their corresponding timeline positions
- **AND** the distance between any two points SHALL scale proportionally with the zoom level

#### Scenario: Pitch curve maintains alignment during scroll
- **WHEN** user scrolls the timeline horizontally
- **THEN** pitch curve points SHALL maintain their alignment with the timeline
- **AND** points moving out of view SHALL disappear at the correct timeline boundary

#### Scenario: Waveform and pitch curve alignment
- **WHEN** both waveform and pitch curve are visible
- **THEN** pitch curve SHALL align with corresponding waveform features
- **AND** peaks in pitch data SHALL align with corresponding audio events in the waveform

### Requirement: Frame-to-time conversion SHALL use consistent formula

All components involved in pitch curve rendering (data request, caching, rendering) SHALL use identical frame-to-time conversion formulas to avoid coordinate drift.

#### Scenario: Data request calculation matches rendering
- **WHEN** frontend requests pitch data for a time range [T1, T2]
- **THEN** the calculated start frame SHALL correspond exactly to T1 using formula: `frame = floor(T * 1000 / framePeriodMs)`
- **AND** rendering SHALL use inverse formula: `T = (frame * framePeriodMs) / 1000`

#### Scenario: Cache validity check uses same conversion
- **WHEN** system checks if cached data covers visible time range
- **THEN** the frame-to-time conversion SHALL match the rendering formula
- **AND** no coordinate drift SHALL occur due to inconsistent conversions

### Requirement: Coordinate transformation SHALL preserve precise timing

The rendering pipeline SHALL preserve timing precision throughout the transformation chain from frame numbers to canvas pixels, with rounding errors bounded to subpixel accuracy.

#### Scenario: Multiple transformations maintain precision
- **WHEN** a pitch point is transformed: frame → seconds → pixels
- **THEN** the cumulative rounding error SHALL be less than 0.5 pixels
- **AND** the same frame number SHALL always produce the same pixel position given identical view parameters

#### Scenario: Stride parameter handling
- **WHEN** pitch data is requested with stride S
- **THEN** the i-th data point SHALL correspond to frame `startFrame + i * S`
- **AND** rendering SHALL apply the same stride multiplication

## MODIFIED Requirements

### Requirement: Time range quantization SHALL not affect coordinate accuracy

**Previous behavior**: Time range was quantized with 20ms steps, potentially introducing alignment errors.

**New behavior**: Time range quantization (if retained) SHALL be validated to not introduce visible horizontal displacement of pitch curves.

#### Scenario: Quantization boundary case
- **WHEN** visible time range starts at an arbitrary time (not a multiple of quantization step)
- **THEN** pitch curve points SHALL still align with the unquantized timeline
- **AND** quantization SHALL only affect data request boundaries, not coordinate calculation

#### Scenario: Sub-quantization accuracy
- **WHEN** a pitch point falls between quantization boundaries
- **THEN** the point SHALL be rendered at its precise timestamp position
- **AND** not be rounded to the quantization grid

## Debugging & Verification Requirements

### Requirement: System SHALL provide alignment verification mechanisms

The system SHALL include debugging capabilities to verify and visualize pitch curve alignment with the timeline.

#### Scenario: Reference markers for known timestamps
- **WHEN** debugging mode is enabled
- **THEN** system SHALL render vertical lines at known audio timestamps (e.g., every second, every beat)
- **AND** overlay timestamp labels for visual verification

#### Scenario: Diagnostic logging
- **WHEN** pitch curve is rendered
- **THEN** system SHALL log (in debug mode):
  - Visible time range (start, duration)
  - Requested frame range and corresponding calculated times
  - First and last data point's frame, calculated time, and pixel position
  - Frame period value

#### Scenario: Waveform alignment grid
- **WHEN** debugging mode is enabled
- **THEN** system SHALL render vertical grid lines aligned with waveform features
- **AND** allow visual inspection of pitch curve alignment
