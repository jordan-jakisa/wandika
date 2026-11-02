//! The local working copy: plain files on disk, Obsidian-compatible, plus an in-memory index for
//! search, links, backlinks and tasks.

use crate::crypto::{self, Crypto};
use crate::error::{msg, Result};
use chrono::{Local, NaiveDate, NaiveDateTime};
use regex::Regex;
use serde::Serialize;
use std::collections::HashMap;
use std::path::{Component, Path, PathBuf};
use std::sync::LazyLock;
use std::time::{Duration, Instant, SystemTime};
use walkdir::WalkDir;

pub const TMP_SUFFIX: &str = ".wandika-tmp";

static WIKILINK: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"\[\[([^\]\|#\n]+)(#[^\]\|\n]*)?(\|[^\]\n]*)?\]\]").unwrap());
static TAG: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"(?:^|\s)#([A-Za-z][\w/-]*)").unwrap());
static TASK: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"^(\s*[-*+] \[)([ xX])(\] )(.*)$").unwrap());
static DUE: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"📅\s?(\d{4}-\d{2}-\d{2})").unwrap());

#[derive(Serialize, Clone)]
pub struct Entry {
    pub path: String,
    pub name: String,
    pub kind: &'static str,
    pub encrypted: bool,
    pub modified: i64,
}

#[derive(Serialize, Clone)]
pub struct NoteMeta {
    pub path: String,
    pub title: String,
    pub links: Vec<String>,
    pub tags: Vec<String>,
    pub encrypted: bool,
    pub locked: bool,
    /// An Obsidian Kanban board (`kanban-plugin:` in the frontmatter).
    pub board: bool,
    pub modified: i64,
}

#[derive(Serialize, Clone)]
pub struct SearchHit {
    pub path: String,
    pub title: String,
    pub snippet: String,
    pub encrypted: bool,
}

#[derive(Serialize, Clone)]
pub struct VaultTask {
    pub path: String,
    pub title: String,
    pub line: usize,
    pub text: String,
    pub done: bool,
    pub due: Option<String>,
}

/// Rejects anything that could leave the vault folder.
pub fn safe(root: &Path, rel: &str) -> Result<PathBuf> {
    let p = Path::new(rel);
    if rel.is_empty() || p.is_absolute() || p.components().any(|c| !matches!(c, Component::Normal(_)))
    {
        return Err(msg("That path is outside the vault."));
    }
    Ok(root.join(p))
}

fn rel_of(root: &Path, p: &Path) -> Option<String> {
    let rel = p.strip_prefix(root).ok()?;
    Some(rel.components().filter_map(|c| c.as_os_str().to_str()).collect::<Vec<_>>().join("/"))
}

fn hidden(rel: &str) -> bool {
    rel.split('/').any(|part| part.starts_with('.')) || rel.ends_with(TMP_SUFFIX)
}

/// Every entry under `root`, without descending into hidden folders (.git, .obsidian, .trash,
/// plugin caches): nothing in them is shown or indexed.
fn walk_visible(root: &Path) -> impl Iterator<Item = walkdir::DirEntry> {
    WalkDir::new(root)
        .follow_links(false)
        .into_iter()
        .filter_entry(|e| e.depth() == 0 || !e.file_name().to_string_lossy().starts_with('.'))
        .flatten()
}

pub fn is_note(rel: &str) -> bool {
    rel.ends_with(".md") || rel.ends_with(".md.age")
}

pub fn title_of(rel: &str) -> String {
    let name = rel.rsplit('/').next().unwrap_or(rel);
    name.trim_end_matches(".age").trim_end_matches(".md").to_string()
}

fn mtime_ms(t: SystemTime) -> i64 {
    t.duration_since(SystemTime::UNIX_EPOCH).map(|d| d.as_millis() as i64).unwrap_or(0)
}

pub fn write_atomic(path: &Path, bytes: &[u8]) -> Result<()> {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)?;
    }
    let tmp = PathBuf::from(format!("{}{TMP_SUFFIX}", path.display()));
    std::fs::write(&tmp, bytes)?;
    std::fs::rename(&tmp, path)?;
    Ok(())
}

pub fn tree(root: &Path) -> Result<Vec<Entry>> {
    let mut out = Vec::new();
    for e in walk_visible(root).filter(|e| e.depth() > 0) {
        let Some(rel) = rel_of(root, e.path()) else { continue };
        if hidden(&rel) {
            continue;
        }
        let ft = e.file_type();
        if !(ft.is_dir() || ft.is_file()) {
            continue;
        }
        let modified = e.metadata().ok().and_then(|m| m.modified().ok()).map(mtime_ms).unwrap_or(0);
        out.push(Entry {
            name: if ft.is_dir() { rel.rsplit('/').next().unwrap_or(&rel).to_string() } else { title_of(&rel) },
            kind: if ft.is_dir() { "folder" } else if is_note(&rel) { "note" } else { "file" },
            encrypted: crypto::is_encrypted(&rel),
            path: rel,
            modified,
        });
    }
    out.sort_by_key(|e| e.path.to_lowercase());
    Ok(out)
}

pub fn read_note(root: &Path, rel: &str, crypto: &Crypto) -> Result<String> {
    let bytes = std::fs::read(safe(root, rel)?)?;
    let bytes = if crypto::is_encrypted(rel) { crypto.decrypt(&bytes)? } else { bytes };
    String::from_utf8(bytes).map_err(|_| msg("This file isn't text."))
}

pub fn write_note(root: &Path, rel: &str, content: &str, crypto: &Crypto) -> Result<()> {
    let path = safe(root, rel)?;
    if crypto::is_encrypted(rel) {
        write_atomic(&path, &crypto.encrypt(content.as_bytes())?)
    } else {
        write_atomic(&path, content.as_bytes())
    }
}

fn clean_name(name: &str) -> Result<String> {
    let cleaned: String = name
        .trim()
        .chars()
        .map(|c| if matches!(c, '/' | '\\' | ':' | '*' | '?' | '"' | '<' | '>' | '|') { '-' } else { c })
        .collect();
    let cleaned = cleaned.trim_start_matches('.').trim().to_string();
    if cleaned.is_empty() {
        return Err(msg("Give the note a name."));
    }
    Ok(cleaned)
}

fn join(folder: &str, name: &str) -> String {
    let folder = folder.trim_matches('/');
    if folder.is_empty() { name.to_string() } else { format!("{folder}/{name}") }
}

/// Obsidian's "Default location for new notes": the vault root, the open note's folder, or a set
/// folder (`.obsidian/app.json` → `newFileLocation`, `newFileFolderPath`).
pub fn new_note_folder(root: &Path, current: Option<&str>) -> String {
    let app: serde_json::Value = std::fs::read(root.join(".obsidian/app.json"))
        .ok()
        .and_then(|b| serde_json::from_slice(&b).ok())
        .unwrap_or_default();
    let folder_of = |p: &str| p.rsplit_once('/').map_or(String::new(), |(f, _)| f.to_string());
    match app.get("newFileLocation").and_then(|v| v.as_str()) {
        Some("current") => current.map(folder_of).unwrap_or_default(),
        Some("folder") => {
            let f = app.get("newFileFolderPath").and_then(|v| v.as_str()).unwrap_or("").trim_matches('/');
            if safe(root, f).is_ok() { f.to_string() } else { String::new() }
        }
        _ => String::new(),
    }
}

/// Creates a note with a unique name. Notes in encrypted folders are created encrypted.
pub fn create_note(root: &Path, folder: &str, title: &str, body: &str, crypto: &Crypto) -> Result<String> {
    let base = clean_name(title)?;
    let ext = if crypto.folder_is_encrypted(folder) { ".md.age" } else { ".md" };
    let mut n = 1;
    let rel = loop {
        let name = if n == 1 { format!("{base}{ext}") } else { format!("{base} {n}{ext}") };
        let rel = join(folder, &name);
        if !safe(root, &rel)?.exists() {
            break rel;
        }
        n += 1;
    };
    write_note(root, &rel, body, crypto)?;
    Ok(rel)
}

pub fn create_folder(root: &Path, rel: &str) -> Result<()> {
    std::fs::create_dir_all(safe(root, rel)?)?;
    Ok(())
}

/// Renames a note, file or folder in place and rewrites `[[links]]` and `![[embeds]]` to it.
pub fn rename(root: &Path, from: &str, new_name: &str, crypto: &Crypto, index: &mut Index) -> Result<String> {
    let src = safe(root, from)?;
    let parent = from.rsplit_once('/').map(|(p, _)| p).unwrap_or("");
    let name = clean_name(new_name)?;
    let is_dir = src.is_dir();
    let suffix = if is_dir {
        String::new()
    } else if from.ends_with(".md.age") {
        ".md.age".into()
    } else if from.ends_with(".md") {
        ".md".into()
    } else {
        // Other files keep their type: "photo.png" renamed to "beach" stays a PNG.
        let file = from.rsplit('/').next().unwrap_or(from);
        let base = file.trim_end_matches(".age");
        let ext = base.rsplit_once('.').map_or(String::new(), |(_, e)| format!(".{e}"));
        let age = if file.ends_with(".age") { ".age" } else { "" };
        let typed = !ext.is_empty() && name.to_lowercase().ends_with(&ext.to_lowercase());
        format!("{}{age}", if typed { "" } else { ext.as_str() })
    };
    let to = join(parent, &format!("{name}{suffix}"));
    if to == from {
        return Ok(to);
    }
    let dst = safe(root, &to)?;
    if dst.exists() && to.to_lowercase() != from.to_lowercase() {
        return Err(msg(format!("“{name}” already exists here.")));
    }
    std::fs::rename(&src, &dst)?;
    if is_dir {
        move_encrypted_folders(root, crypto, from, Some(&to))?;
    }
    if !is_dir {
        let (old, new) = (title_of(from), title_of(&to));
        index.refresh(root, crypto);
        for note in index.notes_linking_to(&old) {
            let Ok(text) = read_note(root, &note, crypto) else { continue };
            let updated = WIKILINK.replace_all(&text, |c: &regex::Captures| {
                // `[[Plan]]` and `[[Projects/Plan]]` both point at Plan; keep the folder as written.
                let target = c[1].trim();
                let (folder, last) = target.rsplit_once('/').map_or(("", target), |(f, l)| (f, l));
                if last.eq_ignore_ascii_case(&old) {
                    format!(
                        "[[{}{new}{}{}]]",
                        if folder.is_empty() { String::new() } else { format!("{folder}/") },
                        c.get(2).map_or("", |m| m.as_str()),
                        c.get(3).map_or("", |m| m.as_str())
                    )
                } else {
                    c[0].to_string()
                }
            });
            if updated != text {
                write_note(root, &note, &updated, crypto)?;
            }
        }
    }
    Ok(to)
}

/// Keeps the list of encrypted folders in step when a folder is renamed (`Some`) or trashed (`None`).
fn move_encrypted_folders(root: &Path, crypto: &Crypto, from: &str, to: Option<&str>) -> Result<()> {
    let Some(mut cfg) = crypto.config.clone() else { return Ok(()) };
    let before = cfg.folders.clone();
    cfg.folders = cfg
        .folders
        .into_iter()
        .filter_map(|f| {
            let rest = if f == from { Some("") } else { f.strip_prefix(&format!("{from}/")) };
            match (rest, to) {
                (None, _) => Some(f),
                (Some(_), None) => None,
                (Some(""), Some(to)) => Some(to.to_string()),
                (Some(r), Some(to)) => Some(format!("{to}/{r}")),
            }
        })
        .collect();
    if cfg.folders != before {
        crypto::save_config(root, &cfg)?;
    }
    Ok(())
}

/// Moves to `.trash/` like Obsidian, so a deleted note can be recovered from the repo.
pub fn trash(root: &Path, rel: &str, crypto: &Crypto) -> Result<()> {
    let src = safe(root, rel)?;
    if src.is_dir() {
        move_encrypted_folders(root, crypto, rel, None)?;
    }
    let dst = root.join(".trash").join(rel);
    if let Some(p) = dst.parent() {
        std::fs::create_dir_all(p)?;
    }
    if dst.exists() {
        if dst.is_dir() { std::fs::remove_dir_all(&dst)?; } else { std::fs::remove_file(&dst)?; }
    }
    std::fs::rename(src, dst)?;
    Ok(())
}

/// Encrypts or decrypts one note, or every note in a folder (and marks the folder for new notes).
pub fn set_encrypted(root: &Path, rel: &str, encrypt: bool, crypto: &mut Crypto) -> Result<String> {
    if encrypt && !crypto.unlocked() {
        return Err(msg("Set up or unlock encryption first."));
    }
    if !encrypt && !crypto.unlocked() {
        return Err(msg("Unlock encrypted notes first."));
    }
    let path = safe(root, rel)?;
    let convert = |rel: &str| -> Result<String> {
        let is_enc = crypto::is_encrypted(rel);
        if !is_note(rel) || is_enc == encrypt {
            return Ok(rel.to_string());
        }
        let text = read_note(root, rel, crypto)?;
        let to = if encrypt { format!("{rel}{}", crypto::EXT) } else { rel.trim_end_matches(crypto::EXT).to_string() };
        write_note(root, &to, &text, crypto)?;
        std::fs::remove_file(safe(root, rel)?)?;
        Ok(to)
    };
    if path.is_dir() {
        let notes: Vec<String> = WalkDir::new(&path)
            .into_iter()
            .flatten()
            .filter(|e| e.file_type().is_file())
            .filter_map(|e| rel_of(root, e.path()))
            .filter(|r| !hidden(r))
            .collect();
        for n in notes {
            convert(&n)?;
        }
        if let Some(cfg) = crypto.config.as_mut() {
            let folder = rel.trim_matches('/').to_string();
            cfg.folders.retain(|f| f != &folder);
            if encrypt {
                cfg.folders.push(folder);
            }
            crypto::save_config(root, cfg)?;
        }
        Ok(rel.to_string())
    } else {
        convert(rel)
    }
}

/// What the index keeps per note. The note text itself is not kept: only a lowercase copy for
/// search, and the tasks. Snippets are read from disk for the few results shown.
struct Cached {
    mtime: SystemTime,
    meta: NoteMeta,
    lower: Box<str>,
    title_lower: Box<str>,
    path_lower: Box<str>,
    tasks: Vec<VaultTask>,
}

/// Folder scans are skipped for this long unless Wandika itself changed a file.
const RESCAN_AFTER: Duration = Duration::from_secs(20);

#[derive(Default)]
pub struct Index {
    root: PathBuf,
    notes: HashMap<String, Cached>,
    unlocked: bool,
    checked: Option<Instant>,
    stale: bool,
}

fn parse(rel: &str, text: &str, modified: i64, encrypted: bool, locked: bool) -> NoteMeta {
    let body = strip_code(text);
    let mut links: Vec<String> = WIKILINK.captures_iter(&body).map(|c| c[1].trim().to_string()).collect();
    links.dedup();
    let mut tags: Vec<String> = TAG.captures_iter(&body).map(|c| c[1].to_string()).collect();
    tags.sort();
    tags.dedup();
    let board = is_board(text);
    NoteMeta { path: rel.to_string(), title: title_of(rel), links, tags, encrypted, locked, board, modified }
}

pub fn is_board(text: &str) -> bool {
    let Some(rest) = text.strip_prefix("---") else { return false };
    let end = rest.find("\n---").unwrap_or(rest.len());
    rest[..end].lines().any(|l| l.trim_start().starts_with("kanban-plugin:"))
}

/// Removes fenced code so `#include` or `[[x]]` inside code isn't read as a tag or link.
fn strip_code(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    let mut fenced = false;
    for line in text.lines() {
        if line.trim_start().starts_with("```") {
            fenced = !fenced;
            continue;
        }
        if !fenced {
            out.push_str(line);
            out.push('\n');
        }
    }
    out
}

fn snippet(text: &str, needle: &str) -> String {
    let lower = text.to_lowercase();
    let Some(pos) = lower.find(needle) else {
        return text.chars().take(140).collect::<String>().replace('\n', " ");
    };
    // Lowercasing can change byte lengths in some scripts; then start from the top.
    let mut s = if lower.len() == text.len() { pos.saturating_sub(60) } else { 0 };
    while s > 0 && !text.is_char_boundary(s) {
        s -= 1;
    }
    let piece: String = text[s..].chars().take(160).collect();
    let piece = piece.replace('\n', " ");
    if s > 0 { format!("…{}", piece.trim_start()) } else { piece }
}

fn tasks_in(rel: &str, title: &str, text: &str) -> Vec<VaultTask> {
    let mut out = Vec::new();
    let mut fenced = false;
    for (i, line) in text.lines().enumerate() {
        if line.trim_start().starts_with("```") {
            fenced = !fenced;
        }
        if fenced {
            continue;
        }
        if let Some(m) = TASK.captures(line) {
            let text = m[4].to_string();
            out.push(VaultTask {
                path: rel.to_string(),
                title: title.to_string(),
                line: i,
                due: DUE.captures(&text).map(|d| d[1].to_string()),
                done: &m[2] != " ",
                text,
            });
        }
    }
    out
}

impl Index {
    /// Called after Wandika writes, renames or syncs files.
    pub fn mark_stale(&mut self) {
        self.stale = true;
    }

    /// Rescans only when something changed, or now and then for edits made outside the app.
    pub fn ensure_fresh(&mut self, root: &Path, crypto: &Crypto) {
        let due = self.stale
            || self.root != root
            || self.unlocked != crypto.unlocked()
            || self.checked.is_none_or(|t| t.elapsed() > RESCAN_AFTER);
        if due {
            self.refresh(root, crypto);
        }
    }

    pub fn refresh(&mut self, root: &Path, crypto: &Crypto) {
        if self.root != root || self.unlocked != crypto.unlocked() {
            self.notes.clear();
            self.root = root.to_path_buf();
            self.unlocked = crypto.unlocked();
        }
        let mut seen = std::collections::HashSet::new();
        for e in walk_visible(root) {
            if !e.file_type().is_file() {
                continue;
            }
            let Some(rel) = rel_of(root, e.path()) else { continue };
            if hidden(&rel) || !is_note(&rel) {
                continue;
            }
            let Some(mtime) = e.metadata().ok().and_then(|m| m.modified().ok()) else { continue };
            seen.insert(rel.clone());
            if self.notes.get(&rel).is_some_and(|c| c.mtime == mtime) {
                continue;
            }
            let encrypted = crypto::is_encrypted(&rel);
            let (text, locked) = match read_note(root, &rel, crypto) {
                Ok(t) => (t, false),
                Err(_) => (String::new(), encrypted),
            };
            let meta = parse(&rel, &text, mtime_ms(mtime), encrypted, locked);
            let cached = Cached {
                mtime,
                lower: text.to_lowercase().into_boxed_str(),
                title_lower: meta.title.to_lowercase().into_boxed_str(),
                path_lower: rel.to_lowercase().into_boxed_str(),
                tasks: tasks_in(&rel, &meta.title, &text),
                meta,
            };
            self.notes.insert(rel, cached);
        }
        self.notes.retain(|k, _| seen.contains(k));
        self.notes.shrink_to_fit();
        self.checked = Some(Instant::now());
        self.stale = false;
    }

    pub fn titles(&self) -> Vec<NoteMeta> {
        let mut v: Vec<NoteMeta> = self.notes.values().map(|c| c.meta.clone()).collect();
        v.sort_by_key(|n| std::cmp::Reverse(n.modified));
        v
    }

    pub fn resolve(&self, target: &str) -> Option<String> {
        let target = target.trim().trim_end_matches(".md");
        let t = target.to_lowercase();
        let suffix = format!("/{t}");
        // A link with a folder (`Projects/Plan`) matches that path; a bare name matches any folder.
        let mut matches: Vec<&String> = self
            .notes
            .iter()
            .filter(|(_, c)| {
                let stem = c.path_lower.trim_end_matches(".age").trim_end_matches(".md");
                stem == t || stem.ends_with(&suffix)
            })
            .map(|(k, _)| k)
            .collect();
        matches.sort_by_key(|r| r.len());
        matches.first().map(|s| s.to_string())
    }

    pub fn notes_linking_to(&self, title: &str) -> Vec<String> {
        self.notes
            .values()
            .filter(|c| c.meta.links.iter().any(|l| l.rsplit('/').next().unwrap_or(l).eq_ignore_ascii_case(title)))
            .map(|c| c.meta.path.clone())
            .collect()
    }

    fn hit(&self, c: &Cached, needle: &str, crypto: &Crypto) -> SearchHit {
        let text = read_note(&self.root, &c.meta.path, crypto).unwrap_or_default();
        SearchHit {
            path: c.meta.path.clone(),
            title: c.meta.title.clone(),
            snippet: snippet(&text, needle),
            encrypted: c.meta.encrypted,
        }
    }

    pub fn backlinks(&self, rel: &str, crypto: &Crypto) -> Vec<SearchHit> {
        let title = title_of(rel);
        let needle = format!("[[{}", title.to_lowercase());
        let mut out: Vec<SearchHit> = self
            .notes_linking_to(&title)
            .into_iter()
            .filter(|p| p != rel)
            .filter_map(|p| self.notes.get(&p))
            .map(|c| self.hit(c, &needle, crypto))
            .collect();
        out.sort_by_key(|h| h.title.to_lowercase());
        out
    }

    pub fn search(&self, query: &str, crypto: &Crypto) -> Vec<SearchHit> {
        let q = query.trim().to_lowercase();
        if q.is_empty() {
            return Vec::new();
        }
        let words: Vec<&str> = q.split_whitespace().collect();
        let mut scored: Vec<(i64, &Cached)> = self
            .notes
            .values()
            .filter_map(|c| {
                let (title, path, body) = (&*c.title_lower, &*c.path_lower, &*c.lower);
                if !words.iter().all(|w| title.contains(w) || path.contains(w) || body.contains(w)) {
                    return None;
                }
                let mut score = 0i64;
                if title == q {
                    score += 1000;
                }
                if title.starts_with(&q) {
                    score += 300;
                }
                for w in &words {
                    if title.contains(w) {
                        score += 100;
                    }
                    score += body.matches(w).take(20).count() as i64;
                }
                Some((score, c))
            })
            .collect();
        scored.sort_by(|a, b| b.0.cmp(&a.0).then(b.1.meta.modified.cmp(&a.1.meta.modified)));
        scored.into_iter().take(50).map(|(_, c)| self.hit(c, words[0], crypto)).collect()
    }

    pub fn tasks(&self) -> Vec<VaultTask> {
        let mut out: Vec<VaultTask> = self.notes.values().flat_map(|c| c.tasks.iter().cloned()).collect();
        out.sort_by(|a, b| {
            a.due.is_none().cmp(&b.due.is_none()).then(a.due.cmp(&b.due)).then(a.path.cmp(&b.path)).then(a.line.cmp(&b.line))
        });
        out
    }
}

/// Ticks or unticks the checkbox on `line`, after checking the line still holds the same task.
pub fn toggle_task(root: &Path, rel: &str, line: usize, expected: &str, crypto: &Crypto) -> Result<bool> {
    let text = read_note(root, rel, crypto)?;
    let mut lines: Vec<String> = text.split('\n').map(str::to_string).collect();
    let current = lines.get(line).ok_or_else(|| msg("That task moved. Refresh and try again."))?;
    let caps = TASK.captures(current).ok_or_else(|| msg("That task moved. Refresh and try again."))?;
    if caps[4].trim() != expected.trim() {
        return Err(msg("That task changed. Refresh and try again."));
    }
    let done = &caps[2] == " ";
    let mark = if done { "x" } else { " " };
    let mut rest = caps[4].to_string();
    // Obsidian Tasks style completion date.
    let done_re = Regex::new(r"\s*✅ \d{4}-\d{2}-\d{2}").unwrap();
    rest = done_re.replace_all(&rest, "").to_string();
    if done {
        rest = format!("{rest} ✅ {}", Local::now().format("%Y-%m-%d"));
    }
    lines[line] = format!("{}{mark}{}{rest}", &caps[1], &caps[3]);
    write_note(root, rel, &lines.join("\n"), crypto)?;
    Ok(done)
}

/// Today's note, following Obsidian's Daily notes settings when the vault has them.
pub fn daily_note(root: &Path, date: NaiveDate, crypto: &Crypto) -> Result<String> {
    #[derive(serde::Deserialize, Default)]
    struct Daily {
        #[serde(default)]
        folder: String,
        #[serde(default)]
        format: String,
        #[serde(default)]
        template: String,
    }
    let cfg: Daily = std::fs::read(root.join(".obsidian/daily-notes.json"))
        .ok()
        .and_then(|b| serde_json::from_slice(&b).ok())
        .unwrap_or_default();
    let folder = if cfg.folder.trim().is_empty() { "Daily".to_string() } else { cfg.folder.trim_matches('/').to_string() };
    let format = if cfg.format.trim().is_empty() { "YYYY-MM-DD".to_string() } else { cfg.format.clone() };
    let at = date.and_time(Local::now().time());
    let name = moment_format(&format, at);
    for ext in [".md", ".md.age"] {
        let rel = join(&folder, &format!("{name}{ext}"));
        if safe(root, &rel)?.exists() {
            return Ok(rel);
        }
    }
    let body = if cfg.template.trim().is_empty() {
        format!("# {}\n\n## Agenda\n\n## Notes\n\n## Tasks\n\n", date.format("%A %-d %B %Y"))
    } else {
        let t = cfg.template.trim().trim_end_matches(".md");
        fill_template(&read_note(root, &format!("{t}.md"), crypto).unwrap_or_default(), &name, at)
    };
    create_note(root, &folder, &name, &body, crypto)
}

/// The subset of moment.js tokens Obsidian users put in daily-note and template formats.
fn moment_format(fmt: &str, at: NaiveDateTime) -> String {
    let tokens = [
        ("YYYY", "%Y"), ("YY", "%y"), ("MMMM", "%B"), ("MMM", "%b"), ("MM", "%m"),
        ("dddd", "%A"), ("ddd", "%a"), ("DD", "%d"), ("Do", "%-d"), ("D", "%-d"), ("M", "%-m"),
        ("HH", "%H"), ("H", "%-H"), ("hh", "%I"), ("h", "%-I"), ("mm", "%M"), ("ss", "%S"),
        ("A", "%p"), ("a", "%P"),
    ];
    let mut out = String::new();
    let mut rest = fmt;
    'outer: while !rest.is_empty() {
        for (tok, chrono_fmt) in tokens {
            if let Some(r) = rest.strip_prefix(tok) {
                out.push_str(&at.format(chrono_fmt).to_string());
                rest = r;
                continue 'outer;
            }
        }
        let c = rest.chars().next().unwrap();
        out.push(c);
        rest = &rest[c.len_utf8()..];
    }
    out
}

static TEMPLATE_VAR: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"\{\{\s*(date|time|title)(?::([^}]*))?\s*\}\}").unwrap());

/// Obsidian's template variables: `{{title}}`, `{{date}}`, `{{time}}`, `{{date:YYYY-MM-DD}}`.
pub fn fill_template(text: &str, title: &str, at: NaiveDateTime) -> String {
    TEMPLATE_VAR
        .replace_all(text, |c: &regex::Captures| match (&c[1], c.get(2).map(|m| m.as_str().trim())) {
            ("title", _) => title.to_string(),
            ("date", Some(f)) | ("time", Some(f)) if !f.is_empty() => moment_format(f, at),
            ("date", _) => moment_format("YYYY-MM-DD", at),
            _ => moment_format("HH:mm", at),
        })
        .into_owned()
}

/// The templates folder from `.obsidian/templates.json`, or `Templates` when that folder exists.
fn templates_folder(root: &Path) -> Option<String> {
    let configured = std::fs::read(root.join(".obsidian/templates.json"))
        .ok()
        .and_then(|b| serde_json::from_slice::<serde_json::Value>(&b).ok())
        .and_then(|v| v.get("folder")?.as_str().map(|f| f.trim_matches('/').to_string()))
        .filter(|f| !f.is_empty());
    let folder = configured.unwrap_or_else(|| "Templates".into());
    safe(root, &folder).ok().filter(|p| p.is_dir()).map(|_| folder)
}

/// Notes in the templates folder, sorted by name.
pub fn templates(root: &Path) -> Vec<String> {
    let Some(folder) = templates_folder(root) else { return Vec::new() };
    let mut out: Vec<String> = WalkDir::new(root.join(&folder))
        .into_iter()
        .flatten()
        .filter_map(|e| rel_of(root, e.path()))
        .filter(|rel| is_note(rel) && !hidden(rel))
        .collect();
    out.sort_by_key(|p| title_of(p).to_lowercase());
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rejects_escaping_paths() {
        let root = Path::new("/v");
        assert!(safe(root, "../x").is_err());
        assert!(safe(root, "/etc/passwd").is_err());
        assert!(safe(root, "a/./b").is_ok() || safe(root, "a/./b").is_err());
        assert!(safe(root, "Daily/2026-11-02.md").is_ok());
    }

    #[test]
    fn parses_links_tags_and_titles() {
        let m = parse("Projects/Plan.md", "See [[Wandika|the app]] and [[Daily/2026-11-02#Tasks]] #idea\n```\n#notatag [[nope]]\n```", 0, false, false);
        assert_eq!(m.title, "Plan");
        assert_eq!(m.links, vec!["Wandika", "Daily/2026-11-02"]);
        assert_eq!(m.tags, vec!["idea"]);
        assert_eq!(title_of("Private/Diary.md.age"), "Diary");
        assert!(is_board("---\n\nkanban-plugin: basic\n\n---\n\n## To do\n"));
        assert!(!is_board("# Plan\n\nkanban-plugin: basic\n"));
    }

    #[test]
    fn index_searches_links_and_tasks() {
        let root = std::env::temp_dir().join(format!("wandika-index-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&root);
        std::fs::create_dir_all(root.join("Projects")).unwrap();
        std::fs::write(root.join("Projects/Plan.md"), "Ship the Kampala release.\n- [ ] Call Amina 📅 2026-11-02\n").unwrap();
        std::fs::write(root.join("Daily.md"), "Talked about [[Plan]] today.\n- [x] Done thing\n").unwrap();
        let crypto = Crypto::load(&root, &crate::secrets::Secrets::new(root.clone()), "test/vault");
        let mut index = Index::default();
        index.ensure_fresh(&root, &crypto);

        let hits = index.search("kampala", &crypto);
        assert_eq!(hits.len(), 1);
        assert!(hits[0].snippet.contains("Kampala"), "snippet keeps the original case");
        assert_eq!(index.backlinks("Projects/Plan.md", &crypto)[0].title, "Daily");
        assert_eq!(index.resolve("plan").as_deref(), Some("Projects/Plan.md"));
        let tasks = index.tasks();
        assert_eq!(tasks.len(), 2);
        assert_eq!(tasks[0].due.as_deref(), Some("2026-11-02"));

        // A write through the app marks the index stale, and the next lookup sees it.
        std::fs::write(root.join("New.md"), "kampala again").unwrap();
        index.mark_stale();
        index.ensure_fresh(&root, &crypto);
        assert_eq!(index.search("kampala", &crypto).len(), 2);
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn rename_keeps_file_types_and_updates_links_and_embeds() {
        let root = std::env::temp_dir().join(format!("wandika-rename-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&root);
        std::fs::create_dir_all(root.join("Projects")).unwrap();
        std::fs::create_dir_all(root.join("attachments")).unwrap();
        std::fs::write(root.join("Projects/Plan.md"), "Plan").unwrap();
        std::fs::write(root.join("attachments/pic.png"), b"png").unwrap();
        std::fs::write(root.join("Daily.md"), "See [[Projects/Plan#Goals|the plan]] and ![[pic.png|300]]\n").unwrap();
        let crypto = Crypto::load(&root, &crate::secrets::Secrets::new(root.clone()), "test/rename");
        let mut index = Index::default();

        assert_eq!(rename(&root, "attachments/pic.png", "beach", &crypto, &mut index).unwrap(), "attachments/beach.png");
        assert_eq!(rename(&root, "Projects/Plan.md", "Roadmap", &crypto, &mut index).unwrap(), "Projects/Roadmap.md");
        let daily = std::fs::read_to_string(root.join("Daily.md")).unwrap();
        assert_eq!(daily, "See [[Projects/Roadmap#Goals|the plan]] and ![[beach.png|300]]\n");
        let _ = std::fs::remove_dir_all(&root);
    }

    /// Timings on a real vault, read only: `WANDIKA_BENCH_VAULT=/path cargo test --release bench -- --ignored --nocapture`.
    #[test]
    #[ignore]
    fn bench_real_vault() {
        let Ok(dir) = std::env::var("WANDIKA_BENCH_VAULT") else { return };
        let root = PathBuf::from(dir);
        let crypto = Crypto::load(&root, &crate::secrets::Secrets::new(std::env::temp_dir()), "bench/vault");
        let t = Instant::now();
        let entries = tree(&root).unwrap();
        println!("tree: {} entries in {:?}", entries.len(), t.elapsed());
        let mut index = Index::default();
        let t = Instant::now();
        index.refresh(&root, &crypto);
        println!("index cold: {} notes in {:?}", index.titles().len(), t.elapsed());
        let t = Instant::now();
        index.refresh(&root, &crypto);
        println!("index warm rescan: {:?}", t.elapsed());
        let t = Instant::now();
        let hits = index.search("app", &crypto);
        println!("search 'app': {} hits in {:?}", hits.len(), t.elapsed());
        let t = Instant::now();
        let titles = index.titles();
        println!("titles: {} in {:?}", titles.len(), t.elapsed());
        let t = Instant::now();
        let tasks = index.tasks();
        println!("tasks: {} in {:?}", tasks.len(), t.elapsed());
        let bytes: usize = index.notes.values().map(|c| c.lower.len()).sum();
        println!("index text held: {} KB", bytes / 1024);
    }

    #[test]
    fn new_notes_go_where_obsidian_is_set_to_put_them() {
        let root = std::env::temp_dir().join(format!("wandika-newloc-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&root);
        std::fs::create_dir_all(root.join(".obsidian")).unwrap();
        assert_eq!(new_note_folder(&root, Some("Projects/Plan.md")), "");
        std::fs::write(root.join(".obsidian/app.json"), r#"{"newFileLocation":"current"}"#).unwrap();
        assert_eq!(new_note_folder(&root, Some("Projects/Plan.md")), "Projects");
        std::fs::write(root.join(".obsidian/app.json"), r#"{"newFileLocation":"folder","newFileFolderPath":"00_Inbox"}"#).unwrap();
        assert_eq!(new_note_folder(&root, Some("Projects/Plan.md")), "00_Inbox");
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn formats_daily_names() {
        let d = NaiveDate::from_ymd_opt(2026, 11, 2).unwrap().and_hms_opt(9, 5, 0).unwrap();
        assert_eq!(moment_format("YYYY-MM-DD", d), "2026-11-02");
        assert_eq!(moment_format("dddd, D MMMM YYYY", d), "Monday, 2 November 2026");
        assert_eq!(moment_format("HH:mm", d), "09:05");
    }

    #[test]
    fn fills_obsidian_template_variables() {
        let at = NaiveDate::from_ymd_opt(2026, 11, 3).unwrap().and_hms_opt(14, 30, 0).unwrap();
        let text = "# {{title}}\n{{date}} {{time}} {{date:dddd D MMMM}} {{ time:h:mm a }}";
        assert_eq!(fill_template(text, "Standup", at), "# Standup\n2026-11-03 14:30 Tuesday 3 November 2:30 pm");
    }
}
