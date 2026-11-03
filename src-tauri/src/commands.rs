//! Everything the interface can ask the Rust core to do.

use crate::connectors::{apple, google, microsoft, oauth, CalEvent, MailBody, MailItem, RemoteTask};
use crate::crypto::{Crypto, CryptoStatus};
use crate::error::{msg, Result};
use crate::github::{self, DeviceCode, Repo, User};
use crate::state::{App, VaultConfig, GITHUB_KEY};
use crate::sync::{self, SyncReport, Target};
use crate::vault::{self, Entry, NoteMeta, SearchHit, VaultTask};
use chrono::{Duration, Local, NaiveDate, TimeZone};
use serde::Serialize;
use serde_json::{json, Value};
use std::collections::BTreeMap;
use tauri::{AppHandle, Emitter, Manager, State};

type S<'a> = State<'a, App>;

#[derive(Serialize)]
pub struct Status {
    configured: Value,
    user: Option<User>,
    vault: Option<VaultConfig>,
    /// Vaults opened before on this device, for switching.
    known: Vec<VaultConfig>,
    last_sync: Option<i64>,
    encryption: Option<CryptoStatus>,
    connectors: Value,
}

fn account(app: &App, key: &str) -> Option<String> {
    app.secrets
        .get_json::<oauth::TokenSet>(key)
        .map(|t| t.account.unwrap_or_else(|| "Connected".into()))
}

#[tauri::command]
pub async fn status(app: S<'_>) -> Result<Status> {
    let settings = app.settings();
    let signed_in = app.secrets.get(GITHUB_KEY).is_some();
    let (last_sync, encryption) = match &settings.vault {
        Some(_) => (sync::load_state(&app.paths()?).last_sync, Some(app.crypto()?.status())),
        None => (None, None),
    };
    Ok(Status {
        configured: crate::config::configured(),
        user: settings.user.filter(|_| signed_in),
        vault: settings.vault,
        known: settings.known,
        last_sync,
        encryption,
        connectors: json!({
            "google": account(&app, google::KEY),
            "microsoft": account(&app, microsoft::KEY),
            "apple_calendar": apple::access(apple::Kind::Calendar),
            "apple_reminders": apple::access(apple::Kind::Reminders),
        }),
    })
}

// GitHub sign-in

#[tauri::command]
pub async fn github_start_login(app: S<'_>) -> Result<DeviceCode> {
    github::start_device_flow(&app.http).await
}

/// `None` while GitHub is still waiting for Jordan to enter the code.
#[tauri::command]
pub async fn github_poll_login(app: S<'_>, device_code: String) -> Result<Option<Value>> {
    match github::poll_device_flow(&app.http, &device_code).await? {
        github::Poll::Pending => Ok(None),
        github::Poll::SlowDown => Ok(Some(json!({ "slow_down": true }))),
        github::Poll::Done(token) => {
            let user = github::GitHub::new(app.http.clone(), token.clone()).user().await?;
            app.secrets.set(GITHUB_KEY, &token)?;
            app.update_settings(|s| s.user = Some(user.clone()))?;
            Ok(Some(json!({ "user": user })))
        }
    }
}

/// Local vaults stay open; a vault that syncs with GitHub closes, since it can't sync any more.
#[tauri::command]
pub async fn github_sign_out(app: S<'_>) -> Result<()> {
    app.secrets.delete(GITHUB_KEY);
    app.update_settings(|s| {
        s.user = None;
        if s.vault.as_ref().is_some_and(|v| v.remote.is_some()) {
            s.vault = None;
        }
    })
}

#[tauri::command]
pub async fn repos_list(app: S<'_>) -> Result<Vec<Repo>> {
    app.github()?.repos().await
}

#[tauri::command]
pub async fn repo_create(app: S<'_>, name: String) -> Result<Repo> {
    let name = name.trim();
    if name.is_empty() || !name.chars().all(|c| c.is_ascii_alphanumeric() || "-_.".contains(c)) {
        return Err(msg("Use letters, numbers, dashes, dots or underscores for the repository name."));
    }
    app.github()?.create_repo(name).await
}

async fn remote_for(app: &App, owner: String, repo: String) -> Result<Target> {
    let info = app.github()?.repo(&owner, &repo).await?;
    Ok(Target { owner, repo, branch: info.default_branch.unwrap_or_else(|| "main".into()) })
}

// Vaults

/// Opens a GitHub repository as a vault, downloading it on first use.
#[tauri::command]
pub async fn vault_open(app: S<'_>, handle: AppHandle, owner: String, repo: String) -> Result<SyncReport> {
    let target = remote_for(&app, owner, repo).await?;
    let id = format!("github/{}/{}", target.owner, target.repo);
    let existing = app.settings().known.into_iter().find(|k| k.id == id);
    let vault = existing.unwrap_or(VaultConfig { id, name: target.repo.clone(), folder: None, remote: None });
    app.update_settings(|s| s.vault = Some(VaultConfig { remote: Some(target), ..vault }))?;
    sync_now(app, handle).await
}

/// A vault that lives only on this device: in the app's storage, or in a folder chosen on the Mac.
#[tauri::command]
pub async fn vault_create_local(app: S<'_>, name: String, folder: Option<String>) -> Result<()> {
    let folder = folder.map(std::path::PathBuf::from);
    if let Some(f) = &folder
        && !f.is_dir()
    {
        return Err(msg("That folder doesn't exist any more. Choose it again."));
    }
    let name = match (&folder, name.trim()) {
        (_, n) if !n.is_empty() => n.to_string(),
        (Some(f), _) => f.file_name().and_then(|n| n.to_str()).unwrap_or("Notes").to_string(),
        (None, _) => return Err(msg("Give the vault a name.")),
    };
    let slug: String = name
        .to_lowercase()
        .chars()
        .map(|c| if c.is_ascii_alphanumeric() { c } else { '-' })
        .collect();
    let id = format!("local/{}-{}", slug.trim_matches('-'), oauth::random_state()[..6].to_lowercase());
    let vault = VaultConfig { id, name, folder, remote: None };
    app.update_settings(|s| s.vault = Some(vault))?;
    app.root()?;
    Ok(())
}

#[tauri::command]
pub async fn vault_switch(app: S<'_>, id: String) -> Result<()> {
    let vault = app.settings().known.into_iter().find(|k| k.id == id).ok_or_else(|| msg("That vault is gone."))?;
    if vault.folder.as_ref().is_some_and(|f| !f.is_dir()) {
        return Err(msg("That vault's folder was moved or deleted."));
    }
    app.update_settings(|s| s.vault = Some(vault))
}

/// Removes a vault from the list on this device. Its files are left where they are.
#[tauri::command]
pub async fn vault_forget(app: S<'_>, id: String) -> Result<()> {
    app.update_settings(|s| {
        s.known.retain(|k| k.id != id);
        if s.vault.as_ref().is_some_and(|v| v.id == id) {
            s.vault = None;
        }
    })
}

/// Back to the vault list. Files stay on the device so reopening the vault is instant.
#[tauri::command]
pub async fn vault_close(app: S<'_>) -> Result<()> {
    app.update_settings(|s| s.vault = None)
}

/// Connects the open local vault to a GitHub repository. The first sync keeps both sides.
#[tauri::command]
pub async fn vault_connect_remote(app: S<'_>, handle: AppHandle, owner: String, repo: String) -> Result<SyncReport> {
    let mut vault = app.vault()?;
    if vault.remote.is_some() {
        return Err(msg("This vault already syncs with GitHub. Disconnect it first."));
    }
    let local = vault.clone();
    vault.remote = Some(remote_for(&app, owner, repo).await?);
    let _ = std::fs::remove_file(app.paths()?.state);
    app.update_settings(|s| s.vault = Some(vault))?;
    let result = sync_now(app.clone(), handle).await;
    // Stopped or failed before the first sync finished: the vault stays local, as it was.
    if result.is_err() {
        let _ = std::fs::remove_file(app.paths()?.state);
        app.update_settings(|s| s.vault = Some(local))?;
    }
    result
}

/// Stops syncing. The files stay; the vault carries on as a local one.
#[tauri::command]
pub async fn vault_disconnect_remote(app: S<'_>) -> Result<()> {
    let mut vault = app.vault()?;
    vault.remote = None;
    let _ = std::fs::remove_file(app.paths()?.state);
    app.update_settings(|s| s.vault = Some(vault))
}

#[tauri::command]
pub async fn sync_now(app: S<'_>, handle: AppHandle) -> Result<SyncReport> {
    let target = app.target()?;
    let gh = app.github()?;
    let paths = app.paths()?;
    let Ok(_guard) = app.sync_lock.try_lock() else {
        return Err(crate::error::Error::SyncBusy);
    };
    app.sync_cancel.store(false, std::sync::atomic::Ordering::Relaxed);
    // Progress goes to the interface at most ten times a second, plus every phase change.
    let last = std::sync::Mutex::new((String::new(), std::time::Instant::now()));
    let ctl = sync::Ctl {
        cancel: app.sync_cancel.clone(),
        progress: Box::new(move |phase, done, total| {
            let mut l = last.lock().unwrap();
            if l.0 == phase && l.1.elapsed() < std::time::Duration::from_millis(100) && done < total {
                return;
            }
            *l = (phase.to_string(), std::time::Instant::now());
            let _ = handle.emit("sync-progress", json!({ "phase": phase, "done": done, "total": total }));
        }),
    };
    let user = app.settings().user;
    let login = user.as_ref().map(|u| u.login.clone()).unwrap_or_else(|| target.owner.clone());
    let remote = sync::Remote {
        url: format!("https://github.com/{}/{}.git", target.owner, target.repo),
        token: gh.token().to_string(),
        branch: target.branch.clone(),
        author: user.and_then(|u| u.name).unwrap_or_else(|| login.clone()),
        email: format!("{login}@users.noreply.github.com"),
        device: std::env::consts::OS.to_string(),
    };
    // libgit2 blocks; it runs on a worker thread so the interface stays responsive.
    let report = tauri::async_runtime::spawn_blocking(move || sync::sync(&paths, &remote, &ctl))
        .await
        .map_err(|_| msg("Sync couldn't finish. Try again."))?;
    changed(&app);
    report
}

/// The held deletions: delete them on GitHub too (the next sync does), or bring them back here.
#[tauri::command]
pub async fn sync_held_deletions(app: S<'_>, delete: bool, paths: Vec<String>) -> Result<()> {
    let p = app.paths()?;
    if delete { sync::confirm_deletions(&p) } else { sync::restore_held(&p, &paths) }?;
    changed(&app);
    Ok(())
}

/// Stops the running sync at its next file. Nothing on GitHub changes until a sync commits.
#[tauri::command]
pub async fn sync_cancel(app: S<'_>) -> Result<()> {
    app.sync_cancel.store(true, std::sync::atomic::Ordering::Relaxed);
    Ok(())
}

// Notes

#[tauri::command]
pub async fn tree(app: S<'_>) -> Result<Vec<Entry>> {
    vault::tree(&app.root()?)
}

#[tauri::command]
pub async fn note_read(app: S<'_>, path: String) -> Result<String> {
    vault::read_note(&app.root()?, &path, &app.crypto()?)
}

#[tauri::command]
pub async fn note_write(app: S<'_>, path: String, content: String) -> Result<()> {
    vault::write_note(&app.root()?, &path, &content, &app.crypto()?)?;
    changed(&app);
    Ok(())
}

#[tauri::command]
pub async fn note_create(app: S<'_>, folder: String, title: String, body: Option<String>) -> Result<String> {
    let body = body.unwrap_or_default();
    let path = vault::create_note(&app.root()?, &folder, &title, &body, &app.crypto()?)?;
    changed(&app);
    Ok(path)
}

#[tauri::command]
pub async fn new_note_folder(app: S<'_>, current: Option<String>) -> Result<String> {
    Ok(vault::new_note_folder(&app.root()?, current.as_deref()))
}

#[tauri::command]
pub async fn new_note_location(app: S<'_>) -> Result<vault::NewNoteLocation> {
    Ok(vault::new_note_location(&app.root()?))
}

/// Sets where new notes go, in the vault's Obsidian settings (they sync with the vault).
#[tauri::command]
pub async fn new_note_location_set(app: S<'_>, location: String, folder: String) -> Result<()> {
    vault::set_new_note_location(&app.root()?, &location, &folder)?;
    changed(&app);
    Ok(())
}

#[tauri::command]
pub async fn templates_list(app: S<'_>) -> Result<Vec<String>> {
    Ok(vault::templates(&app.root()?))
}

/// A template's text with its `{{date}}`, `{{time}}` and `{{title}}` filled in for `title`.
#[tauri::command]
pub async fn template_render(app: S<'_>, path: String, title: String) -> Result<String> {
    let text = vault::read_note(&app.root()?, &path, &app.crypto()?)?;
    Ok(vault::fill_template(&text, &title, Local::now().naive_local()))
}

/// Raw file bytes in the body; `x-meta` carries `note` and `name`, form-encoded.
#[tauri::command]
pub async fn attachment_save(app: S<'_>, request: tauri::ipc::Request<'_>) -> Result<String> {
    let tauri::ipc::InvokeBody::Raw(bytes) = request.body() else {
        return Err(msg("No file data arrived."));
    };
    let meta = request.headers().get("x-meta").and_then(|v| v.to_str().ok()).unwrap_or_default();
    let field = |k: &str| url::form_urlencoded::parse(meta.as_bytes()).find(|(key, _)| key == k).map(|(_, v)| v.into_owned());
    let note = field("note").unwrap_or_default();
    let name = field("name").ok_or_else(|| msg("The file has no name."))?;
    let rel = crate::attachments::save(&app.root()?, &note, &name, bytes, &app.crypto()?)?;
    changed(&app);
    Ok(rel)
}

/// Saves a changed drawing over the file an embed in `from` points at.
#[tauri::command]
pub async fn drawing_write(app: S<'_>, target: String, from: String, svg: String) -> Result<()> {
    let root = app.root()?;
    let rel = crate::attachments::resolve(&root, &target, &from).ok_or_else(|| msg("That drawing isn't in the vault any more."))?;
    crate::attachments::write_drawing(&root, &rel, &svg, &app.crypto()?)?;
    changed(&app);
    Ok(())
}

/// The bytes of the file an embed in `from` points at.
#[tauri::command]
pub async fn attachment_read(app: S<'_>, target: String, from: String) -> Result<tauri::ipc::Response> {
    let root = app.root()?;
    let rel = crate::attachments::resolve(&root, &target, &from).ok_or_else(|| msg(format!("{target} isn't in this vault.")))?;
    Ok(tauri::ipc::Response::new(crate::attachments::read(&root, &rel, &app.crypto()?)?))
}

#[tauri::command]
pub async fn note_discard_if_empty(app: S<'_>, path: String) -> Result<bool> {
    let removed = vault::discard_if_empty(&app.root()?, &path, &app.crypto()?)?;
    if removed {
        changed(&app);
    }
    Ok(removed)
}

#[tauri::command]
pub async fn folder_create(app: S<'_>, path: String) -> Result<()> {
    vault::create_folder(&app.root()?, &path)
}

#[tauri::command]
pub async fn entry_rename(app: S<'_>, path: String, name: String) -> Result<String> {
    let (root, crypto) = (app.root()?, app.crypto()?);
    let mut index = app.index.lock().unwrap();
    let to = vault::rename(&root, &path, &name, &crypto, &mut index)?;
    index.mark_stale();
    Ok(to)
}

#[tauri::command]
pub async fn entry_restore(app: S<'_>, path: String) -> Result<()> {
    vault::restore(&app.root()?, &path)?;
    changed(&app);
    Ok(())
}

#[tauri::command]
pub async fn entry_trash(app: S<'_>, path: String) -> Result<()> {
    vault::trash(&app.root()?, &path, &app.crypto()?)?;
    changed(&app);
    Ok(())
}

fn with_index<T>(app: &App, f: impl FnOnce(&vault::Index, &Crypto) -> T) -> Result<T> {
    let (root, crypto) = (app.root()?, app.crypto()?);
    let mut index = app.index.lock().unwrap();
    index.ensure_fresh(&root, &crypto);
    Ok(f(&index, &crypto))
}

/// Every command that changes files on disk calls this, so the next lookup rescans.
fn changed(app: &App) {
    app.index.lock().unwrap().mark_stale();
}

#[tauri::command]
pub async fn note_titles(app: S<'_>) -> Result<Vec<NoteMeta>> {
    with_index(&app, |i, _| i.titles())
}

#[tauri::command]
pub async fn search(app: S<'_>, query: String) -> Result<Vec<SearchHit>> {
    with_index(&app, |i, c| i.search(&query, c))
}

#[tauri::command]
pub async fn backlinks(app: S<'_>, path: String) -> Result<Vec<SearchHit>> {
    with_index(&app, |i, c| i.backlinks(&path, c))
}

#[tauri::command]
pub async fn resolve_link(app: S<'_>, target: String) -> Result<Option<String>> {
    with_index(&app, |i, _| i.resolve(&target))
}

#[tauri::command]
pub async fn tasks_vault(app: S<'_>) -> Result<Vec<VaultTask>> {
    with_index(&app, |i, _| i.tasks())
}

#[tauri::command]
pub async fn task_toggle(app: S<'_>, path: String, line: usize, text: String) -> Result<bool> {
    let done = vault::toggle_task(&app.root()?, &path, line, &text, &app.crypto()?)?;
    changed(&app);
    Ok(done)
}

/// Changes a task's text (name, tags, pin, priority, due date) and the notes under it.
#[tauri::command]
pub async fn task_edit(app: S<'_>, path: String, line: usize, expected: String, text: String, details: String) -> Result<()> {
    vault::edit_task(&app.root()?, &path, line, &expected, &text, &details, &app.crypto()?)?;
    changed(&app);
    Ok(())
}

/// Deletes a task and the notes under it. Returns the removed lines, for Undo.
#[tauri::command]
pub async fn task_delete(app: S<'_>, path: String, line: usize, expected: String) -> Result<Vec<String>> {
    let taken = vault::take_task(&app.root()?, &path, line, &expected, &app.crypto()?)?;
    changed(&app);
    Ok(taken)
}

/// Puts a deleted task back where it was.
#[tauri::command]
pub async fn task_restore(app: S<'_>, path: String, line: usize, lines: Vec<String>) -> Result<()> {
    vault::put_back(&app.root()?, &path, line, &lines, &app.crypto()?)?;
    changed(&app);
    Ok(())
}

/// Moves a task and its notes to the vault's archive note.
#[tauri::command]
pub async fn task_archive(app: S<'_>, path: String, line: usize, expected: String) -> Result<vault::Archived> {
    let done = vault::archive_task(&app.root()?, &path, line, &expected, &app.crypto()?)?;
    changed(&app);
    Ok(done)
}

/// Undoes an archive: the task goes back to its note.
#[tauri::command]
pub async fn task_unarchive(app: S<'_>, archive: String, appended: String, path: String, line: usize, lines: Vec<String>) -> Result<()> {
    vault::unarchive_task(&app.root()?, &archive, &appended, &path, line, &lines, &app.crypto()?)?;
    changed(&app);
    Ok(())
}

/// Adds a task to today's note, in its Tasks section. Returns the note's path.
#[tauri::command]
pub async fn task_add(app: S<'_>, text: String) -> Result<String> {
    let (root, crypto) = (app.root()?, app.crypto()?);
    let path = vault::daily_note(&root, Local::now().date_naive(), &crypto)?;
    vault::add_task(&root, &path, &text, &crypto)?;
    changed(&app);
    Ok(path)
}

fn parse_date(date: Option<String>) -> Result<NaiveDate> {
    match date {
        Some(d) => NaiveDate::parse_from_str(&d, "%Y-%m-%d").map_err(|_| msg("Dates look like 2026-11-02.")),
        None => Ok(Local::now().date_naive()),
    }
}

#[tauri::command]
pub async fn daily_note(app: S<'_>, date: Option<String>) -> Result<String> {
    let path = vault::daily_note(&app.root()?, parse_date(date)?, &app.crypto()?)?;
    changed(&app);
    Ok(path)
}

// Appearance: CSS snippets, stored the Obsidian way so they sync with the vault.

#[derive(Serialize)]
pub struct Snippet {
    name: String,
    css: String,
    enabled: bool,
}

fn appearance_file(root: &std::path::Path) -> std::path::PathBuf {
    root.join(".obsidian/appearance.json")
}

#[tauri::command]
pub async fn snippets_list(app: S<'_>) -> Result<Vec<Snippet>> {
    let root = app.root()?;
    let enabled: Vec<String> = std::fs::read(appearance_file(&root))
        .ok()
        .and_then(|b| serde_json::from_slice::<Value>(&b).ok())
        .and_then(|v| serde_json::from_value(v["enabledCssSnippets"].clone()).ok())
        .unwrap_or_default();
    let mut out = Vec::new();
    if let Ok(dir) = std::fs::read_dir(root.join(".obsidian/snippets")) {
        for entry in dir.flatten() {
            let path = entry.path();
            if path.extension().and_then(|e| e.to_str()) != Some("css") {
                continue;
            }
            let Some(name) = path.file_stem().and_then(|n| n.to_str()).map(str::to_string) else { continue };
            // Snippets over 256 KB are skipped: they're almost certainly not hand-written styles.
            if entry.metadata().is_ok_and(|m| m.len() > 256 * 1024) {
                continue;
            }
            let css = std::fs::read_to_string(&path).unwrap_or_default();
            out.push(Snippet { enabled: enabled.contains(&name), name, css });
        }
    }
    out.sort_by_key(|s| s.name.to_lowercase());
    Ok(out)
}

/// Turns a snippet on or off in `.obsidian/appearance.json`, keeping Obsidian's other settings.
#[tauri::command]
pub async fn snippet_toggle(app: S<'_>, name: String, enabled: bool) -> Result<()> {
    let root = app.root()?;
    let file = appearance_file(&root);
    let mut v: Value = std::fs::read(&file)
        .ok()
        .and_then(|b| serde_json::from_slice(&b).ok())
        .unwrap_or_else(|| json!({}));
    if !v.is_object() {
        v = json!({});
    }
    let mut list: Vec<String> = serde_json::from_value(v["enabledCssSnippets"].clone()).unwrap_or_default();
    list.retain(|n| n != &name);
    if enabled {
        list.push(name);
    }
    v["enabledCssSnippets"] = json!(list);
    vault::write_atomic(&file, &serde_json::to_vec_pretty(&v)?)?;
    app.edited_on_disk();
    Ok(())
}

// Encryption

#[tauri::command]
pub async fn encryption_setup(app: S<'_>, passphrase: String) -> Result<CryptoStatus> {
    Ok(Crypto::set_up(&app.root()?, &app.secrets, &app.vault()?.id, &passphrase)?.status())
}

#[tauri::command]
pub async fn encryption_unlock(app: S<'_>, passphrase: String) -> Result<CryptoStatus> {
    Ok(Crypto::unlock(&app.root()?, &app.secrets, &app.vault()?.id, &passphrase)?.status())
}

#[tauri::command]
pub async fn encryption_lock(app: S<'_>) -> Result<CryptoStatus> {
    Crypto::lock(&app.secrets, &app.vault()?.id);
    Ok(app.crypto()?.status())
}

#[tauri::command]
pub async fn set_encrypted(app: S<'_>, path: String, encrypt: bool) -> Result<String> {
    let mut crypto = app.crypto()?;
    let to = vault::set_encrypted(&app.root()?, &path, encrypt, &mut crypto)?;
    changed(&app);
    Ok(to)
}

// Connectors

async fn finish_google(handle: &AppHandle, code: &str, verifier: &str, redirect: &str) {
    let app = handle.state::<App>();
    let result = async {
        let tokens = google::exchange(&app.http, code, verifier, redirect).await?;
        app.secrets.set_json(google::KEY, &tokens)
    }
    .await;
    let _ = handle.emit(
        "connectors-changed",
        json!({ "provider": "google", "error": result.err().map(|e| e.friendly().1) }),
    );
}

/// Called by the deep-link plugin when Google sends the browser back to the app (iPhone, Android).
pub fn handle_redirect(handle: &AppHandle, url: &url::Url) {
    let app = handle.state::<App>();
    let Some(pending) = app.pending.lock().unwrap().clone() else { return };
    if !pending.redirect_uri.starts_with(&format!("{}:", url.scheme())) {
        return;
    }
    let q: BTreeMap<String, String> = url.query_pairs().into_owned().collect();
    *app.pending.lock().unwrap() = None;
    let handle = handle.clone();
    tauri::async_runtime::spawn(async move {
        match (q.get("code"), q.get("state")) {
            (Some(code), Some(state)) if *state == pending.state => {
                finish_google(&handle, code, &pending.verifier, &pending.redirect_uri).await
            }
            _ => {
                let _ = handle.emit(
                    "connectors-changed",
                    json!({ "provider": pending.provider, "error": "Google sign-in was cancelled." }),
                );
            }
        }
    });
}

#[tauri::command]
pub async fn connector_connect(handle: AppHandle, app: S<'_>, provider: String) -> Result<Value> {
    use tauri_plugin_opener::OpenerExt;
    match provider.as_str() {
        "google" => {
            let pkce = oauth::pkce();
            let state = oauth::random_state();
            #[cfg(desktop)]
            {
                let (listener, redirect) = google::loopback().await?;
                let url = google::auth_url(&redirect, &pkce, &state)?;
                handle.opener().open_url(url, None::<&str>).map_err(|_| msg("Couldn't open the browser. Try again."))?;
                let h = handle.clone();
                tauri::async_runtime::spawn(async move {
                    let code = google::await_code(listener, &state).await;
                    // Back to Wandika, where the result shows, instead of leaving you on the browser tab.
                    if let Some(w) = h.get_webview_window("main") {
                        let _ = w.unminimize();
                        let _ = w.set_focus();
                    }
                    match code {
                        Ok(code) => finish_google(&h, &code, &pkce.verifier, &redirect).await,
                        Err(e) => {
                            let _ = h.emit("connectors-changed", json!({ "provider": "google", "error": e.friendly().1 }));
                        }
                    }
                });
            }
            #[cfg(mobile)]
            {
                let redirect = google::mobile_redirect()?;
                let url = google::auth_url(&redirect, &pkce, &state)?;
                *app.pending.lock().unwrap() = Some(oauth::Pending {
                    provider: "google",
                    verifier: pkce.verifier.clone(),
                    state,
                    redirect_uri: redirect,
                });
                handle.opener().open_url(url, None::<&str>).map_err(|_| msg("Couldn't open the browser. Try again."))?;
            }
            Ok(json!({ "kind": "browser" }))
        }
        "microsoft" => {
            let start = microsoft::start(&app.http).await?;
            Ok(json!({ "kind": "device", "device_code": start.device_code, "user_code": start.user_code,
                       "verification_uri": start.verification_uri, "interval": start.interval }))
        }
        "apple_calendar" | "apple_reminders" => {
            let kind = if provider == "apple_calendar" { apple::Kind::Calendar } else { apple::Kind::Reminders };
            let access = tauri::async_runtime::spawn_blocking(move || apple::request(kind))
                .await
                .map_err(|_| msg("Wandika couldn't finish that. Try again."))??;
            Ok(json!({ "kind": "done", "access": access }))
        }
        _ => Err(msg("Unknown connection.")),
    }
}

/// Outlook device-code polling. True once connected.
#[tauri::command]
pub async fn connector_poll(app: S<'_>, device_code: String) -> Result<bool> {
    match microsoft::poll(&app.http, &device_code).await? {
        microsoft::Poll::Pending => Ok(false),
        microsoft::Poll::Done(tokens) => {
            app.secrets.set_json(microsoft::KEY, &tokens)?;
            Ok(true)
        }
    }
}

#[tauri::command]
pub async fn connector_disconnect(app: S<'_>, provider: String) -> Result<()> {
    match provider.as_str() {
        "google" => app.secrets.delete(google::KEY),
        "microsoft" => app.secrets.delete(microsoft::KEY),
        // EventKit access can only be withdrawn in System Settings or iOS Settings.
        _ => return Err(msg("Turn this off in Settings, under Privacy, on this device.")),
    }
    Ok(())
}

#[derive(Serialize, Default)]
pub struct Today {
    events: Vec<CalEvent>,
    mail: Vec<MailItem>,
    tasks: Vec<VaultTask>,
    remote_tasks: Vec<RemoteTask>,
    /// Source name → what went wrong, shown beside that source only.
    /// Per source: what failed, in plain words, and a code (`provider_auth` means reconnect).
    errors: BTreeMap<String, ErrorInfo>,
}

#[tauri::command]
pub async fn today(app: S<'_>, date: Option<String>) -> Result<Today> {
    let day = parse_date(date)?;
    let from = Local
        .from_local_datetime(&day.and_hms_opt(0, 0, 0).unwrap())
        .earliest()
        .ok_or_else(|| msg("That date doesn't exist here."))?
        .to_utc();
    let to = from + Duration::days(1);
    let mut out = Today::default();
    let has = |key: &str| app.secrets.get(key).is_some();

    if has(google::KEY) {
        let gmail = async {
            if crate::config::gmail() { google::mail(&app.http, &app.secrets).await } else { Ok(Vec::new()) }
        };
        let (ev, ml, tk) = futures::join!(
            google::events(&app.http, &app.secrets, from, to),
            gmail,
            google::tasks(&app.http, &app.secrets)
        );
        collect(&mut out, "Google Calendar", ev, |o, v| o.events.extend(v));
        collect(&mut out, "Gmail", ml, |o, v| o.mail.extend(v));
        collect(&mut out, "Google Tasks", tk, |o, v| o.remote_tasks.extend(v));
    }
    if has(microsoft::KEY) {
        let (ev, ml) = futures::join!(
            microsoft::events(&app.http, &app.secrets, from, to),
            microsoft::mail(&app.http, &app.secrets)
        );
        collect(&mut out, "Outlook Calendar", ev, |o, v| o.events.extend(v));
        collect(&mut out, "Outlook Mail", ml, |o, v| o.mail.extend(v));
    }
    let apple = tauri::async_runtime::spawn_blocking(move || (apple::events(from, to), apple::reminders()))
        .await
        .map_err(|_| msg("Wandika couldn't finish that. Try again."))?;
    collect(&mut out, "Apple Calendar", apple.0, |o, v| o.events.extend(v));
    collect(&mut out, "Reminders", apple.1, |o, v| o.remote_tasks.extend(v));

    if app.vault().is_ok() {
        out.tasks = with_index(&app, |i, _| i.tasks())?.into_iter().filter(|t| !t.done).collect();
    }
    out.events.sort_by(|a, b| b.all_day.cmp(&a.all_day).then(a.start.cmp(&b.start)));
    out.mail.sort_by(|a, b| b.date.cmp(&a.date));
    Ok(out)
}

#[derive(Serialize)]
pub struct ErrorInfo {
    code: &'static str,
    message: String,
}

fn collect<T>(out: &mut Today, source: &str, r: Result<Vec<T>>, add: impl FnOnce(&mut Today, Vec<T>)) {
    match r {
        Ok(v) => add(out, v),
        Err(e) => {
            let (code, message) = e.friendly();
            out.errors.insert(source.to_string(), ErrorInfo { code, message });
        }
    }
}

#[tauri::command]
pub async fn remote_task_toggle(app: S<'_>, source: String, list_id: String, id: String, done: bool) -> Result<()> {
    match source.as_str() {
        "google" => google::set_task_done(&app.http, &app.secrets, &list_id, &id, done).await,
        "apple" => tauri::async_runtime::spawn_blocking(move || apple::set_reminder_done(&id, done))
            .await
            .map_err(|_| msg("Wandika couldn't finish that. Try again."))?,
        _ => Err(msg("Unknown task list.")),
    }
}

fn yaml(s: &str) -> String {
    format!("\"{}\"", s.replace('\\', "\\\\").replace('"', "\\\""))
}

/// Notes Claude Code changed through `wandika mcp` in the last two minutes, for the app to reload.
#[tauri::command]
pub async fn external_changes(app: S<'_>) -> Result<Vec<crate::outside::Change>> {
    let list = crate::outside::read_changes(&crate::outside::changes_file(&app)?);
    if !list.is_empty() {
        changed(&app);
    }
    Ok(list)
}

/// One email, whole, to read in the app.
#[tauri::command]
pub async fn mail_read(app: S<'_>, source: String, id: String) -> Result<MailBody> {
    match source.as_str() {
        "google" if !crate::config::gmail() => Err(msg("Gmail isn't part of this version of Wandika.")),
        "google" => google::mail_body(&app.http, &app.secrets, &id).await,
        "microsoft" => microsoft::mail_body(&app.http, &app.secrets, &id, true).await,
        _ => Err(msg("Unknown mailbox.")),
    }
}

#[tauri::command]
pub async fn mail_to_note(app: S<'_>, source: String, id: String) -> Result<String> {
    let m = match source.as_str() {
        "google" if !crate::config::gmail() => return Err(msg("Gmail isn't part of this version of Wandika.")),
        "google" => google::mail_body(&app.http, &app.secrets, &id).await?,
        "microsoft" => microsoft::mail_body(&app.http, &app.secrets, &id, false).await?,
        _ => return Err(msg("Unknown mailbox.")),
    };
    let mut body = format!("---\nfrom: {}\nto: {}\ndate: {}\n", yaml(&m.from), yaml(&m.to), yaml(&m.date));
    if let Some(url) = &m.url {
        body.push_str(&format!("source: {}\n", yaml(url)));
    }
    body.push_str(&format!("---\n\n# {}\n\n{}\n", m.subject.trim(), m.text.trim()));
    let title = if m.subject.trim().is_empty() { "Email".to_string() } else { m.subject.trim().chars().take(80).collect() };
    let path = vault::create_note(&app.root()?, "Mail", &title, &body, &app.crypto()?)?;
    changed(&app);
    Ok(path)
}

#[tauri::command]
pub async fn event_to_note(app: S<'_>, event: CalEvent) -> Result<String> {
    let start = chrono::DateTime::parse_from_rfc3339(&event.start).map(|d| d.with_timezone(&Local));
    let day = start.as_ref().map(|d| d.format("%Y-%m-%d").to_string()).unwrap_or_else(|_| event.start.chars().take(10).collect());
    let when = match (&start, event.all_day) {
        (Ok(d), false) => d.format("%A %-d %B %Y, %H:%M").to_string(),
        _ => day.clone(),
    };
    let mut body = format!("---\nevent: {}\ndate: {day}\ncalendar: {}\n", yaml(&event.title), yaml(&event.calendar));
    if let Some(url) = &event.url {
        body.push_str(&format!("link: {}\n", yaml(url)));
    }
    body.push_str(&format!("---\n\n# {}\n\n{when}", event.title));
    if let Some(loc) = &event.location {
        body.push_str(&format!(", {loc}"));
    }
    body.push_str("\n\n");
    if !event.attendees.is_empty() {
        body.push_str("## People\n\n");
        for a in &event.attendees {
            body.push_str(&format!("- {a}\n"));
        }
        body.push('\n');
    }
    body.push_str("## Notes\n\n\n## Actions\n\n- [ ] \n");
    let root = app.root()?;
    let crypto = app.crypto()?;
    let title = format!("{day} {}", event.title);
    // Opening the same meeting twice returns the note made the first time.
    // Looked up by the name the note was saved under, where `/`, `:` and `?` became `-`.
    let name = vault::clean_name(&title)?;
    let existing = with_index(&app, |i, _| i.resolve(&format!("Meetings/{name}")))?;
    if let Some(p) = existing {
        return Ok(p);
    }
    let path = vault::create_note(&root, "Meetings", &title, &body, &crypto)?;
    changed(&app);
    Ok(path)
}

/// Adds today's events to the daily note under "## Agenda", skipping ones already there.
#[tauri::command]
pub async fn agenda_to_daily(app: S<'_>, date: Option<String>, events: Vec<CalEvent>) -> Result<String> {
    let (root, crypto) = (app.root()?, app.crypto()?);
    let path = vault::daily_note(&root, parse_date(date)?, &crypto)?;
    let text = vault::read_note(&root, &path, &crypto)?;
    let lines: Vec<String> = events
        .iter()
        .map(|e| {
            let time = if e.all_day {
                "All day".to_string()
            } else {
                chrono::DateTime::parse_from_rfc3339(&e.start)
                    .map(|d| d.with_timezone(&Local).format("%H:%M").to_string())
                    .unwrap_or_default()
            };
            format!("- {time} {}", e.title)
        })
        // Whole lines: "Standup" is not already there because "Standup review" is.
        .filter(|l| !text.lines().any(|t| t.trim_end() == l))
        .collect();
    if lines.is_empty() {
        return Ok(path);
    }
    let block = lines.join("\n");
    let updated = match text.find("## Agenda") {
        Some(i) => {
            let (head, rest) = text.split_at(i + "## Agenda".len());
            let rest = rest.trim_start_matches(['\n', ' ']);
            if rest.is_empty() {
                format!("{head}\n\n{block}\n")
            } else {
                format!("{head}\n\n{block}\n\n{rest}")
            }
        }
        None => format!("{}\n\n## Agenda\n\n{block}\n", text.trim_end()),
    };
    vault::write_note(&root, &path, &updated, &crypto)?;
    changed(&app);
    Ok(path)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::test_http::block_on;
    use tauri::test::{mock_app, MockRuntime};

    fn app(tag: &str) -> (tauri::App<MockRuntime>, std::path::PathBuf) {
        let dir = std::env::temp_dir().join(format!("wandika-cmd-{tag}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let a = mock_app();
        a.manage(App::new(dir.clone()));
        (a, dir)
    }

    fn ev(title: &str, start: &str, all_day: bool) -> CalEvent {
        CalEvent {
            id: "e".into(), source: "google".into(), calendar: "Work".into(), title: title.into(), start: start.into(),
            end: start.into(), all_day, location: None, url: None, attendees: vec![],
        }
    }

    #[test]
    fn a_meeting_with_symbols_in_its_title_gets_one_note() {
        let (a, dir) = app("event-twice");
        block_on(vault_create_local(a.state(), "Notes".into(), None)).unwrap();
        let e = ev("Sync: Q4 / plan?", "2026-11-03", true);
        let first = block_on(event_to_note(a.state(), e.clone())).unwrap();
        assert_eq!(first, "Meetings/2026-11-03 Sync- Q4 - plan-.md");
        assert_eq!(block_on(event_to_note(a.state(), e)).unwrap(), first, "the second open finds the first note");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn an_agenda_line_is_skipped_only_when_the_same_line_is_there() {
        let (a, dir) = app("agenda-similar");
        block_on(vault_create_local(a.state(), "Notes".into(), None)).unwrap();
        let day = Some("2026-11-03".to_string());
        block_on(agenda_to_daily(a.state(), day.clone(), vec![ev("Standup review", "2026-11-03", true)])).unwrap();
        let path = block_on(agenda_to_daily(a.state(), day, vec![ev("Standup", "2026-11-03", true)])).unwrap();
        let text = block_on(note_read(a.state(), path)).unwrap();
        assert!(text.contains("- All day Standup\n") && text.contains("- All day Standup review\n"), "{text}");
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// A vault in the app's own storage, open, with its files folder.
    fn open_vault(a: &tauri::App<MockRuntime>) -> std::path::PathBuf {
        block_on(vault_create_local(a.state(), "Notes".into(), None)).unwrap();
        a.state::<App>().root().unwrap()
    }

    fn put(root: &std::path::Path, rel: &str, text: &str) {
        let path = root.join(rel);
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        std::fs::write(path, text).unwrap();
    }

    #[test]
    fn status_shows_the_vault_sign_in_and_connections() {
        let (a, dir) = app("status");
        let s = serde_json::to_value(block_on(status(a.state())).unwrap()).unwrap();
        assert_eq!(s["vault"], Value::Null);
        assert_eq!(s["encryption"], Value::Null);
        assert_eq!(s["last_sync"], Value::Null);
        assert_eq!(s["connectors"]["google"], Value::Null);
        assert!(s["configured"].is_object());
        assert!(s["connectors"]["apple_calendar"].is_string());

        // A user saved without a token in the keychain is not signed in.
        a.state::<App>().update_settings(|s| s.user = Some(User { login: "amina".into(), name: None, avatar_url: "u".into() })).unwrap();
        assert_eq!(serde_json::to_value(block_on(status(a.state())).unwrap()).unwrap()["user"], Value::Null);
        a.state::<App>().secrets.set(GITHUB_KEY, "gho").unwrap();
        a.state::<App>().secrets.set_json(google::KEY, &oauth::TokenSet { access_token: "a".into(), refresh_token: None, expires_at: 0, account: Some("amina@gmail.com".into()) }).unwrap();
        a.state::<App>().secrets.set_json(microsoft::KEY, &oauth::TokenSet { access_token: "a".into(), refresh_token: None, expires_at: 0, account: None }).unwrap();
        open_vault(&a);
        let s = serde_json::to_value(block_on(status(a.state())).unwrap()).unwrap();
        assert_eq!(s["user"]["login"], "amina");
        assert_eq!(s["vault"]["name"], "Notes");
        assert_eq!(s["known"].as_array().unwrap().len(), 1);
        assert_eq!(s["encryption"], json!({ "set_up": false, "unlocked": false, "folders": [] }));
        assert_eq!(s["connectors"]["google"], "amina@gmail.com");
        assert_eq!(s["connectors"]["microsoft"], "Connected", "an account without an address still shows as connected");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn changes_made_through_mcp_reach_the_app() {
        let (a, dir) = app("external");
        block_on(vault_create_local(a.state(), "Notes".into(), None)).unwrap();
        assert!(block_on(external_changes(a.state())).unwrap().is_empty());
        let file = crate::outside::changes_file(&a.state()).unwrap();
        std::fs::write(&file, r#"[{"path":"Ideas.md","at":5}]"#).unwrap();
        assert_eq!(block_on(external_changes(a.state())).unwrap(), vec![crate::outside::Change { path: "Ideas.md".into(), at: 5 }]);
        std::fs::write(&file, "broken").unwrap();
        assert!(block_on(external_changes(a.state())).unwrap().is_empty(), "an unreadable list is no changes");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn local_vaults_are_named_switched_forgotten_and_closed() {
        let (a, dir) = app("vaults");
        assert_eq!(block_on(vault_create_local(a.state(), "  ".into(), None)).unwrap_err().to_string(), "Give the vault a name.");
        let gone = dir.join("nowhere").to_string_lossy().into_owned();
        assert_eq!(block_on(vault_create_local(a.state(), "X".into(), Some(gone))).unwrap_err().to_string(), "That folder doesn't exist any more. Choose it again.");

        block_on(vault_create_local(a.state(), "My Notes! 2026".into(), None)).unwrap();
        let first = a.state::<App>().vault().unwrap();
        assert_eq!(first.name, "My Notes! 2026");
        let (prefix, suffix) = first.id.rsplit_once('-').unwrap();
        assert_eq!(prefix, "local/my-notes--2026");
        assert!(suffix.len() == 6 && suffix.chars().all(|c| c.is_ascii_alphanumeric() && !c.is_ascii_uppercase()), "{suffix}");
        assert!(a.state::<App>().root().unwrap().is_dir());

        let folder = dir.join("Obsidian Vault");
        std::fs::create_dir_all(&folder).unwrap();
        block_on(vault_create_local(a.state(), "".into(), Some(folder.to_string_lossy().into()))).unwrap();
        let second = a.state::<App>().vault().unwrap();
        assert_eq!((second.name.as_str(), second.folder.as_deref()), ("Obsidian Vault", Some(folder.as_path())));
        assert_ne!(second.id, first.id);

        block_on(vault_switch(a.state(), first.id.clone())).unwrap();
        assert_eq!(a.state::<App>().vault().unwrap().id, first.id);
        assert_eq!(block_on(vault_switch(a.state(), "local/none".into())).unwrap_err().to_string(), "That vault is gone.");
        std::fs::remove_dir_all(&folder).unwrap();
        assert_eq!(block_on(vault_switch(a.state(), second.id.clone())).unwrap_err().to_string(), "That vault's folder was moved or deleted.");

        block_on(vault_forget(a.state(), second.id.clone())).unwrap();
        assert_eq!(a.state::<App>().settings().known.len(), 1);
        assert_eq!(a.state::<App>().vault().unwrap().id, first.id, "forgetting another vault leaves this one open");
        block_on(vault_close(a.state())).unwrap();
        assert!(a.state::<App>().vault().is_err());
        assert_eq!(a.state::<App>().settings().known.len(), 1, "closing keeps it in the list");
        block_on(vault_switch(a.state(), first.id.clone())).unwrap();
        block_on(vault_forget(a.state(), first.id)).unwrap();
        assert!(a.state::<App>().vault().is_err() && a.state::<App>().settings().known.is_empty());
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn signing_out_closes_a_synced_vault_and_keeps_a_local_one() {
        let (a, dir) = app("sign-out");
        let st = a.state::<App>();
        st.secrets.set(GITHUB_KEY, "gho").unwrap();
        let local = VaultConfig { id: "local/a".into(), name: "A".into(), folder: None, remote: None };
        st.update_settings(|s| {
            s.user = Some(User { login: "amina".into(), name: None, avatar_url: String::new() });
            s.vault = Some(local.clone());
        })
        .unwrap();
        block_on(github_sign_out(a.state())).unwrap();
        assert!(st.secrets.get(GITHUB_KEY).is_none() && st.settings().user.is_none());
        assert_eq!(st.vault().unwrap().id, "local/a");

        let synced = VaultConfig { remote: Some(Target { owner: "amina".into(), repo: "notes".into(), branch: "main".into() }), ..local };
        st.update_settings(|s| s.vault = Some(synced)).unwrap();
        block_on(github_sign_out(a.state())).unwrap();
        assert!(st.vault().is_err());
        assert_eq!(st.settings().known.len(), 1, "it can be opened again after signing in");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn repository_names_are_checked_before_github_is_asked() {
        let (a, dir) = app("repo-name");
        for bad in ["", "  ", "my notes", "notes/2026", "nötes", "a:b"] {
            assert_eq!(
                block_on(repo_create(a.state(), bad.into())).unwrap_err().to_string(),
                "Use letters, numbers, dashes, dots or underscores for the repository name.",
                "{bad:?}"
            );
        }
        assert_eq!(block_on(repo_create(a.state(), " my-notes_2026.v2 ".into())).unwrap_err().to_string(), "Sign in with GitHub first.");
        assert_eq!(block_on(repos_list(a.state())).unwrap_err().to_string(), "Sign in with GitHub first.");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn notes_are_written_found_renamed_trashed_and_restored() {
        let (a, dir) = app("notes");
        assert_eq!(block_on(tree(a.state())).err().unwrap().to_string(), "Open or create a vault first.");
        let root = open_vault(&a);
        let path = block_on(note_create(a.state(), "Projects".into(), "Plan".into(), Some("Ship it\n- [ ] Call Amina 📅 2026-11-05\n".into()))).unwrap();
        assert_eq!(path, "Projects/Plan.md");
        assert_eq!(block_on(note_create(a.state(), "".into(), "Blank".into(), None)).unwrap(), "Blank.md");
        block_on(note_write(a.state(), "Daily.md".into(), "Talked about [[Plan]]".into())).unwrap();
        assert_eq!(block_on(note_read(a.state(), "Daily.md".into())).unwrap(), "Talked about [[Plan]]");
        block_on(folder_create(a.state(), "Archive/2026".into())).unwrap();
        assert!(root.join("Archive/2026").is_dir());

        // Every write is seen by the next lookup, without waiting for a rescan.
        assert_eq!(block_on(note_titles(a.state())).unwrap().len(), 3);
        assert_eq!(block_on(search(a.state(), "ship".into())).unwrap()[0].path, "Projects/Plan.md");
        assert_eq!(block_on(backlinks(a.state(), "Projects/Plan.md".into())).unwrap()[0].path, "Daily.md");
        assert_eq!(block_on(resolve_link(a.state(), "plan".into())).unwrap().as_deref(), Some("Projects/Plan.md"));
        let tasks = block_on(tasks_vault(a.state())).unwrap();
        assert_eq!((tasks.len(), tasks[0].line), (1, 1));
        assert!(block_on(task_toggle(a.state(), "Projects/Plan.md".into(), 1, tasks[0].text.clone())).unwrap());
        assert!(block_on(tasks_vault(a.state())).unwrap()[0].done);
        let text = block_on(tasks_vault(a.state())).unwrap()[0].text.clone();
        block_on(task_edit(a.state(), "Projects/Plan.md".into(), 1, text, "Ship it 📌 📅 2026-11-05".into(), "with notes".into())).unwrap();
        let edited = &block_on(tasks_vault(a.state())).unwrap()[0];
        assert_eq!((edited.text.as_str(), edited.details.as_str(), edited.due.as_deref()), ("Ship it 📌 📅 2026-11-05", "with notes", Some("2026-11-05")));
        let daily = block_on(task_add(a.state(), "Reply to Amina [email](https://mail.google.com/mail/u/0/#inbox/abc)".into())).unwrap();
        assert!(block_on(note_read(a.state(), daily.clone())).unwrap().contains("## Tasks\n\n- [ ] Reply to Amina [email]"));
        assert!(block_on(tasks_vault(a.state())).unwrap().iter().any(|t| t.path == daily && t.text.starts_with("Reply to Amina")));
        block_on(note_write(a.state(), "Projects/Plan.md".into(), block_on(note_read(a.state(), "Projects/Plan.md".into())).unwrap().replace("Ship it 📌 📅 2026-11-05\n  with notes", "Ship it"))).unwrap();
        std::fs::remove_file(root.join(&daily)).unwrap();

        assert_eq!(block_on(entry_rename(a.state(), "Projects/Plan.md".into(), "Roadmap".into())).unwrap(), "Projects/Roadmap.md");
        assert_eq!(block_on(note_read(a.state(), "Daily.md".into())).unwrap(), "Talked about [[Roadmap]]");
        assert_eq!(block_on(resolve_link(a.state(), "Roadmap".into())).unwrap().as_deref(), Some("Projects/Roadmap.md"));

        block_on(entry_trash(a.state(), "Projects/Roadmap.md".into())).unwrap();
        assert_eq!(block_on(resolve_link(a.state(), "Roadmap".into())).unwrap(), None);
        block_on(entry_restore(a.state(), "Projects/Roadmap.md".into())).unwrap();
        assert!(block_on(resolve_link(a.state(), "Roadmap".into())).unwrap().is_some());

        put(&root, "Untitled.md", "");
        assert!(block_on(note_discard_if_empty(a.state(), "Untitled.md".into())).unwrap());
        assert!(!block_on(note_discard_if_empty(a.state(), "Blank.md".into())).unwrap());
        assert!(block_on(tree(a.state())).unwrap().iter().any(|e| e.path == "Archive/2026" && e.kind == "folder"));
        assert!(block_on(note_read(a.state(), "../escape.md".into())).is_err());
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn templates_and_daily_notes_follow_the_vault_settings() {
        let (a, dir) = app("templates");
        let root = open_vault(&a);
        put(&root, ".obsidian/app.json", r#"{"newFileLocation":"folder","newFileFolderPath":"Inbox"}"#);
        assert_eq!(block_on(new_note_folder(a.state(), Some("Projects/Plan.md".into()))).unwrap(), "Inbox");
        put(&root, "Templates/Meeting.md", "# {{title}}\n{{date:YYYY}}");
        assert_eq!(block_on(templates_list(a.state())).unwrap(), ["Templates/Meeting.md"]);
        let text = block_on(template_render(a.state(), "Templates/Meeting.md".into(), "Board".into())).unwrap();
        assert_eq!(text, format!("# Board\n{}", Local::now().format("%Y")));
        assert!(block_on(template_render(a.state(), "Templates/Gone.md".into(), "x".into())).is_err());

        assert_eq!(block_on(daily_note(a.state(), Some("2026-11-03".into()))).unwrap(), "Daily/2026-11-03.md");
        assert_eq!(block_on(note_titles(a.state())).unwrap().len(), 2, "the new daily note is indexed at once");
        let today = block_on(daily_note(a.state(), None)).unwrap();
        assert_eq!(today, format!("Daily/{}.md", Local::now().format("%Y-%m-%d")));
        for bad in ["03/11/2026", "2026-13-01", "tomorrow"] {
            assert_eq!(block_on(daily_note(a.state(), Some(bad.into()))).unwrap_err().to_string(), "Dates look like 2026-11-02.");
        }
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn css_snippets_are_listed_and_toggled_the_obsidian_way() {
        let (a, dir) = app("snippets");
        let root = open_vault(&a);
        assert!(block_on(snippets_list(a.state())).unwrap().is_empty());
        put(&root, ".obsidian/snippets/wide.css", ".x{}");
        put(&root, ".obsidian/snippets/Accent.css", ":root{}");
        put(&root, ".obsidian/snippets/notes.txt", "not css");
        put(&root, ".obsidian/snippets/huge.css", &"a".repeat(256 * 1024 + 1));
        put(&root, ".obsidian/appearance.json", r#"{"theme":"obsidian","enabledCssSnippets":["wide","gone"]}"#);
        let list = block_on(snippets_list(a.state())).unwrap();
        let shown: Vec<(&str, bool)> = list.iter().map(|s| (s.name.as_str(), s.enabled)).collect();
        assert_eq!(shown, [("Accent", false), ("wide", true)], "sorted, CSS only, nothing over 256 KB");
        assert_eq!(list[0].css, ":root{}");

        block_on(snippet_toggle(a.state(), "Accent".into(), true)).unwrap();
        block_on(snippet_toggle(a.state(), "wide".into(), false)).unwrap();
        block_on(snippet_toggle(a.state(), "Accent".into(), true)).unwrap();
        let v: Value = serde_json::from_str(&std::fs::read_to_string(root.join(".obsidian/appearance.json")).unwrap()).unwrap();
        assert_eq!(v, json!({ "theme": "obsidian", "enabledCssSnippets": ["gone", "Accent"] }), "Obsidian's other settings stay");

        put(&root, ".obsidian/appearance.json", "[1,2]");
        block_on(snippet_toggle(a.state(), "wide".into(), true)).unwrap();
        let v: Value = serde_json::from_str(&std::fs::read_to_string(root.join(".obsidian/appearance.json")).unwrap()).unwrap();
        assert_eq!(v, json!({ "enabledCssSnippets": ["wide"] }), "a damaged file is replaced");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn encryption_is_set_up_used_locked_and_unlocked() {
        let (a, dir) = app("encryption");
        open_vault(&a);
        assert!(block_on(encryption_setup(a.state(), "short".into())).is_err());
        let st = block_on(encryption_setup(a.state(), "long passphrase".into())).unwrap();
        assert!(st.set_up && st.unlocked);
        block_on(note_write(a.state(), "Diary.md".into(), "dear diary".into())).unwrap();
        assert_eq!(block_on(set_encrypted(a.state(), "Diary.md".into(), true)).unwrap(), "Diary.md.age");
        assert_eq!(block_on(note_read(a.state(), "Diary.md.age".into())).unwrap(), "dear diary");

        let st = block_on(encryption_lock(a.state())).unwrap();
        assert!(st.set_up && !st.unlocked);
        assert_eq!(block_on(note_read(a.state(), "Diary.md.age".into())).unwrap_err().friendly().0, "locked");
        let titles = block_on(note_titles(a.state())).unwrap();
        assert!(titles[0].locked, "the index notices the lock");
        assert!(block_on(encryption_unlock(a.state(), "wrong passphrase".into())).is_err());
        assert!(block_on(encryption_unlock(a.state(), "long passphrase".into())).unwrap().unlocked);
        assert_eq!(block_on(note_read(a.state(), "Diary.md.age".into())).unwrap(), "dear diary");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn held_deletions_are_brought_back_or_confirmed_and_disconnecting_keeps_the_files() {
        let (a, dir) = app("held");
        let st = a.state::<App>();
        let target = Target { owner: "amina".into(), repo: "notes".into(), branch: "main".into() };
        st.update_settings(|s| s.vault = Some(VaultConfig { id: "github/amina/notes".into(), name: "notes".into(), folder: None, remote: Some(target) })).unwrap();
        let paths = st.paths().unwrap();
        let hub = dir.join("hub.git");
        git2::Repository::init_bare(&hub).unwrap();
        let remote = sync::Remote {
            url: format!("file://{}", hub.display()), token: String::new(), branch: "main".into(),
            author: "Test".into(), email: "t@example.com".into(), device: "test".into(),
        };
        let ctl = || sync::Ctl { cancel: Default::default(), progress: Box::new(|_, _, _| {}) };
        for i in 0..30 {
            put(&paths.files, &format!("n/{i}.md"), "x");
        }
        sync::sync(&paths, &remote, &ctl()).unwrap();
        std::fs::remove_dir_all(paths.files.join("n")).unwrap();
        let held = sync::sync(&paths, &remote, &ctl()).unwrap().held_deletions;
        assert_eq!(held.len(), 30);

        block_on(sync_held_deletions(a.state(), false, held[..2].to_vec())).unwrap();
        assert!(paths.files.join(&held[0]).exists() && paths.files.join(&held[1]).exists());
        assert!(!paths.files.join(&held[2]).exists(), "only the ones asked for");
        block_on(sync_held_deletions(a.state(), true, vec![])).unwrap();
        assert!(sync::load_state(&paths).confirm_deletions);

        block_on(sync_cancel(a.state())).unwrap();
        assert!(st.sync_cancel.load(std::sync::atomic::Ordering::Relaxed));

        block_on(vault_disconnect_remote(a.state())).unwrap();
        assert!(st.vault().unwrap().remote.is_none());
        assert!(!paths.state.exists(), "sync state goes with the remote");
        assert!(paths.files.join(&held[0]).exists(), "the files stay");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn connections_that_cannot_be_turned_off_here_say_where() {
        let (a, dir) = app("disconnect");
        let st = a.state::<App>();
        st.secrets.set(google::KEY, "{}").unwrap();
        st.secrets.set(microsoft::KEY, "{}").unwrap();
        block_on(connector_disconnect(a.state(), "google".into())).unwrap();
        block_on(connector_disconnect(a.state(), "microsoft".into())).unwrap();
        assert!(st.secrets.get(google::KEY).is_none() && st.secrets.get(microsoft::KEY).is_none());
        assert_eq!(
            block_on(connector_disconnect(a.state(), "apple_calendar".into())).unwrap_err().to_string(),
            "Turn this off in Settings, under Privacy, on this device."
        );
        assert_eq!(block_on(remote_task_toggle(a.state(), "jira".into(), "l".into(), "i".into(), true)).unwrap_err().to_string(), "Unknown task list.");
        assert_eq!(block_on(mail_to_note(a.state(), "yahoo".into(), "i".into())).unwrap_err().to_string(), "Unknown mailbox.");
        assert_eq!(block_on(mail_read(a.state(), "yahoo".into(), "i".into())).unwrap_err().to_string(), "Unknown mailbox.");
        assert_eq!(
            block_on(remote_task_toggle(a.state(), "google".into(), "l".into(), "i".into(), true)).unwrap_err().to_string(),
            "Connect Google in Settings first.",
            "nothing is sent without a connection"
        );
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn a_meeting_note_holds_its_details_and_people() {
        let (a, dir) = app("event-note");
        open_vault(&a);
        let mut e = ev("Board \"Q4\" review", "2026-11-03T09:00:00+03:00", false);
        e.url = Some("https://meet.google.com/abc".into());
        e.location = Some("Room 4".into());
        e.attendees = vec!["Amina".into(), "Bob".into()];
        let local = chrono::DateTime::parse_from_rfc3339(&e.start).unwrap().with_timezone(&Local);
        let day = local.format("%Y-%m-%d").to_string();
        let path = block_on(event_to_note(a.state(), e)).unwrap();
        assert_eq!(path, format!("Meetings/{day} Board -Q4- review.md"));
        let text = block_on(note_read(a.state(), path)).unwrap();
        assert_eq!(
            text,
            format!(
                "---\nevent: \"Board \\\"Q4\\\" review\"\ndate: {day}\ncalendar: \"Work\"\nlink: \"https://meet.google.com/abc\"\n---\n\n# Board \"Q4\" review\n\n{}, Room 4\n\n## People\n\n- Amina\n- Bob\n\n## Notes\n\n\n## Actions\n\n- [ ] \n",
                local.format("%A %-d %B %Y, %H:%M")
            )
        );
        let all_day = block_on(event_to_note(a.state(), ev("Holiday", "2026-12-25T00:00:00", true))).unwrap();
        assert_eq!(all_day, "Meetings/2026-12-25 Holiday.md", "a date without a zone keeps its day");
        let text = block_on(note_read(a.state(), all_day)).unwrap();
        assert!(text.contains("# Holiday\n\n2026-12-25\n\n## Notes") && !text.contains("## People"), "{text}");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn the_agenda_goes_under_its_heading_once() {
        let (a, dir) = app("agenda");
        let root = open_vault(&a);
        let day = Some("2026-11-03".to_string());
        let timed = ev("Standup", "2026-11-03T09:00:00+03:00", false);
        let time = chrono::DateTime::parse_from_rfc3339(&timed.start).unwrap().with_timezone(&Local).format("%H:%M").to_string();
        let path = block_on(agenda_to_daily(a.state(), day.clone(), vec![ev("Holiday", "2026-11-03", true), timed.clone()])).unwrap();
        assert_eq!(path, "Daily/2026-11-03.md");
        let expected = format!("# Tuesday 3 November 2026\n\n## Agenda\n\n- All day Holiday\n- {time} Standup\n\n## Notes\n\n## Tasks\n\n");
        assert_eq!(std::fs::read_to_string(root.join(&path)).unwrap(), expected);
        block_on(agenda_to_daily(a.state(), day.clone(), vec![timed])).unwrap();
        assert_eq!(std::fs::read_to_string(root.join(&path)).unwrap(), expected, "nothing added twice");
        assert_eq!(block_on(agenda_to_daily(a.state(), day.clone(), vec![])).unwrap(), path);

        // A daily note without an agenda heading gets one at the end; one with an empty agenda at the end fills it.
        put(&root, "Daily/2026-11-04.md", "My own layout\n\n");
        block_on(agenda_to_daily(a.state(), Some("2026-11-04".into()), vec![ev("Trip", "2026-11-04", true)])).unwrap();
        assert_eq!(std::fs::read_to_string(root.join("Daily/2026-11-04.md")).unwrap(), "My own layout\n\n## Agenda\n\n- All day Trip\n");
        put(&root, "Daily/2026-11-05.md", "# Day\n\n## Agenda\n");
        block_on(agenda_to_daily(a.state(), Some("2026-11-05".into()), vec![ev("Trip", "2026-11-05", true)])).unwrap();
        assert_eq!(std::fs::read_to_string(root.join("Daily/2026-11-05.md")).unwrap(), "# Day\n\n## Agenda\n\n- All day Trip\n");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn dates_yaml_and_per_source_errors() {
        assert_eq!(parse_date(Some("2026-02-28".into())).unwrap(), NaiveDate::from_ymd_opt(2026, 2, 28).unwrap());
        assert!(parse_date(Some("2026-02-30".into())).is_err());
        assert_eq!(parse_date(None).unwrap(), Local::now().date_naive());
        assert_eq!(yaml(r#"He said "hi" \ bye"#), r#""He said \"hi\" \\ bye""#);
        assert_eq!(yaml(""), r#""""#);

        let mut out = Today::default();
        let task = RemoteTask {
            id: "t".into(), source: "google".into(), list_id: "l".into(), list: "Tasks".into(), title: "Pay".into(), done: false, due: None,
        };
        collect(&mut out, "Google Tasks", Ok(vec![task]), |o, v| o.remote_tasks.extend(v));
        let failed: Result<Vec<MailItem>> = Err(crate::error::Error::Provider { provider: "Outlook", status: 401, message: "raw".into() });
        collect(&mut out, "Outlook Mail", failed, |o, v| o.mail.extend(v));
        let v = serde_json::to_value(&out).unwrap();
        assert_eq!(v["remote_tasks"][0]["title"], "Pay", "a source that works is shown");
        assert_eq!(v["errors"]["Outlook Mail"]["code"], "provider_auth", "one that fails says so beside it");
        assert!(v["errors"]["Outlook Mail"]["message"].as_str().unwrap().contains("Reconnect"));
        assert!(!v["errors"].as_object().unwrap().contains_key("Google Tasks"));
        assert_eq!((v["events"].clone(), v["mail"].clone(), v["tasks"].clone()), (json!([]), json!([]), json!([])));
    }

    fn ipc_app(tag: &str) -> (tauri::App<MockRuntime>, tauri::WebviewWindow<MockRuntime>, std::path::PathBuf) {
        let dir = std::env::temp_dir().join(format!("wandika-cmd-{tag}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let a = tauri::test::mock_builder()
            .invoke_handler(tauri::generate_handler![attachment_save, attachment_read])
            .build(tauri::test::mock_context(tauri::test::noop_assets()))
            .unwrap();
        a.manage(App::new(dir.clone()));
        let w = tauri::WebviewWindowBuilder::new(&a, "main", Default::default()).build().unwrap();
        (a, w, dir)
    }

    fn invoke(w: &tauri::WebviewWindow<MockRuntime>, cmd: &str, body: tauri::ipc::InvokeBody, headers: &[(&'static str, &str)]) -> std::result::Result<tauri::ipc::InvokeResponseBody, Value> {
        let mut map = tauri::http::HeaderMap::new();
        for (k, v) in headers {
            map.insert(*k, v.parse().unwrap());
        }
        tauri::test::get_ipc_response(
            w,
            tauri::webview::InvokeRequest {
                cmd: cmd.into(),
                callback: tauri::ipc::CallbackFn(0),
                error: tauri::ipc::CallbackFn(1),
                url: "tauri://localhost".parse().unwrap(),
                body,
                headers: map,
                invoke_key: tauri::test::INVOKE_KEY.to_string(),
            },
        )
    }

    #[test]
    fn attachments_arrive_as_raw_bytes_and_go_back_the_same_way() {
        let (a, w, dir) = ipc_app("attachments");
        open_vault(&a);
        let png = vec![0x89, b'P', b'N', b'G', 0, 1, 2, 255];
        let saved = invoke(&w, "attachment_save", tauri::ipc::InvokeBody::Raw(png.clone()), &[("x-meta", "note=Projects%2FPlan.md&name=Picha%20ya%20Caf%C3%A9.png")]).unwrap();
        assert_eq!(saved.deserialize::<String>().unwrap(), "Picha ya Café.png");

        let body = |args: Value| tauri::ipc::InvokeBody::Json(args);
        match invoke(&w, "attachment_read", body(json!({ "target": "Picha ya Café.png", "from": "Projects/Plan.md" })), &[]).unwrap() {
            tauri::ipc::InvokeResponseBody::Raw(bytes) => assert_eq!(bytes, png),
            other => panic!("expected raw bytes, got {other:?}"),
        }
        let missing = invoke(&w, "attachment_read", body(json!({ "target": "nope.png", "from": "Plan.md" })), &[]).unwrap_err();
        assert_eq!(missing["message"], "nope.png isn't in this vault.");

        let no_name = invoke(&w, "attachment_save", tauri::ipc::InvokeBody::Raw(png.clone()), &[("x-meta", "note=Plan.md")]).unwrap_err();
        assert_eq!(no_name["message"], "The file has no name.");
        let not_raw = invoke(&w, "attachment_save", body(json!({})), &[("x-meta", "name=a.png")]).unwrap_err();
        assert_eq!(not_raw["message"], "No file data arrived.");
        let _ = std::fs::remove_dir_all(&dir);
    }
}
