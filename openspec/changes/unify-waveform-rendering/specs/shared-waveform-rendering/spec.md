## ADDED Requirements

### Requirement: Waveform data processing

The system SHALL provide a unified function to process raw waveform peak data (min/max arrays) for rendering, including adaptive sampling, time range cropping, and amplitude normalization.

#### Scenario: Adaptive sampling for large datasets
- **WHEN** waveform peak data contains more than 2000 points
- **THEN** system SHALL apply stride-based sampling (stride=4 for >2000 points, stride=2 for >1000 points) to reduce rendering overhead

#### Scenario: Time range cropping
- **WHEN** processing waveform peaks for a visible time window
- **THEN** system SHALL only process data points within the visible time range plus a small margin

#### Scenario: Amplitude normalization
- **WHEN** processing waveform peaks with arbitrary amplitude range
- **THEN** system SHALL normalize amplitudes to fit within the target rendering space (e.g., 0-1 range)

### Requirement: Canvas waveform rendering

The system SHALL provide a function to render waveform peaks onto a Canvas 2D context with configurable colors, stroke, and fill styles.

#### Scenario: Render waveform as vertical bars
- **WHEN** rendering waveform peaks to Canvas
- **THEN** system SHALL draw each peak as a vertical rectangle using `fillRect()` with configurable width (default: 1.5px)

#### Scenario: Apply unified color scheme
- **WHEN** rendering waveform to Canvas
- **THEN** system SHALL use configurable fill color (default: `rgba(255,255,255,0.2)`) and stroke color (default: `rgba(255,255,255,0.7)`)

#### Scenario: Maintain performance for high-frequency redraws
- **WHEN** Canvas waveform is redrawn during drag or zoom operations
- **THEN** rendering SHALL complete within 16ms for datasets up to 10000 points

### Requirement: SVG waveform rendering

The system SHALL provide a function to generate SVG path data (`d` attribute) for waveform peak visualization as closed-area paths.

#### Scenario: Generate closed path from min/max bands
- **WHEN** generating SVG path for waveform peaks
- **THEN** system SHALL create a path that traces max values forward, then min values backward, and closes the path

#### Scenario: Support stereo dual-band layout
- **WHEN** generating SVG waveform for stereo audio
- **THEN** system SHALL generate separate paths for left and right channels with vertical separation

#### Scenario: Integrate with SVG viewBox scaling
- **WHEN** SVG waveform is rendered in a resizable container
- **THEN** path coordinates SHALL use viewBox-relative units to support automatic scaling

### Requirement: Unified visual style

The system SHALL apply consistent visual styling (colors, transparency, stroke width) across both Piano Roll and Clip waveforms.

#### Scenario: White semi-transparent fill
- **WHEN** rendering any waveform
- **THEN** system SHALL use white semi-transparent fill (default: `rgba(255,255,255,0.2)`)

#### Scenario: White stroke for boundary clarity
- **WHEN** rendering any waveform
- **THEN** system SHALL apply a white semi-transparent stroke (default: `rgba(255,255,255,0.7)`) with 1px width

#### Scenario: Silent region visibility
- **WHEN** rendering waveform peaks with near-zero amplitude
- **THEN** system SHALL ensure minimum visual height (0.75px) to maintain waveform visibility

### Requirement: Theme system integration

The system SHALL support reading waveform colors from the application theme configuration.

#### Scenario: Read fill color from theme
- **WHEN** theme defines `waveform.fill` color
- **THEN** system SHALL use theme-defined color instead of default

#### Scenario: Read stroke color from theme
- **WHEN** theme defines `waveform.stroke` color
- **THEN** system SHALL use theme-defined color instead of default

#### Scenario: Fallback to defaults
- **WHEN** theme does not define waveform colors
- **THEN** system SHALL use default colors (`rgba(255,255,255,0.2)` fill, `rgba(255,255,255,0.7)` stroke)

### Requirement: Piano Roll integration

The system SHALL replace the existing Piano Roll background waveform rendering with the shared rendering function.

#### Scenario: Render background waveform in Piano Roll
- **WHEN** Piano Roll displays audio waveform in the background
- **THEN** system SHALL use `renderWaveformCanvas()` with unified color scheme

#### Scenario: Maintain vertical centering
- **WHEN** rendering waveform in Piano Roll
- **THEN** waveform SHALL be centered vertically at 50% of canvas height with 90% amplitude range (45% above and below center)

#### Scenario: Preserve performance during interaction
- **WHEN** user drags or zooms Piano Roll view
- **THEN** waveform rendering SHALL not cause visible lag or frame drops

### Requirement: Clip waveform integration

The system SHALL replace the existing Clip SVG path generation with the shared rendering function while preserving stereo layout and fade effects.

#### Scenario: Generate SVG waveform for Clip
- **WHEN** Clip displays waveform preview
- **THEN** system SHALL use `renderWaveformSvg()` to generate path data

#### Scenario: Preserve stereo dual-band layout
- **WHEN** Clip contains stereo audio
- **THEN** waveform SHALL display as two separate bands (top for left channel, bottom for right channel) with a gap between them

#### Scenario: Apply fade-in and fade-out effects
- **WHEN** Clip has non-zero fade-in or fade-out settings
- **THEN** waveform amplitude SHALL be modulated by fade gain curve (sine/linear/exponential) within fade regions

#### Scenario: Reflect gain adjustment
- **WHEN** Clip gain is adjusted
- **THEN** waveform amplitude SHALL scale proportionally to reflect the gain change

### Requirement: Backward compatibility

The system SHALL maintain existing waveform data formats and API contracts.

#### Scenario: Accept existing peak data format
- **WHEN** receiving waveform peak data from backend or cache
- **THEN** system SHALL accept `{ min: number[], max: number[], startSec: number, durSec: number }` format without modification

#### Scenario: No breaking changes to parent components
- **WHEN** integrating shared rendering functions
- **THEN** Piano Roll and Clip components SHALL not require changes to their props or data fetching logic
