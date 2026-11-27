#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use std::sync::Mutex;
use std::sync::atomic::{AtomicBool, Ordering};

use tauri::{Manager, WindowEvent};
use tokio_util::sync::CancellationToken;

struct GatewayLifecycle {
    shutdown: CancellationToken,
    task: Mutex<Option<std::thread::JoinHandle<()>>>,
    closing: AtomicBool,
}

fn main() {
    jian::desktop::init_observability();
    tauri::Builder::default()
        .setup(|app| {
            let shutdown = CancellationToken::new();
            let task_shutdown = shutdown.clone();
            let task = std::thread::Builder::new()
                .name("jian-local-gateway".into())
                .spawn(move || {
                    let runtime = match tokio::runtime::Builder::new_multi_thread()
                        .enable_all()
                        .max_blocking_threads(jian::desktop::MAX_BLOCKING_THREADS)
                        .build()
                    {
                        Ok(runtime) => runtime,
                        Err(error) => {
                            tracing::error!(%error, "cannot start the local gateway runtime");
                            return;
                        }
                    };
                    if let Err(error) =
                        runtime.block_on(jian::desktop::run_desktop_gateway(task_shutdown))
                    {
                        tracing::error!(%error, "the local Jian gateway stopped");
                    }
                })?;
            app.manage(GatewayLifecycle {
                shutdown,
                task: Mutex::new(Some(task)),
                closing: AtomicBool::new(false),
            });
            Ok(())
        })
        .on_window_event(|window, event| {
            if let WindowEvent::CloseRequested { api, .. } = event {
                api.prevent_close();
                let Some(state) = window.app_handle().try_state::<GatewayLifecycle>() else {
                    return;
                };
                if state.closing.swap(true, Ordering::SeqCst) {
                    return;
                }
                state.shutdown.cancel();
                let task = state.task.lock().ok().and_then(|mut task| task.take());
                let app = window.app_handle().clone();
                std::thread::spawn(move || {
                    if let Some(task) = task {
                        let _ = task.join();
                    }
                    app.exit(0);
                });
            }
        })
        .run(tauri::generate_context!())
        .expect("failed to run Jian Desktop");
}
