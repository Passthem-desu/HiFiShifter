## ADDED Requirements

### Requirement: Backend SHALL provide async pitch refresh command
The system SHALL expose a non-blocking command to start pitch data recalculation in the background.

#### Scenario: Start refresh task returns immediately
- **WHEN** frontend calls start_pitch_refresh_task()
- **THEN** backend SHALL return a unique task_id within 100ms without waiting for completion

#### Scenario: Task ID is globally unique
- **WHEN** multiple refresh tasks are started concurrently
- **THEN** each SHALL receive a distinct task_id (UUID format)

### Requirement: Backend SHALL maintain task status registry
The system SHALL track active pitch refresh tasks with their current status.

#### Scenario: Query running task status
- **WHEN** frontend calls get_pitch_refresh_status(task_id) for active task
- **THEN** backend SHALL return {status: "running", progress: 0-100, error: null}

#### Scenario: Query completed task status
- **WHEN** frontend queries status after task completion
- **THEN** backend SHALL return {status: "completed", progress: 100, result_key: <cache_key>}

#### Scenario: Query failed task status
- **WHEN** frontend queries status after task failure
- **THEN** backend SHALL return {status: "failed", progress: <last_value>, error: <error_message>}

#### Scenario: Query cancelled task status
- **WHEN** frontend queries status after cancellation
- **THEN** backend SHALL return {status: "cancelled", progress: <last_value>, error: null}

### Requirement: Backend SHALL support task cancellation
Users MUST be able to abort long-running pitch refresh operations.

#### Scenario: Cancel running task
- **WHEN** frontend calls cancel_pitch_task(task_id) while task is running
- **THEN** backend SHALL stop computation at next checkpoint and mark task as cancelled

#### Scenario: Cancel non-existent task
- **WHEN** frontend cancels a task_id that doesn't exist
- **THEN** backend SHALL return error "Task not found"

#### Scenario: Task cleanup after cancellation
- **WHEN** task is cancelled
- **THEN** partial results SHALL be discarded and cache SHALL remain unchanged

### Requirement: Task status SHALL auto-expire
Completed/failed task records SHALL not accumulate indefinitely.

#### Scenario: Task record expires after 5 minutes
- **WHEN** task completes or fails
- **THEN** its status SHALL be queryable for 5 minutes, then auto-deleted

#### Scenario: Query expired task
- **WHEN** frontend queries a task older than 5 minutes
- **THEN** backend SHALL return error "Task expired or not found"

### Requirement: Backend SHALL limit concurrent refresh tasks
System SHALL prevent resource exhaustion from excessive simultaneous tasks.

#### Scenario: Concurrent task limit
- **WHEN** 3 pitch refresh tasks are already running
- **THEN** new task requests SHALL be queued or rejected with "Too many active tasks"

#### Scenario: Task queue processing
- **WHEN** an active task completes and queued tasks exist
- **THEN** next queued task SHALL start automatically
