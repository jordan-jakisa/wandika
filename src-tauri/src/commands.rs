//! Everything the interface can ask the Rust core to do.

use crate::connectors::{apple, google, microsoft, oauth, CalEvent, MailItem, RemoteTask};
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
pub async fn vault_open(app: S<'_>, owner: String, repo: String) -> Result<SyncReport> {
    let target = remote_for(&app, owner, repo).await?;
    let id = format!("github/{}/{}", target.owner, target.repo);
    let existing = app.settings().known.into_iter().find(|k| k.id == id);
    let vault = existing.unwrap_or(VaultConfig { id, name: target.repo.clone(), folder: None, remote: None });
    app.update_settings(|s| s.vault = Some(VaultConfig { remote: Some(target), ..vault }))?;
    sync_now(app).await
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
pub async fn vault_connect_remote(app: S<'_>, owner: String, repo: String) -> Result<SyncReport> {
    let mut vault = app.vault()?;
    if vault.remote.is_some() {
        return Err(msg("This vault already syncs with GitHub. Disconnect it first."));
    }
    vault.remote = Some(remote_for(&app, owner, repo).await?);
    let _ = std::fs::remove_file(app.paths()?.state);
    app.update_settings(|s| s.vault = Some(vault))?;
    sync_now(app).await
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
pub async fn sync_now(app: S<'_>) -> Result<SyncReport> {
    let target = app.target()?;
    let gh = app.github()?;
    let paths = app.paths()?;
    let Ok(_guard) = app.sync_lock.try_lock() else {
        return Err(msg("A sync is already running."));
    };
    let report = sync::sync(&gh, &target, &paths).await;
    changed(&app);
    report
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

/// The bytes of the file an embed in `from` points at.
#[tauri::command]
pub async fn attachment_read(app: S<'_>, target: String, from: String) -> Result<tauri::ipc::Response> {
    let root = app.root()?;
    let rel = crate::attachments::resolve(&root, &target, &from).ok_or_else(|| msg(format!("{target} isn't in this vault.")))?;
    Ok(tauri::ipc::Response::new(crate::attachments::read(&root, &rel, &app.crypto()?)?))
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
        json!({ "provider": "google", "error": result.err().map(|e| e.to_string()) }),
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
                handle.opener().open_url(url, None::<&str>).map_err(|e| msg(e.to_string()))?;
                let h = handle.clone();
                tauri::async_runtime::spawn(async move {
                    match google::await_code(listener, &state).await {
                        Ok(code) => finish_google(&h, &code, &pkce.verifier, &redirect).await,
                        Err(e) => {
                            let _ = h.emit("connectors-changed", json!({ "provider": "google", "error": e.to_string() }));
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
                handle.opener().open_url(url, None::<&str>).map_err(|e| msg(e.to_string()))?;
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
                .map_err(|e| msg(e.to_string()))??;
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
    errors: BTreeMap<String, String>,
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
        let (ev, ml, tk) = futures::join!(
            google::events(&app.http, &app.secrets, from, to),
            google::mail(&app.http, &app.secrets),
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
        .map_err(|e| msg(e.to_string()))?;
    collect(&mut out, "Apple Calendar", apple.0, |o, v| o.events.extend(v));
    collect(&mut out, "Reminders", apple.1, |o, v| o.remote_tasks.extend(v));

    if app.vault().is_ok() {
        out.tasks = with_index(&app, |i, _| i.tasks())?.into_iter().filter(|t| !t.done).collect();
    }
    out.events.sort_by(|a, b| b.all_day.cmp(&a.all_day).then(a.start.cmp(&b.start)));
    out.mail.sort_by(|a, b| b.date.cmp(&a.date));
    Ok(out)
}

fn collect<T>(out: &mut Today, source: &str, r: Result<Vec<T>>, add: impl FnOnce(&mut Today, Vec<T>)) {
    match r {
        Ok(v) => add(out, v),
        Err(e) => {
            out.errors.insert(source.to_string(), e.to_string());
        }
    }
}

#[tauri::command]
pub async fn remote_task_toggle(app: S<'_>, source: String, list_id: String, id: String, done: bool) -> Result<()> {
    match source.as_str() {
        "google" => google::set_task_done(&app.http, &app.secrets, &list_id, &id, done).await,
        "apple" => tauri::async_runtime::spawn_blocking(move || apple::set_reminder_done(&id, done))
            .await
            .map_err(|e| msg(e.to_string()))?,
        _ => Err(msg("Unknown task list.")),
    }
}

fn yaml(s: &str) -> String {
    format!("\"{}\"", s.replace('\\', "\\\\").replace('"', "\\\""))
}

#[tauri::command]
pub async fn mail_to_note(app: S<'_>, source: String, id: String) -> Result<String> {
    let m = match source.as_str() {
        "google" => google::mail_body(&app.http, &app.secrets, &id).await?,
        "microsoft" => microsoft::mail_body(&app.http, &app.secrets, &id).await?,
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
    let existing = with_index(&app, |i, _| i.resolve(&format!("Meetings/{}", title.replace('/', "-"))))?;
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
        .filter(|l| !text.contains(l.as_str()))
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
