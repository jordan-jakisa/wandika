mod attachments;
mod commands;
mod config;
mod connectors;
mod crypto;
mod error;
mod github;
#[cfg(desktop)]
mod mcp;
mod outside;
mod secrets;
mod state;
mod sync;
#[cfg(test)]
mod test_http;
mod vault;
mod voice;

use tauri::Manager;
use tauri_plugin_deep_link::DeepLinkExt;

/// `wandika mcp`: serves Claude Code over stdin and stdout until it disconnects. Mac only.
#[cfg(desktop)]
pub fn mcp_main() -> i32 {
    mcp::run()
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_deep_link::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_capture::init())
        .setup(|app| {
            // Haptic feedback on phones: a tick at a swipe's or pull's point, a tap on a done task.
            #[cfg(mobile)]
            app.handle().plugin(tauri_plugin_haptics::init())?;
            let data = app.path().app_data_dir()?;
            std::fs::create_dir_all(&data)?;
            app.manage(state::App::new(data));
            let handle = app.handle().clone();
            app.deep_link().on_open_url(move |event| {
                for url in event.urls() {
                    commands::handle_redirect(&handle, &url);
                }
            });
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            commands::status,
            voice::note_print,
            voice::voice_start,
            voice::voice_stop,
            voice::captures_import,
            commands::github_start_login,
            commands::github_poll_login,
            commands::github_sign_out,
            commands::repos_list,
            commands::repo_create,
            commands::vault_open,
            commands::vault_close,
            commands::vault_create_local,
            commands::vault_switch,
            commands::vault_forget,
            commands::vault_connect_remote,
            commands::vault_disconnect_remote,
            commands::sync_now,
            commands::sync_cancel,
            commands::sync_held_deletions,
            commands::tree,
            commands::note_read,
            commands::note_write,
            commands::note_create,
            commands::folder_create,
            commands::note_discard_if_empty,
            commands::attachment_save,
            commands::drawing_write,
            #[cfg(desktop)]
            commands::claude_setup_command,
            commands::attachment_read,
            commands::new_note_folder,
            commands::new_note_location,
            commands::new_note_location_set,
            commands::templates_list,
            commands::template_render,
            commands::entry_rename,
            commands::entry_trash,
            commands::entry_restore,
            commands::note_titles,
            commands::search,
            commands::backlinks,
            commands::resolve_link,
            commands::tasks_vault,
            commands::task_toggle,
            commands::task_edit,
            commands::task_delete,
            commands::task_restore,
            commands::task_archive,
            commands::task_unarchive,
            commands::task_add,
            commands::mail_read,
            commands::external_changes,
            commands::daily_note,
            commands::snippets_list,
            commands::snippet_toggle,
            commands::encryption_setup,
            commands::encryption_unlock,
            commands::encryption_lock,
            commands::set_encrypted,
            commands::connector_connect,
            commands::connector_poll,
            commands::connector_disconnect,
            commands::today,
            commands::remote_task_toggle,
            commands::mail_to_note,
            commands::event_to_note,
            commands::agenda_to_daily,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
