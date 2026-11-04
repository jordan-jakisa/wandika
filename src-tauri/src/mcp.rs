//! `wandika mcp`: a Model Context Protocol server on stdin and stdout, so Claude Code can work with
//! the open vault's notes and tasks. It reads and writes the vault's files directly, so the app
//! doesn't need to be open. Encrypted notes stay locked and mail and calendars aren't offered.
//! Every change is noted in the vault's data folder, so a running Wandika reloads what changed.

use crate::crypto::Crypto;
use crate::error::{msg, Result};
use crate::outside::{changes_file, record_change};
use crate::state::App;
use crate::vault::{self, VaultTask};
use chrono::{Local, NaiveDate};
use serde::Serialize;
use serde_json::{json, Value};
use std::io::{BufRead, Write};
use std::path::PathBuf;

const PROTOCOL: &str = "2025-06-18";

/// Where the app keeps its settings: the same folder Tauri gives the app.
pub fn data_dir() -> PathBuf {
    if let Some(dir) = std::env::var_os("WANDIKA_DATA") {
        return PathBuf::from(dir);
    }
    let home = PathBuf::from(std::env::var_os("HOME").unwrap_or_default());
    if cfg!(target_os = "macos") {
        home.join("Library/Application Support/me.jordanjakisa.wandika")
    } else {
        home.join(".local/share/me.jordanjakisa.wandika")
    }
}

/// Serves until stdin closes. Returns the process exit code.
pub fn run() -> i32 {
    let server = Server::new(App::new(data_dir()));
    let stdin = std::io::stdin();
    let mut out = std::io::stdout().lock();
    for line in stdin.lock().lines() {
        let Ok(line) = line else { break };
        if line.trim().is_empty() {
            continue;
        }
        if let Some(reply) = server.handle(&line)
            && writeln!(out, "{reply}").and_then(|_| out.flush()).is_err()
        {
            break;
        }
    }
    0
}

pub struct Server {
    app: App,
}

impl Server {
    pub fn new(app: App) -> Self {
        Self { app }
    }

    /// One JSON-RPC message in; the reply, or None for a notification.
    pub fn handle(&self, line: &str) -> Option<String> {
        let req: Value = match serde_json::from_str(line) {
            Ok(v) => v,
            Err(_) => return Some(error(Value::Null, -32700, "That message isn't JSON.").to_string()),
        };
        let id = req.get("id").cloned()?;
        let method = req["method"].as_str().unwrap_or_default();
        let params = &req["params"];
        let reply = match method {
            "initialize" => json!({
                "jsonrpc": "2.0",
                "id": id,
                "result": {
                    "protocolVersion": params["protocolVersion"].as_str().unwrap_or(PROTOCOL),
                    "capabilities": { "tools": {} },
                    "serverInfo": { "name": "wandika", "version": env!("CARGO_PKG_VERSION") },
                    "instructions": "Wandika is a Markdown notes app (Obsidian compatible). These tools work on the vault open in Wandika on this device. Paths are relative to the vault, like \"Projects/Launch.md\". Tasks are Markdown checkboxes in the Obsidian Tasks format: 📅 YYYY-MM-DD is the due date, 🔺 ⏫ 🔼 🔽 ⏬ are priorities, 📌 pins a task, #word is a tag, and the indented lines under a task are its notes. Changes sync to GitHub through Wandika. Encrypted notes are not readable here.",
                },
            }),
            "ping" => json!({ "jsonrpc": "2.0", "id": id, "result": {} }),
            "tools/list" => json!({ "jsonrpc": "2.0", "id": id, "result": { "tools": tools() } }),
            "tools/call" => {
                let name = params["name"].as_str().unwrap_or_default();
                let args = params.get("arguments").cloned().unwrap_or_else(|| json!({}));
                let result = match self.call(name, &args) {
                    Ok(text) => json!({ "content": [{ "type": "text", "text": text }] }),
                    Err(e) => json!({ "content": [{ "type": "text", "text": e.friendly().1 }], "isError": true }),
                };
                json!({ "jsonrpc": "2.0", "id": id, "result": result })
            }
            _ => error(id, -32601, &format!("Wandika doesn't know “{method}”.")),
        };
        Some(reply.to_string())
    }

    fn root(&self) -> Result<PathBuf> {
        self.app.root()
    }

    /// Encrypted notes stay locked: Claude never gets the vault's key.
    fn crypto(&self) -> Result<Crypto> {
        Ok(Crypto::locked(&self.root()?))
    }

    fn index<T>(&self, f: impl FnOnce(&vault::Index, &Crypto) -> T) -> Result<T> {
        let (root, crypto) = (self.root()?, self.crypto()?);
        let mut index = self.app.index.lock().unwrap();
        index.ensure_fresh(&root, &crypto);
        Ok(f(&index, &crypto))
    }

    /// Notes the change for a running Wandika, and for the next lookup here.
    fn changed(&self, paths: &[String]) -> Result<()> {
        self.app.index.lock().unwrap().mark_stale();
        record_change(&changes_file(&self.app)?, paths)
    }

    pub fn call(&self, name: &str, args: &Value) -> Result<String> {
        let s = |key: &str| args[key].as_str().map(str::to_string);
        let need = |key: &str| s(key).filter(|v| !v.trim().is_empty()).ok_or_else(|| msg(format!("Give a “{key}”.")));
        match name {
            "search_notes" => {
                let q = need("query")?;
                let hits = self.index(|i, c| i.search(&q, c))?;
                Ok(to_text(&hits))
            }
            "list_notes" => {
                let folder = s("folder").map(|f| f.trim_matches('/').to_lowercase()).filter(|f| !f.is_empty());
                let mut notes = self.index(|i, _| i.titles())?;
                if let Some(f) = folder {
                    notes.retain(|n| n.path.to_lowercase().starts_with(&format!("{f}/")));
                }
                notes.sort_by_key(|n| std::cmp::Reverse(n.modified));
                let list: Vec<Value> = notes
                    .iter()
                    .take(500)
                    .map(|n| json!({ "path": n.path, "title": n.title, "tags": n.tags, "encrypted": n.encrypted }))
                    .collect();
                Ok(to_text(&list))
            }
            "read_note" => {
                let path = need("path")?;
                vault::read_note(&self.root()?, &path, &self.crypto()?)
            }
            "write_note" => {
                let (path, content) = (need("path")?, s("content").unwrap_or_default());
                let root = self.root()?;
                if !vault::safe(&root, &path)?.is_file() {
                    return Err(msg("There's no note at that path. Use create_note for a new one."));
                }
                vault::write_note(&root, &path, &content, &self.crypto()?)?;
                self.changed(std::slice::from_ref(&path))?;
                Ok(format!("Saved {path}."))
            }
            "append_to_note" => {
                let (path, text) = (need("path")?, need("text")?);
                let (root, crypto) = (self.root()?, self.crypto()?);
                let now = vault::read_note(&root, &path, &crypto)?;
                let sep = if now.is_empty() || now.ends_with("\n\n") { "" } else if now.ends_with('\n') { "\n" } else { "\n\n" };
                vault::write_note(&root, &path, &format!("{now}{sep}{}\n", text.trim_end()), &crypto)?;
                self.changed(std::slice::from_ref(&path))?;
                Ok(format!("Added to {path}."))
            }
            "create_note" => {
                let title = need("title")?;
                let path = vault::create_note(&self.root()?, &s("folder").unwrap_or_default(), &title, &s("body").unwrap_or_default(), &self.crypto()?)?;
                self.changed(std::slice::from_ref(&path))?;
                Ok(path)
            }
            "daily_note" => {
                let date = match s("date") {
                    Some(d) => NaiveDate::parse_from_str(&d, "%Y-%m-%d").map_err(|_| msg("Dates look like 2026-11-03."))?,
                    None => Local::now().date_naive(),
                };
                let (root, crypto) = (self.root()?, self.crypto()?);
                let path = vault::daily_note(&root, date, &crypto)?;
                self.changed(std::slice::from_ref(&path))?;
                let text = vault::read_note(&root, &path, &crypto)?;
                Ok(format!("{path}\n\n{text}"))
            }
            "list_tasks" => {
                let query = s("query").unwrap_or_default();
                let include_done = args["include_done"].as_bool().unwrap_or(false);
                let tasks: Vec<VaultTask> = self
                    .index(|i, _| i.tasks())?
                    .into_iter()
                    .filter(|t| (include_done || !t.done) && task_matches(t, &query))
                    .take(300)
                    .collect();
                Ok(to_text(&tasks))
            }
            "add_task" => {
                let text = need("text")?;
                let (root, crypto) = (self.root()?, self.crypto()?);
                let path = match s("path").filter(|p| !p.trim().is_empty()) {
                    Some(p) => p,
                    None => vault::daily_note(&root, Local::now().date_naive(), &crypto)?,
                };
                vault::add_task(&root, &path, &text, &crypto)?;
                self.changed(std::slice::from_ref(&path))?;
                Ok(format!("Added to {path}."))
            }
            "toggle_task" => {
                let (path, text) = (need("path")?, need("text")?);
                let line = line_of(args)?;
                let done = vault::toggle_task(&self.root()?, &path, line, &text, &self.crypto()?)?;
                self.changed(std::slice::from_ref(&path))?;
                Ok(if done { "Ticked.".into() } else { "Unticked.".into() })
            }
            "edit_task" => {
                let (path, text, new_text) = (need("path")?, need("text")?, need("new_text")?);
                let line = line_of(args)?;
                let root = self.root()?;
                let crypto = self.crypto()?;
                let details = match s("details") {
                    Some(d) => d,
                    None => self.index(|i, _| i.tasks())?.into_iter().find(|t| t.path == path && t.line == line).map(|t| t.details).unwrap_or_default(),
                };
                vault::edit_task(&root, &path, line, &text, &new_text, &details, &crypto)?;
                self.changed(std::slice::from_ref(&path))?;
                Ok("Saved.".into())
            }
            _ => Err(msg(format!("Wandika has no tool called “{name}”."))),
        }
    }
}

fn line_of(args: &Value) -> Result<usize> {
    args["line"].as_u64().map(|l| l as usize).ok_or_else(|| msg("Give the task's “line”, as list_tasks returns it."))
}

fn to_text<T: Serialize>(v: &T) -> String {
    serde_json::to_string_pretty(v).unwrap_or_default()
}

fn error(id: Value, code: i64, message: &str) -> Value {
    json!({ "jsonrpc": "2.0", "id": id, "error": { "code": code, "message": message } })
}

/// Every word must appear in the task, its notes or its note; a word starting with # must be one
/// of its tags, or a parent of one (#work finds #work/admin).
pub fn task_matches(t: &VaultTask, query: &str) -> bool {
    let hay = format!("{} {} {} {}", t.text, t.details, t.title, t.path).to_lowercase();
    let tags: Vec<String> = t
        .text
        .split_whitespace()
        .filter_map(|w| w.strip_prefix('#'))
        .filter(|w| w.chars().any(|c| c.is_alphabetic()))
        .map(|w| w.trim_end_matches([',', '.', ';', ':', '!', '?']).to_lowercase())
        .collect();
    query.split_whitespace().all(|w| match w.strip_prefix('#').filter(|t| !t.is_empty()) {
        Some(tag) => {
            let tag = tag.to_lowercase();
            tags.iter().any(|t| *t == tag || t.starts_with(&format!("{tag}/")))
        }
        None => hay.contains(&w.to_lowercase()),
    })
}

fn tools() -> Value {
    let path = json!({ "type": "string", "description": "The note's path in the vault, like \"Projects/Launch.md\"." });
    let task_ref = |extra: Value| {
        let mut props = json!({
            "path": path.clone(),
            "line": { "type": "integer", "description": "The task's line number, from list_tasks." },
            "text": { "type": "string", "description": "The task's current text, from list_tasks, to check it hasn't changed." },
        });
        if let (Some(p), Some(e)) = (props.as_object_mut(), extra.as_object()) {
            p.extend(e.clone());
        }
        props
    };
    json!([
        { "name": "search_notes", "description": "Search the vault's notes by words. Returns paths, titles and snippets.",
          "inputSchema": { "type": "object", "properties": { "query": { "type": "string" } }, "required": ["query"] } },
        { "name": "list_notes", "description": "List notes, most recently changed first, optionally in one folder.",
          "inputSchema": { "type": "object", "properties": { "folder": { "type": "string", "description": "A folder path, like \"Projects\"." } } } },
        { "name": "read_note", "description": "Read a note's Markdown.",
          "inputSchema": { "type": "object", "properties": { "path": path }, "required": ["path"] } },
        { "name": "write_note", "description": "Replace an existing note's whole Markdown. Read it first and keep what should stay.",
          "inputSchema": { "type": "object", "properties": { "path": path, "content": { "type": "string" } }, "required": ["path", "content"] } },
        { "name": "append_to_note", "description": "Add Markdown to the end of a note.",
          "inputSchema": { "type": "object", "properties": { "path": path, "text": { "type": "string" } }, "required": ["path", "text"] } },
        { "name": "create_note", "description": "Create a new note. Returns its path; a taken title gets a number.",
          "inputSchema": { "type": "object", "properties": {
              "title": { "type": "string" },
              "folder": { "type": "string", "description": "Folder path; empty for the vault's top level." },
              "body": { "type": "string", "description": "Markdown." } }, "required": ["title"] } },
        { "name": "daily_note", "description": "Today's note (or another day's), created from the vault's daily note settings if missing. Returns its path and Markdown.",
          "inputSchema": { "type": "object", "properties": { "date": { "type": "string", "description": "YYYY-MM-DD; today when left out." } } } },
        { "name": "list_tasks", "description": "List open tasks across the vault (with done ones on request). A query keeps tasks whose words, notes or note match every word; #tag matches tags.",
          "inputSchema": { "type": "object", "properties": {
              "query": { "type": "string" },
              "include_done": { "type": "boolean" } } } },
        { "name": "add_task", "description": "Add a task (one line, Obsidian Tasks format) to the Tasks section of today's note, or of another note.",
          "inputSchema": { "type": "object", "properties": {
              "text": { "type": "string", "description": "Like \"Call Amina #home ⏫ 📅 2026-11-05\"." },
              "path": { "type": "string", "description": "A note's path; today's note when left out." } }, "required": ["text"] } },
        { "name": "toggle_task", "description": "Tick or untick a task.",
          "inputSchema": { "type": "object", "properties": task_ref(json!({})), "required": ["path", "line", "text"] } },
        { "name": "edit_task", "description": "Change a task's text (name, tags, 📌, priority, 📅 due date) and, if given, the notes under it.",
          "inputSchema": { "type": "object", "properties": task_ref(json!({
              "new_text": { "type": "string" },
              "details": { "type": "string", "description": "The notes under the task, one line each; left out keeps them." } })),
            "required": ["path", "line", "text", "new_text"] } },
    ])
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::outside::read_changes;
    use crate::state::VaultConfig;

    fn server(tag: &str) -> (Server, PathBuf, PathBuf) {
        let data = std::env::temp_dir().join(format!("wandika-mcp-{tag}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&data);
        let folder = data.join("notes");
        std::fs::create_dir_all(folder.join("Projects")).unwrap();
        std::fs::write(folder.join("Projects/Launch.md"), "# Launch\n\n- [ ] Ship it #work 📅 2026-11-05\n  with notes\n- [x] Done thing\n").unwrap();
        std::fs::write(folder.join("Ideas.md"), "# Ideas\n\nA garden in Jinja.\n").unwrap();
        let app = App::new(data.clone());
        app.update_settings(|s| s.vault = Some(VaultConfig { id: "local/test".into(), name: "test".into(), folder: Some(folder.clone()), remote: None })).unwrap();
        (Server::new(app), data, folder)
    }

    fn call(s: &Server, id: i64, method: &str, params: Value) -> Value {
        let line = json!({ "jsonrpc": "2.0", "id": id, "method": method, "params": params }).to_string();
        serde_json::from_str(&s.handle(&line).unwrap()).unwrap()
    }

    fn tool(s: &Server, name: &str, args: Value) -> (String, bool) {
        let r = call(s, 9, "tools/call", json!({ "name": name, "arguments": args }));
        (r["result"]["content"][0]["text"].as_str().unwrap().to_string(), r["result"]["isError"] == true)
    }

    #[test]
    fn it_speaks_mcp_and_lists_its_tools() {
        let (s, data, _) = server("hello");
        let r = call(&s, 1, "initialize", json!({ "protocolVersion": "2025-03-26", "capabilities": {}, "clientInfo": { "name": "claude-code" } }));
        assert_eq!(r["result"]["protocolVersion"], "2025-03-26", "answers in the client's version");
        assert_eq!(r["result"]["serverInfo"]["name"], "wandika");
        assert!(r["result"]["capabilities"]["tools"].is_object());
        assert!(s.handle(r#"{"jsonrpc":"2.0","method":"notifications/initialized"}"#).is_none(), "notifications get no reply");
        assert_eq!(call(&s, 2, "ping", json!({}))["result"], json!({}));
        let names: Vec<String> = call(&s, 3, "tools/list", json!({}))["result"]["tools"].as_array().unwrap().iter().map(|t| t["name"].as_str().unwrap().to_string()).collect();
        assert_eq!(names, ["search_notes", "list_notes", "read_note", "write_note", "append_to_note", "create_note", "daily_note", "list_tasks", "add_task", "toggle_task", "edit_task"]);
        assert_eq!(call(&s, 4, "resources/list", json!({}))["error"]["code"], -32601);
        let bad: Value = serde_json::from_str(&s.handle("{nope").unwrap()).unwrap();
        assert_eq!(bad["error"]["code"], -32700);
        let _ = std::fs::remove_dir_all(&data);
    }

    #[test]
    fn notes_can_be_searched_listed_read_written_appended_and_created() {
        let (s, data, folder) = server("notes");
        let (found, _) = tool(&s, "search_notes", json!({ "query": "garden" }));
        assert!(found.contains("Ideas.md"), "{found}");
        let (list, _) = tool(&s, "list_notes", json!({ "folder": "Projects" }));
        assert!(list.contains("Projects/Launch.md") && !list.contains("Ideas.md"));
        assert_eq!(tool(&s, "read_note", json!({ "path": "Ideas.md" })).0, "# Ideas\n\nA garden in Jinja.\n");
        tool(&s, "write_note", json!({ "path": "Ideas.md", "content": "# Ideas\n\nTwo gardens.\n" }));
        assert_eq!(std::fs::read_to_string(folder.join("Ideas.md")).unwrap(), "# Ideas\n\nTwo gardens.\n");
        tool(&s, "append_to_note", json!({ "path": "Ideas.md", "text": "- a pond" }));
        assert_eq!(std::fs::read_to_string(folder.join("Ideas.md")).unwrap(), "# Ideas\n\nTwo gardens.\n\n- a pond\n");
        let (path, err) = tool(&s, "create_note", json!({ "title": "Trip", "folder": "Projects", "body": "# Trip\n" }));
        assert!(!err);
        assert_eq!(path, "Projects/Trip.md");
        assert!(tool(&s, "search_notes", json!({ "query": "pond" })).0.contains("Ideas.md"), "a new lookup sees the change");
        let _ = std::fs::remove_dir_all(&data);
    }

    #[test]
    fn mistakes_come_back_as_plain_tool_errors() {
        let (s, data, _) = server("errors");
        assert_eq!(tool(&s, "write_note", json!({ "path": "New.md", "content": "x" })), ("There's no note at that path. Use create_note for a new one.".into(), true));
        assert!(tool(&s, "read_note", json!({ "path": "../secrets.txt" })).1, "nothing outside the vault");
        assert_eq!(tool(&s, "read_note", json!({})), ("Give a “path”.".into(), true));
        assert_eq!(tool(&s, "fly", json!({})), ("Wandika has no tool called “fly”.".into(), true));
        assert_eq!(tool(&s, "daily_note", json!({ "date": "soon" })), ("Dates look like 2026-11-03.".into(), true));
        assert_eq!(tool(&s, "toggle_task", json!({ "path": "Projects/Launch.md", "text": "x" })).0, "Give the task's “line”, as list_tasks returns it.");
        let _ = std::fs::remove_dir_all(&data);
    }

    #[test]
    fn tasks_can_be_listed_searched_added_ticked_and_edited() {
        let (s, data, folder) = server("tasks");
        let open: Vec<Value> = serde_json::from_str(&tool(&s, "list_tasks", json!({})).0).unwrap();
        assert_eq!(open.len(), 1, "done tasks only on request");
        assert_eq!((open[0]["line"].as_u64(), open[0]["details"].as_str()), (Some(2), Some("with notes")));
        let all: Vec<Value> = serde_json::from_str(&tool(&s, "list_tasks", json!({ "include_done": true })).0).unwrap();
        assert_eq!(all.len(), 2);
        assert_eq!(serde_json::from_str::<Vec<Value>>(&tool(&s, "list_tasks", json!({ "query": "#work" })).0).unwrap().len(), 1);
        assert_eq!(serde_json::from_str::<Vec<Value>>(&tool(&s, "list_tasks", json!({ "query": "#home" })).0).unwrap().len(), 0);

        let (added, _) = tool(&s, "add_task", json!({ "text": "Call Amina #home" }));
        let daily = added.trim_start_matches("Added to ").trim_end_matches('.').to_string();
        assert!(std::fs::read_to_string(folder.join(&daily)).unwrap().contains("## Tasks\n\n- [ ] Call Amina #home"));
        tool(&s, "add_task", json!({ "text": "Plan the demo", "path": "Ideas.md" }));
        assert!(std::fs::read_to_string(folder.join("Ideas.md")).unwrap().ends_with("## Tasks\n\n- [ ] Plan the demo\n"));

        assert_eq!(tool(&s, "toggle_task", json!({ "path": "Projects/Launch.md", "line": 2, "text": "Ship it #work 📅 2026-11-05" })).0, "Ticked.");
        let text = std::fs::read_to_string(folder.join("Projects/Launch.md")).unwrap();
        assert!(text.contains("- [x] Ship it #work 📅 2026-11-05 ✅"));
        let current = text.lines().nth(2).unwrap().trim_start_matches("- [x] ").to_string();
        tool(&s, "edit_task", json!({ "path": "Projects/Launch.md", "line": 2, "text": current, "new_text": "Ship it #work 📌" }));
        let text = std::fs::read_to_string(folder.join("Projects/Launch.md")).unwrap();
        assert!(text.contains("- [x] Ship it #work 📌\n  with notes\n"), "notes kept when left out: {text}");
        let _ = std::fs::remove_dir_all(&data);
    }

    #[test]
    fn every_change_is_recorded_for_a_running_app() {
        let (s, data, _) = server("changes");
        tool(&s, "append_to_note", json!({ "path": "Ideas.md", "text": "more" }));
        tool(&s, "create_note", json!({ "title": "New" }));
        let changes = read_changes(&changes_file(&s.app).unwrap());
        assert_eq!(changes.iter().map(|c| c.path.as_str()).collect::<Vec<_>>(), ["Ideas.md", "New.md"]);
        tool(&s, "read_note", json!({ "path": "Ideas.md" }));
        assert_eq!(read_changes(&changes_file(&s.app).unwrap()).len(), 2, "reading changes nothing");
        let _ = std::fs::remove_dir_all(&data);
    }

    #[test]
    fn encrypted_notes_stay_locked() {
        let (s, data, folder) = server("locked");
        std::fs::create_dir_all(folder.join(".wandika")).unwrap();
        std::fs::write(folder.join(".wandika/encryption.json"), r#"{"recipient":"age1x","wrapped":"","folders":[]}"#).unwrap();
        std::fs::write(folder.join("Private.md.age"), "-----BEGIN AGE ENCRYPTED FILE-----\nx\n-----END AGE ENCRYPTED FILE-----\n").unwrap();
        assert!(tool(&s, "read_note", json!({ "path": "Private.md.age" })).1);
        let _ = std::fs::remove_dir_all(&data);
    }

    #[test]
    fn a_vault_must_be_open() {
        let data = std::env::temp_dir().join(format!("wandika-mcp-none-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&data);
        let s = Server::new(App::new(data.clone()));
        assert_eq!(tool(&s, "list_notes", json!({})), ("Open or create a vault first.".into(), true));
        let _ = std::fs::remove_dir_all(&data);
    }

    #[test]
    fn task_search_matches_words_and_tags() {
        let t = VaultTask { path: "Life/Errands.md".into(), title: "Errands".into(), line: 0, text: "Call Amina #home/rent, today".into(), done: false, due: None, details: "bring the lease".into() };
        for q in ["", "amina", "AMINA lease", "errands", "#home", "#home/rent", "life/"] {
            assert!(task_matches(&t, q), "{q}");
        }
        for q in ["bob", "#hom", "#rent", "#work"] {
            assert!(!task_matches(&t, q), "{q}");
        }
    }
}
