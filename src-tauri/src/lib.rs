pub mod ai;
pub mod commands;

use commands::ai as ai_commands;
use commands::image;
use commands::project_state;
use tracing::info;
use tracing_subscriber::{layer::SubscriberExt, util::SubscriberInitExt};

fn setup_logging() {
    let file_appender = tracing_appender::rolling::daily("logs", "storyboard.log");
    let (non_blocking, _guard) = tracing_appender::non_blocking(file_appender);

    tracing_subscriber::registry()
        .with(
            tracing_subscriber::EnvFilter::try_from_default_env()
                .unwrap_or_else(|_| "info,storyboard_copilot=debug".into()),
        )
        .with(tracing_subscriber::fmt::layer().with_writer(non_blocking))
        .init();

    info!("Storyboard Copilot starting...");
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    setup_logging();

    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .invoke_handler(tauri::generate_handler![
            image::split_image,
            image::split_image_source,
            image::prepare_node_image_source,
            image::crop_image_source,
            image::merge_storyboard_images,
            image::load_image,
            image::persist_image_source,
            image::persist_image_binary,
            image::save_image_source_to_downloads,
            image::save_image_source_to_path,
            image::save_image_source_to_directory,
            image::copy_image_source_to_clipboard,
            ai_commands::set_api_key,
            ai_commands::generate_image,
            ai_commands::list_models,
            project_state::list_project_summaries,
            project_state::get_project_record,
            project_state::upsert_project_record,
            project_state::update_project_viewport_record,
            project_state::rename_project_record,
            project_state::delete_project_record,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
