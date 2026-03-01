## ADDED Requirements

### Requirement: System SHALL perform ONNX availability diagnostic check
The backend SHALL expose a diagnostic function that checks all prerequisites for ONNX HiFiGAN operation.

#### Scenario: Check model file existence
- **WHEN** diagnostic runs
- **THEN** system SHALL verify NSF-HiFiGAN .onnx model file exists at expected path

#### Scenario: Check ONNX Runtime library load
- **WHEN** diagnostic runs
- **THEN** system SHALL verify onnxruntime.dll (or .so) can be loaded successfully

#### Scenario: Check execution provider availability
- **WHEN** diagnostic runs
- **THEN** system SHALL test each EP (CUDA, DirectML, CPU) and report which are operational

#### Scenario: Check model session creation
- **WHEN** diagnostic runs
- **THEN** system SHALL attempt creating InferenceSession and report success/failure reason

### Requirement: Backend SHALL expose ONNX diagnostic command
A Tauri IPC command SHALL return structured diagnostic information.

#### Scenario: Query diagnostic info
- **WHEN** frontend calls get_onnx_diagnostic_info()
- **THEN** system SHALL return OnnxDiagnosticPayload with {is_available, error_details, ep_status, model_path}

#### Scenario: Diagnostic includes error details
- **WHEN** ONNX unavailable
- **THEN** error_details field SHALL contain specific failure reason (e.g., "Model file not found: /path/to/model.onnx")

#### Scenario: Diagnostic reports active EP
- **WHEN** ONNX available
- **THEN** ep_status SHALL indicate which execution provider is in use (e.g., "CUDA" or "CPU")

### Requirement: Frontend SHALL display ONNX unavailability warnings
When ONNX is selected but unavailable, UI SHALL show clear diagnostic information.

#### Scenario: Show warning badge in algorithm selector
- **WHEN** user selects NSF-HiFiGAN (ONNX) algorithm but ONNX unavailable
- **THEN** UI SHALL display warning badge with "⚠ ONNX Unavailable" text

#### Scenario: Tooltip shows diagnostic details
- **WHEN** user hovers over ONNX unavailable warning
- **THEN** tooltip SHALL display error_details from diagnostic (e.g., "Model file missing: recompile with --features onnx")

#### Scenario: Suggest fallback or fix actions
- **WHEN** displaying ONNX error
- **THEN** UI SHALL suggest actionable fix (e.g., "Run with --features onnx enabled" or "Check model file path in logs")

### Requirement: Diagnostic SHALL run on application startup
ONNX diagnostic check SHALL execute once during app initialization.

#### Scenario: Diagnostic runs before first render
- **WHEN** application launches
- **THEN** ONNX diagnostic SHALL complete before pitch editor UI renders

#### Scenario: Diagnostic result cached in memory
- **WHEN** diagnostic completes at startup
- **THEN** result SHALL be cached in AppState for subsequent queries

### Requirement: System SHALL log detailed ONNX errors
When ONNX operations fail, detailed error information SHALL be recorded in application logs.

#### Scenario: Log model load failure
- **WHEN** ONNX model fails to load
- **THEN** system SHALL log full path attempted, file existence status, and ORT error code

#### Scenario: Log EP selection process
- **WHEN** execution provider is selected
- **THEN** system SHALL log tried EPs and fallback chain (e.g., "CUDA unavailable, trying DirectML... success")

#### Scenario: Log session creation errors
- **WHEN** InferenceSession creation fails
- **THEN** system SHALL log model input/output shape expectations and actual metadata
