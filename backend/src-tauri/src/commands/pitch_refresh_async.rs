use crate::state::{AppState, PitchTaskInfo, PitchTaskStatus};
use serde::Serialize;
use std::sync::atomic::Ordering;
use std::sync::Arc;
use tauri::{Manager, State};
use uuid::Uuid;

/// 后端返回的任务状态 payload
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PitchTaskStatusPayload {
    pub status: String,
    pub progress: u8,
    pub error: Option<String>,
    pub result_key: Option<String>,
}

impl From<PitchTaskInfo> for PitchTaskStatusPayload {
    fn from(info: PitchTaskInfo) -> Self {
        Self {
            status: match info.status {
                PitchTaskStatus::Running => "running".to_string(),
                PitchTaskStatus::Completed => "completed".to_string(),
                PitchTaskStatus::Failed => "failed".to_string(),
                PitchTaskStatus::Cancelled => "cancelled".to_string(),
            },
            progress: info.progress,
            error: info.error,
            result_key: info.result_key,
        }
    }
}

/// 任务 1.4: 启动异步音高刷新任务
pub(super) async fn start_pitch_refresh_task(
    root_track_id: String,
    state: State<'_, AppState>,
) -> Result<String, String> {
    // 任务 1.8: 限制并发任务数（最多 3 个）
    let running_count = {
        let tasks = state.pitch_refresh_tasks.lock().unwrap();
        tasks
            .values()
            .filter(|info| info.status == PitchTaskStatus::Running)
            .count()
    };

    if running_count >= 3 {
        return Err("Too many active tasks".to_string());
    }

    let task_id = Uuid::new_v4().to_string();
    let task_info = PitchTaskInfo::new();
    let cancel_flag = task_info.cancel_flag.clone();

    // 注册任务
    {
        let mut tasks = state.pitch_refresh_tasks.lock().unwrap();
        tasks.insert(task_id.clone(), task_info);
    }

    // 任务 1.5: 在异步任务中调用 compute_pitch_curve()
    let tasks_ref = state.pitch_refresh_tasks.clone();
    let task_id_clone = task_id.clone();
    let app_handle = match state.app_handle.get().cloned() {
        Some(handle) => handle,
        None => return Err("App handle not initialized".to_string()),
    };
    
    // 克隆 AppState 的 Arc<Mutex<_>> 字段以便在异步上下文中使用
    let timeline_ref = Arc::new(state.timeline.lock().unwrap().clone());
    
    tokio::spawn(async move {
        // 构建音高分析作业快照
        let job_opt = crate::pitch_analysis::build_pitch_job(&timeline_ref, &root_track_id);
        
        let result = match job_opt {
            Some(job) => {
                let key = job.key.clone();
                // 使用 tokio::task::spawn_blocking 包装 CPU 密集型 WORLD 分析
                let tasks_ref_inner = tasks_ref.clone();
                let task_id_inner = task_id_clone.clone();
                let cancel_flag_inner = cancel_flag.clone();
                let app_handle_inner = app_handle.clone();
                
                match tokio::task::spawn_blocking(move || {
                    let state = app_handle_inner.state::<AppState>();
                    // 进度回调：更新任务注册表的 progress 字段
                    let progress_callback = |p: f32| {
                        let progress_u8 = (p.clamp(0.0, 1.0) * 100.0).round() as u8;
                        if let Ok(mut tasks) = tasks_ref_inner.lock() {
                            if let Some(info) = tasks.get_mut(&task_id_inner) {
                                info.progress = progress_u8;
                            }
                        }
                    };
                    
                    crate::pitch_analysis::compute_pitch_curve(
                        &job,
                        &state.clip_pitch_cache,
                        progress_callback,
                        Some(cancel_flag_inner),
                    )
                }).await {
                    Ok(Ok(_curve)) => Ok(key),
                    Ok(Err(e)) => Err(e),
                    Err(e) => Err(format!("Task join error: {}", e)),
                }
            }
            None => {
                // 没有需要分析的内容（compose_enabled=false 或无 clips）
                Ok("no_analysis_needed".to_string())
            }
        };

        // 更新任务状态
        let mut tasks = tasks_ref.lock().unwrap();
        if let Some(info) = tasks.get_mut(&task_id_clone) {
            match result {
                Ok(cache_key) => {
                    info.status = PitchTaskStatus::Completed;
                    info.progress = 100;
                    info.result_key = Some(cache_key);
                }
                Err(e) => {
                    info.status = PitchTaskStatus::Failed;
                    info.error = Some(e);
                }
            }
        }

        // 任务 1.7: 5 分钟后自动清理任务记录
        let tasks_cleanup = tasks_ref.clone();
        let task_id_cleanup = task_id_clone.clone();
        tokio::spawn(async move {
            tokio::time::sleep(tokio::time::Duration::from_secs(300)).await;
            let mut tasks = tasks_cleanup.lock().unwrap();
            tasks.remove(&task_id_cleanup);
        });
    });

    Ok(task_id)
}

/// 任务 1.6: 查询任务状态
pub(super) fn get_pitch_refresh_status(
    task_id: String,
    state: State<'_, AppState>,
) -> Result<PitchTaskStatusPayload, String> {
    let tasks = state.pitch_refresh_tasks.lock().unwrap();
    
    match tasks.get(&task_id) {
        Some(info) => Ok(PitchTaskStatusPayload::from(info.clone())),
        None => Err("Task expired or not found".to_string()),
    }
}

/// 任务 2.2: 实现取消命令
pub(super) fn cancel_pitch_task(
    task_id: String,
    state: State<'_, AppState>,
) -> Result<(), String> {
    let mut tasks = state.pitch_refresh_tasks.lock().unwrap();
    
    match tasks.get_mut(&task_id) {
        Some(info) => {
            if info.status == PitchTaskStatus::Running {
                // 设置取消标志
                info.cancel_flag.store(true, Ordering::Relaxed);
                info.status = PitchTaskStatus::Cancelled;
                Ok(())
            } else {
                Err(format!("Task is not running (status: {:?})", info.status))
            }
        }
        None => Err("Task not found".to_string()),
    }
}


