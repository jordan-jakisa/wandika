//! Everything the interface can ask the Rust core to do.

use crate::connectors::{apple, google, microsoft, oauth, CalEvent, MailItem, RemoteTask};
use crate::crypto::{Crypto, CryptoStatus};
use crate::error::{msg, Result};
use crate::github::{self, DeviceCode, Repo, User};
use crate::state::{App, GITHUB_KEY};
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
    target: Option<Target>,
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
    let target = settings.target.clone().filter(|_| signed_in);
    let (last_sync, encryption) = match &target {
        Some(_) => (sync::load_state(&app.paths()?).last_sync, Some(app.crypto()?.status())),
        None => (None, None),
    };
    Ok(Status {
        configured: crate::config::configured(),
        user: settings.user.filter(|_| signed_in),
        target,
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

// GitHub sign-in and repository choice

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

#[tauri::command]
pub async fn github_sign_out(app: S<'_>) -> Result<()> {
    app.secrets.delete(GITHUB_KEY);
    app.update_settings(|s| {
        s.user = None;
        s.target = None;
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

#[tauri::command]
pub async fn vault_open(app: S<'_>, owner: String, repo: String) -> Result<SyncReport> {
    let gh = app.github()?;
    let info = gh.repo(&owner, &repo).await?;
    let target = Target { owner, repo, branch: info.default_branch.unwrap_or_else(|| "main".into()) };
    app.update_settings(|s| s.target = Some(target))?;
    sync_now(app).await
}

/// Back to the repository list. Files stay on the device so reopening the vault is instant.
#[tauri::command]
pub async fn vault_close(app: S<'_>) -> Result<()> {
    app.update_settings(|s| s.target = None)
}

#[tauri::command]
pub async fn sync_now(app: S<'_>) -> Result<SyncReport> {
    let gh = app.github()?;
    let target = app.target()?;
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

// Encryption

#[tauri::command]
pub async fn encryption_setup(app: S<'_>, passphrase: String) -> Result<CryptoStatus> {
    Ok(Crypto::set_up(&app.root()?, &app.secrets, &app.target()?.id(), &passphrase)?.status())
}

#[tauri::command]
pub async fn encryption_unlock(app: S<'_>, passphrase: String) -> Result<CryptoStatus> {
    Ok(Crypto::unlock(&app.root()?, &app.secrets, &app.target()?.id(), &passphrase)?.status())
}

#[tauri::command]
pub async fn encryption_lock(app: S<'_>) -> Result<CryptoStatus> {
    Crypto::lock(&app.secrets, &app.target()?.id());
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

    if app.target().is_ok() {
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
