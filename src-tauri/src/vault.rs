//! The local working copy: plain files on disk, Obsidian-compatible, plus an in-memory index for
//! search, links, backlinks and tasks.

use crate::crypto::{self, Crypto};
use crate::error::{msg, Result};
use chrono::{Datelike, Local, NaiveDate, NaiveDateTime};
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
    /// The indented lines under the task, without their indent: its notes.
    pub details: String,
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

/// A note or folder name as it is saved: no path or reserved characters, never hidden.
pub fn clean_name(name: &str) -> Result<String> {
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

/// Deletes a note that was created and left without a word or a new name, as Apple Notes does.
/// Anything with text in it, or a name of its own, stays. Returns true when it was removed.
pub fn discard_if_empty(root: &Path, rel: &str, crypto: &Crypto) -> Result<bool> {
    static UNTITLED: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"^Untitled( \d+)?$").unwrap());
    if !is_note(rel) || !UNTITLED.is_match(&title_of(rel)) {
        return Ok(false);
    }
    let path = safe(root, rel)?;
    if !path.is_file() || !read_note(root, rel, crypto)?.trim().is_empty() {
        return Ok(false);
    }
    std::fs::remove_file(path)?;
    Ok(true)
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
    let (old, new) = (title_of(from), title_of(&to));
    // Which note a bare `[[Plan]]` means when two share the name, decided before the move.
    let bare_here = !is_dir && {
        index.refresh(root, crypto);
        index.resolve(&old).is_none_or(|r| r == from)
    };
    let from_stem = from.trim_end_matches(".age").trim_end_matches(".md").to_lowercase();
    std::fs::rename(&src, &dst)?;
    if is_dir {
        move_encrypted_folders(root, crypto, from, Some(&to))?;
    }
    if !is_dir {
        index.refresh(root, crypto);
        for note in index.notes_linking_to(&old) {
            let Ok(text) = read_note(root, &note, crypto) else { continue };
            let updated = WIKILINK.replace_all(&text, |c: &regex::Captures| {
                // `[[Plan]]` and `[[Projects/Plan]]` both point at Plan; keep the folder as written.
                let target = c[1].trim();
                let (folder, last) = target.rsplit_once('/').map_or(("", target), |(f, l)| (f, l));
                // `[[Other/Plan]]` is another note called Plan; only links to this one change.
                let lower = target.to_lowercase();
                let points_here = if folder.is_empty() {
                    bare_here
                } else {
                    from_stem == lower || from_stem.ends_with(&format!("/{lower}"))
                };
                if points_here && last.eq_ignore_ascii_case(&old) {
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

/// Moves something back out of `.trash/` to where it was, unless that place has been taken since.
pub fn restore(root: &Path, rel: &str) -> Result<()> {
    let from = root.join(".trash").join(rel);
    let to = safe(root, rel)?;
    if !from.exists() {
        return Err(msg("It isn't in the trash any more."));
    }
    if to.exists() {
        return Err(msg("Something new has the same name there now, so it stays in the trash."));
    }
    if let Some(p) = to.parent() {
        std::fs::create_dir_all(p)?;
    }
    std::fs::rename(from, to)?;
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
    // Each link once, in the order written.
    let mut seen = std::collections::HashSet::new();
    let links: Vec<String> =
        WIKILINK.captures_iter(&body).map(|c| c[1].trim().to_string()).filter(|l| seen.insert(l.clone())).collect();
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
    let text_lines: Vec<&str> = text.lines().collect();
    for (i, line) in text_lines.iter().enumerate() {
        if line.trim_start().starts_with("```") {
            fenced = !fenced;
        }
        if fenced {
            continue;
        }
        if let Some(m) = TASK.captures(line) {
            let text = m[4].to_string();
            let lines: Vec<&str> = text_lines.get(i + 1..).unwrap_or_default().to_vec();
            out.push(VaultTask {
                path: rel.to_string(),
                title: title.to_string(),
                line: i,
                due: DUE.captures(&text).map(|d| d[1].to_string()),
                done: &m[2] != " ",
                details: detail_block(&lines, indent_of(&m[1])).join("\n"),
                text,
            });
        }
    }
    out
}

fn indent_of(prefix: &str) -> usize {
    prefix.len() - prefix.trim_start().len()
}

/// The lines under a task that belong to it: more indented than the task, up to a blank line or
/// another task (a subtask is a task of its own, not a note on this one). Returned without the indent.
fn detail_block<'a>(lines: &[&'a str], indent: usize) -> Vec<&'a str> {
    let mut out = Vec::new();
    for line in lines {
        let line = line.trim_end_matches('\r');
        let own = line.len() - line.trim_start().len();
        if line.trim().is_empty() || own <= indent || TASK.is_match(line) {
            break;
        }
        out.push(line.trim_start());
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

    /// Every task in the vault, except the blanks in templates and the archived ones.
    pub fn tasks(&self) -> Vec<VaultTask> {
        let templates = templates_folder(&self.root).map(|f| format!("{}/", f.to_lowercase()));
        let mut out: Vec<VaultTask> = self
            .notes
            .values()
            .filter(|c| templates.as_ref().is_none_or(|t| !c.path_lower.starts_with(t.as_str())))
            .filter(|c| !is_archive(&c.path_lower))
            .flat_map(|c| c.tasks.iter().cloned())
            .collect();
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
    // A note written with Windows line endings keeps its `\r` at the end of the line.
    let (rest, cr) = caps[4].strip_suffix('\r').map_or((&caps[4], ""), |r| (r, "\r"));
    let mut rest = rest.to_string();
    // Obsidian Tasks style completion date.
    let done_re = Regex::new(r"\s*✅ \d{4}-\d{2}-\d{2}").unwrap();
    rest = done_re.replace_all(&rest, "").to_string();
    if done {
        rest = format!("{rest} ✅ {}", Local::now().format("%Y-%m-%d"));
    }
    lines[line] = format!("{}{mark}{}{rest}{cr}", &caps[1], &caps[3]);
    write_note(root, rel, &lines.join("\n"), crypto)?;
    Ok(done)
}

/// Rewrites the task on `line`: its text (with the markers the app composed) and the notes under it.
/// The checkbox and the list marker stay as they are.
pub fn edit_task(root: &Path, rel: &str, line: usize, expected: &str, text: &str, details: &str, crypto: &Crypto) -> Result<()> {
    let text = text.trim();
    if text.is_empty() {
        return Err(msg("Give the task a name."));
    }
    if text.contains('\n') {
        return Err(msg("A task is one line. Put the rest in its notes."));
    }
    let note = read_note(root, rel, crypto)?;
    let mut lines: Vec<String> = note.split('\n').map(str::to_string).collect();
    let current = lines.get(line).ok_or_else(|| msg("That task moved. Refresh and try again."))?.clone();
    let caps = TASK.captures(&current).ok_or_else(|| msg("That task moved. Refresh and try again."))?;
    if caps[4].trim() != expected.trim() {
        return Err(msg("That task changed. Refresh and try again."));
    }
    let cr = if current.ends_with('\r') { "\r" } else { "" };
    let indent = indent_of(&caps[1]);
    let below: Vec<&str> = lines[line + 1..].iter().map(String::as_str).collect();
    let old_details = detail_block(&below, indent).len();
    let pad = format!("{}  ", &caps[1][..indent]);
    let new_details: Vec<String> =
        details.lines().map(str::trim_end).filter(|l| !l.trim().is_empty()).map(|l| format!("{pad}{}{cr}", l.trim_start())).collect();
    lines[line] = format!("{}{}{}{text}{cr}", &caps[1], &caps[2], &caps[3]);
    lines.splice(line + 1..line + 1 + old_details, new_details);
    write_note(root, rel, &lines.join("\n"), crypto)
}

/// Where archived tasks go: one note at the vault root, encrypted when the task's note is, so an
/// encrypted task never lands in a plain file.
pub fn archive_note_for(rel: &str) -> &'static str {
    if crypto::is_encrypted(rel) { "Archive.md.age" } else { "Archive.md" }
}

fn is_archive(path_lower: &str) -> bool {
    path_lower == "archive.md" || path_lower == "archive.md.age"
}

/// Cuts the task on `line` and the notes under it out of its note. Returns the lines as they were,
/// so they can be put back.
pub fn take_task(root: &Path, rel: &str, line: usize, expected: &str, crypto: &Crypto) -> Result<Vec<String>> {
    let note = read_note(root, rel, crypto)?;
    let mut lines: Vec<String> = note.split('\n').map(str::to_string).collect();
    let current = lines.get(line).ok_or_else(|| msg("That task moved. Refresh and try again."))?.clone();
    let caps = TASK.captures(&current).ok_or_else(|| msg("That task moved. Refresh and try again."))?;
    if caps[4].trim() != expected.trim() {
        return Err(msg("That task changed. Refresh and try again."));
    }
    let below: Vec<&str> = lines[line + 1..].iter().map(String::as_str).collect();
    let n = 1 + detail_block(&below, indent_of(&caps[1])).len();
    let taken: Vec<String> = lines.drain(line..line + n).collect();
    write_note(root, rel, &lines.join("\n"), crypto)?;
    Ok(taken)
}

/// Puts lines that `take_task` cut back at `line`, or at the end if the note got shorter since.
pub fn put_back(root: &Path, rel: &str, line: usize, taken: &[String], crypto: &Crypto) -> Result<()> {
    if !taken.first().is_some_and(|l| TASK.is_match(l)) {
        return Err(msg("There's no task to put back."));
    }
    let note = read_note(root, rel, crypto)?;
    let mut lines: Vec<String> = note.split('\n').map(str::to_string).collect();
    // A note ending in a newline splits into a last empty line; keep that newline last.
    let end = if lines.last().is_some_and(String::is_empty) { lines.len() - 1 } else { lines.len() };
    let at = line.min(end);
    lines.splice(at..at, taken.iter().cloned());
    write_note(root, rel, &lines.join("\n"), crypto)
}

#[derive(Serialize, Debug)]
pub struct Archived {
    /// The archive note the task went to.
    pub archive: String,
    /// The lines cut from the task's note, for Undo.
    pub taken: Vec<String>,
    /// The text added to the end of the archive note, for Undo.
    pub appended: String,
}

/// Moves the task on `line` and its notes to the end of the archive note, with a line saying where
/// it came from. Archive notes are left out of task lists.
pub fn archive_task(root: &Path, rel: &str, line: usize, expected: &str, crypto: &Crypto) -> Result<Archived> {
    let archive = archive_note_for(rel);
    if is_archive(&rel.to_lowercase()) {
        return Err(msg("That task is already in the archive."));
    }
    // Read the archive before cutting anything, so a locked or unreadable archive changes nothing.
    let mut out = if safe(root, archive)?.is_file() { read_note(root, archive, crypto)? } else { "# Archive\n".to_string() };
    let taken = take_task(root, rel, line, expected, crypto)?;
    let indent = TASK.captures(&taken[0]).map_or(0, |c| indent_of(&c[1]));
    let mut block: Vec<String> = taken.iter().map(|l| l.trim_end_matches('\r').chars().skip(indent).collect()).collect();
    let from = rel.trim_end_matches(crypto::EXT).trim_end_matches(".md");
    block.insert(1, format!("  From [[{from}]], archived {}", Local::now().format("%Y-%m-%d")));
    let appended = format!("{}\n", block.join("\n"));
    if !out.ends_with('\n') {
        out.push('\n');
    }
    out.push_str(&appended);
    if let Err(e) = write_note(root, archive, &out, crypto) {
        let _ = put_back(root, rel, line, &taken, crypto);
        return Err(e);
    }
    Ok(Archived { archive: archive.to_string(), taken, appended })
}

/// Undoes `archive_task`: the task goes back to its note and leaves the archive.
pub fn unarchive_task(root: &Path, archive: &str, appended: &str, rel: &str, line: usize, taken: &[String], crypto: &Crypto) -> Result<()> {
    put_back(root, rel, line, taken, crypto)?;
    let text = read_note(root, archive, crypto)?;
    if let Some(at) = text.rfind(appended) {
        write_note(root, archive, &format!("{}{}", &text[..at], &text[at + appended.len()..]), crypto)?;
    }
    Ok(())
}

/// Adds `- [ ] text` to the end of the Tasks section of the note at `rel`, or a new Tasks section.
pub fn add_task(root: &Path, rel: &str, text: &str, crypto: &Crypto) -> Result<()> {
    let text = text.trim();
    if text.is_empty() || text.contains('\n') {
        return Err(msg("Give the task a name."));
    }
    let note = read_note(root, rel, crypto)?;
    let task = format!("- [ ] {text}");
    let mut lines: Vec<&str> = note.lines().collect();
    let at = match lines.iter().position(|l| l.trim().eq_ignore_ascii_case("## Tasks")) {
        Some(h) => {
            // After the section's last non-blank line, before the next heading.
            let end = lines[h + 1..].iter().position(|l| l.starts_with('#')).map_or(lines.len(), |p| h + 1 + p);
            let mut at = end;
            while at > h + 1 && lines[at - 1].trim().is_empty() {
                at -= 1;
            }
            if at == h + 1 {
                lines.insert(at, "");
                at += 1;
            }
            at
        }
        None => {
            while lines.last().is_some_and(|l| l.trim().is_empty()) {
                lines.pop();
            }
            if !lines.is_empty() {
                lines.push("");
            }
            lines.push("## Tasks");
            lines.push("");
            lines.len()
        }
    };
    lines.insert(at, &task);
    let mut out = lines.join("\n");
    out.push('\n');
    write_note(root, rel, &out, crypto)
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
    let settings: Option<Daily> =
        std::fs::read(root.join(".obsidian/daily-notes.json")).ok().and_then(|b| serde_json::from_slice(&b).ok());
    // Obsidian's own default is the vault root; a vault without its settings gets a Daily folder.
    let folder = match &settings {
        Some(s) => s.folder.trim().trim_matches('/').to_string(),
        None => "Daily".to_string(),
    };
    let cfg = settings.unwrap_or_default();
    let format = if cfg.format.trim().is_empty() { "YYYY-MM-DD".to_string() } else { cfg.format.clone() };
    let at = date.and_time(Local::now().time());
    let name = moment_format(&format, at);
    // A format like `YYYY/MM/YYYY-MM-DD` keeps daily notes in dated subfolders, as Obsidian does.
    let (folder, name) = match name.rsplit_once('/') {
        Some((sub, file)) => (join(&folder, sub.trim_matches('/')), file.to_string()),
        None => (folder, name),
    };
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
        ("dddd", "%A"), ("ddd", "%a"), ("DD", "%d"), ("Do", ""), ("D", "%-d"), ("M", "%-m"),
        ("HH", "%H"), ("H", "%-H"), ("hh", "%I"), ("h", "%-I"), ("mm", "%M"), ("ss", "%S"),
        ("A", "%p"), ("a", "%P"),
    ];
    let mut out = String::new();
    let mut rest = fmt;
    'outer: while !rest.is_empty() {
        // `[text]` is kept as written, as moment.js does.
        if let Some((literal, after)) = rest.strip_prefix('[').and_then(|r| r.split_once(']')) {
            out.push_str(literal);
            rest = after;
            continue;
        }
        for (tok, chrono_fmt) in tokens {
            if let Some(r) = rest.strip_prefix(tok) {
                if tok == "Do" {
                    out.push_str(&ordinal(at.day()));
                } else {
                    out.push_str(&at.format(chrono_fmt).to_string());
                }
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

/// moment.js `Do`: 1st, 2nd, 3rd, 4th, 11th, 21st.
fn ordinal(day: u32) -> String {
    let suffix = match (day % 10, day % 100) {
        (_, 11..=13) => "th",
        (1, _) => "st",
        (2, _) => "nd",
        (3, _) => "rd",
        _ => "th",
    };
    format!("{day}{suffix}")
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
        // A `.` inside a path is dropped by the path parser; one at the start, or `..`, is refused.
        assert_eq!(safe(root, "a/./b").unwrap(), Path::new("/v/a/b"));
        assert!(safe(root, "./a").is_err());
        assert!(safe(root, "a/../../b").is_err());
        assert!(safe(root, "").is_err());
        assert!(safe(root, "Daily/2026-11-02.md").is_ok());
        assert_eq!(safe(root, "Notes/Café 日本/Ndiyo.md").unwrap(), Path::new("/v/Notes/Café 日本/Ndiyo.md"));
        assert_eq!(safe(root, "../x").unwrap_err().to_string(), "That path is outside the vault.");
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

    #[test]
    fn rename_leaves_links_to_another_note_with_the_same_name() {
        let root = std::env::temp_dir().join(format!("wandika-rename-same-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&root);
        std::fs::create_dir_all(root.join("Projects/Old")).unwrap();
        std::fs::write(root.join("Plan.md"), "root plan").unwrap();
        std::fs::write(root.join("Projects/Old/Plan.md"), "old plan").unwrap();
        std::fs::write(root.join("Daily.md"), "[[Plan]] [[Old/Plan]] [[Projects/Old/Plan|old]] [[Projects/Plan]]").unwrap();
        let crypto = Crypto::load(&root, &crate::secrets::Secrets::new(root.clone()), "test/rename-same");
        let mut index = Index::default();

        // A bare [[Plan]] means the shortest path, the root note, as Obsidian resolves it.
        rename(&root, "Projects/Old/Plan.md", "Archive", &crypto, &mut index).unwrap();
        assert_eq!(
            std::fs::read_to_string(root.join("Daily.md")).unwrap(),
            "[[Plan]] [[Old/Archive]] [[Projects/Old/Archive|old]] [[Projects/Plan]]"
        );
        rename(&root, "Plan.md", "Roadmap", &crypto, &mut index).unwrap();
        assert_eq!(
            std::fs::read_to_string(root.join("Daily.md")).unwrap(),
            "[[Roadmap]] [[Old/Archive]] [[Projects/Old/Archive|old]] [[Projects/Plan]]",
            "[[Projects/Plan]] named no existing note, so it stays as written"
        );
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
    fn only_untouched_untitled_notes_are_discarded() {
        let root = std::env::temp_dir().join(format!("wandika-discard-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&root);
        std::fs::create_dir_all(&root).unwrap();
        let crypto = Crypto::load(&root, &crate::secrets::Secrets::new(root.clone()), "test/discard");
        std::fs::write(root.join("Untitled 2.md"), "\n").unwrap();
        std::fs::write(root.join("Untitled.md"), "Buy milk").unwrap();
        std::fs::write(root.join("Plan.md"), "").unwrap();
        assert!(discard_if_empty(&root, "Untitled 2.md", &crypto).unwrap());
        assert!(!discard_if_empty(&root, "Untitled.md", &crypto).unwrap());
        assert!(!discard_if_empty(&root, "Plan.md", &crypto).unwrap());
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn trash_and_restore_round_trip() {
        let root = std::env::temp_dir().join(format!("wandika-restore-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&root);
        std::fs::create_dir_all(root.join("Projects")).unwrap();
        std::fs::write(root.join("Projects/Plan.md"), "Plan").unwrap();
        let crypto = Crypto::load(&root, &crate::secrets::Secrets::new(root.clone()), "test/restore");
        trash(&root, "Projects/Plan.md", &crypto).unwrap();
        assert!(!root.join("Projects/Plan.md").exists());
        restore(&root, "Projects/Plan.md").unwrap();
        assert_eq!(std::fs::read_to_string(root.join("Projects/Plan.md")).unwrap(), "Plan");
        assert!(restore(&root, "Projects/Plan.md").is_err(), "nothing left to restore");
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn toggling_a_task_keeps_windows_line_endings() {
        let root = std::env::temp_dir().join(format!("wandika-crlf-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&root);
        std::fs::create_dir_all(&root).unwrap();
        std::fs::write(root.join("Tasks.md"), "- [ ] Call Amina\r\nnext line\r\n").unwrap();
        let crypto = Crypto::load(&root, &crate::secrets::Secrets::new(root.clone()), "test/crlf");
        assert!(toggle_task(&root, "Tasks.md", 0, "Call Amina", &crypto).unwrap());
        let today = Local::now().format("%Y-%m-%d");
        assert_eq!(
            std::fs::read_to_string(root.join("Tasks.md")).unwrap(),
            format!("- [x] Call Amina ✅ {today}\r\nnext line\r\n")
        );
        assert!(!toggle_task(&root, "Tasks.md", 0, &format!("Call Amina ✅ {today}"), &crypto).unwrap());
        assert_eq!(std::fs::read_to_string(root.join("Tasks.md")).unwrap(), "- [ ] Call Amina\r\nnext line\r\n");
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn formats_daily_names() {
        let d = NaiveDate::from_ymd_opt(2026, 11, 2).unwrap().and_hms_opt(9, 5, 0).unwrap();
        assert_eq!(moment_format("YYYY-MM-DD", d), "2026-11-02");
        assert_eq!(moment_format("dddd, D MMMM YYYY", d), "Monday, 2 November 2026");
        assert_eq!(moment_format("HH:mm", d), "09:05");
        // `Do` is the ordinal day, so "November 2nd" names the same note Obsidian made.
        assert_eq!(moment_format("MMMM Do, YYYY", d), "November 2nd, 2026");
        let day = |n| NaiveDate::from_ymd_opt(2026, 1, n).unwrap().and_hms_opt(0, 0, 0).unwrap();
        let ords: Vec<String> = [1, 2, 3, 4, 11, 12, 13, 21, 22, 23, 31].map(|n| moment_format("Do", day(n))).into();
        assert_eq!(ords, ["1st", "2nd", "3rd", "4th", "11th", "12th", "13th", "21st", "22nd", "23rd", "31st"]);
        // Text in brackets is literal; a lone bracket is just a character.
        assert_eq!(moment_format("YYYY-MM-DD [Daily]", d), "2026-11-02 Daily");
        assert_eq!(moment_format("[Week of] MMM D", d), "Week of Nov 2");
        assert_eq!(moment_format("YYYY [", d), "2026 [");
    }

    #[test]
    fn daily_notes_follow_obsidian_settings_and_default_to_a_daily_folder() {
        let root = std::env::temp_dir().join(format!("wandika-daily-root-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&root);
        std::fs::create_dir_all(&root).unwrap();
        let crypto = Crypto::load(&root, &crate::secrets::Secrets::new(root.clone()), "test/daily-root");
        let day = NaiveDate::from_ymd_opt(2026, 11, 2).unwrap();
        assert_eq!(daily_note(&root, day, &crypto).unwrap(), "Daily/2026-11-02.md", "no Obsidian settings");

        // Settings with a format but no folder: Obsidian puts the note in the vault root.
        std::fs::create_dir_all(root.join(".obsidian")).unwrap();
        std::fs::write(root.join(".obsidian/daily-notes.json"), r#"{"format":"DD-MM-YYYY"}"#).unwrap();
        assert_eq!(daily_note(&root, day, &crypto).unwrap(), "02-11-2026.md");
        std::fs::write(root.join(".obsidian/daily-notes.json"), r#"{"folder":"/","format":""}"#).unwrap();
        assert_eq!(daily_note(&root, day, &crypto).unwrap(), "2026-11-02.md");
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn daily_note_formats_with_folders_make_one_note_in_dated_subfolders() {
        let root = std::env::temp_dir().join(format!("wandika-daily-nested-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&root);
        std::fs::create_dir_all(root.join(".obsidian")).unwrap();
        std::fs::write(root.join(".obsidian/daily-notes.json"), r#"{"folder":"Journal","format":"YYYY/MM/YYYY-MM-DD"}"#).unwrap();
        let crypto = Crypto::load(&root, &crate::secrets::Secrets::new(root.clone()), "test/daily-nested");
        let day = NaiveDate::from_ymd_opt(2026, 11, 2).unwrap();
        let first = daily_note(&root, day, &crypto).unwrap();
        assert_eq!(first, "Journal/2026/11/2026-11-02.md");
        assert_eq!(daily_note(&root, day, &crypto).unwrap(), first, "the second open finds the same note");
        assert_eq!(tree(&root).unwrap().iter().filter(|e| e.kind == "note").count(), 1);
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn fills_obsidian_template_variables() {
        let at = NaiveDate::from_ymd_opt(2026, 11, 3).unwrap().and_hms_opt(14, 30, 0).unwrap();
        let text = "# {{title}}\n{{date}} {{time}} {{date:dddd D MMMM}} {{ time:h:mm a }}";
        assert_eq!(fill_template(text, "Standup", at), "# Standup\n2026-11-03 14:30 Tuesday 3 November 2:30 pm");
    }


    fn temp_vault(tag: &str) -> (PathBuf, Crypto) {
        let root = std::env::temp_dir().join(format!("wandika-vault-{tag}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&root);
        std::fs::create_dir_all(&root).unwrap();
        let crypto = Crypto::load(&root, &crate::secrets::Secrets::new(root.join(".secrets")), &format!("test/{tag}"));
        (root, crypto)
    }

    fn put(root: &Path, rel: &str, text: &str) {
        let path = root.join(rel);
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        std::fs::write(path, text).unwrap();
    }

    fn get(root: &Path, rel: &str) -> String {
        std::fs::read_to_string(root.join(rel)).unwrap()
    }

    #[test]
    fn hidden_paths_note_names_and_titles() {
        assert!(hidden(".obsidian/app.json"));
        assert!(hidden("Projects/.trash/Plan.md"));
        assert!(hidden("Plan.md.wandika-tmp"));
        assert!(!hidden("v1.2/Plan.md"), "a dot inside a name is not hidden");
        assert!(is_note("Plan.md") && is_note("Private/Diary.md.age"));
        assert!(!is_note("photo.png") && !is_note("photo.png.age") && !is_note("md"));
        assert_eq!(title_of("Projects/Kampala 2026/Plan.md"), "Plan");
        assert_eq!(title_of("Café ☕.md"), "Café ☕");
        assert_eq!(title_of("attachments/photo.png"), "photo.png");
        assert_eq!(rel_of(Path::new("/v"), Path::new("/v/a/b.md")).as_deref(), Some("a/b.md"));
        assert_eq!(rel_of(Path::new("/v"), Path::new("/w/b.md")), None);
        assert_eq!(mtime_ms(SystemTime::UNIX_EPOCH - Duration::from_secs(5)), 0, "before 1970 reads as 0");
        assert_eq!(mtime_ms(SystemTime::UNIX_EPOCH + Duration::from_millis(1500)), 1500);
    }

    #[test]
    fn write_atomic_makes_folders_and_leaves_no_temp_file() {
        let (root, _) = temp_vault("atomic");
        let path = root.join("a/b/c/Note.md");
        write_atomic(&path, b"one").unwrap();
        write_atomic(&path, b"two").unwrap();
        assert_eq!(get(&root, "a/b/c/Note.md"), "two");
        assert!(!root.join(format!("a/b/c/Note.md{TMP_SUFFIX}")).exists());
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn tree_lists_visible_entries_with_kinds_sorted_without_case() {
        let (root, _) = temp_vault("tree");
        put(&root, "b.md", "");
        put(&root, "Archive/Old.md", "");
        put(&root, "attachments/Photo.PNG", "png");
        put(&root, "Private/Diary.md.age", "x");
        put(&root, ".obsidian/app.json", "{}");
        put(&root, ".trash/Gone.md", "");
        put(&root, "Projects/.hidden/x.md", "");
        put(&root, "Draft.md.wandika-tmp", "");
        put(&root, "Ünïcode/Ndiyo.md", "");
        let entries = tree(&root).unwrap();
        let paths: Vec<&str> = entries.iter().map(|e| e.path.as_str()).collect();
        assert_eq!(
            paths,
            ["Archive", "Archive/Old.md", "attachments", "attachments/Photo.PNG", "b.md", "Private", "Private/Diary.md.age", "Projects", "Ünïcode", "Ünïcode/Ndiyo.md"]
        );
        let by = |p: &str| entries.iter().find(|e| e.path == p).unwrap();
        assert_eq!((by("Archive").kind, by("Archive").name.as_str()), ("folder", "Archive"));
        assert_eq!((by("b.md").kind, by("b.md").name.as_str()), ("note", "b"));
        assert_eq!((by("attachments/Photo.PNG").kind, by("attachments/Photo.PNG").name.as_str()), ("file", "Photo.PNG"));
        assert!(by("Private/Diary.md.age").encrypted && by("Private/Diary.md.age").kind == "note");
        assert!(by("b.md").modified > 0);
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn reading_and_writing_notes_and_their_errors() {
        let (root, crypto) = temp_vault("readwrite");
        write_note(&root, "Notes/Café.md", "Habari 👋\n", &crypto).unwrap();
        assert_eq!(read_note(&root, "Notes/Café.md", &crypto).unwrap(), "Habari 👋\n");
        let missing = read_note(&root, "Nope.md", &crypto).unwrap_err();
        assert_eq!(missing.friendly().0, "not_found");
        std::fs::write(root.join("bin.md"), [0xff, 0xfe, 0x00]).unwrap();
        assert_eq!(read_note(&root, "bin.md", &crypto).unwrap_err().to_string(), "This file isn't text.");
        assert!(read_note(&root, "../outside.md", &crypto).is_err());
        assert!(write_note(&root, "/abs.md", "x", &crypto).is_err());
        put(&root, "Locked.md.age", "-----BEGIN AGE ENCRYPTED FILE-----");
        assert!(matches!(read_note(&root, "Locked.md.age", &crypto), Err(crate::error::Error::Locked)));
        assert_eq!(write_note(&root, "New.md.age", "x", &crypto).unwrap_err().to_string(), "Set up encryption first.");
        assert!(!root.join("New.md.age").exists());
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn create_note_cleans_the_name_and_picks_a_free_one() {
        let (root, crypto) = temp_vault("create");
        assert_eq!(create_note(&root, "", "Plan", "one", &crypto).unwrap(), "Plan.md");
        assert_eq!(create_note(&root, "", "Plan", "two", &crypto).unwrap(), "Plan 2.md");
        assert_eq!(create_note(&root, "", "Plan", "three", &crypto).unwrap(), "Plan 3.md");
        assert_eq!(get(&root, "Plan 2.md"), "two");
        assert_eq!(create_note(&root, "/Projects/2026/", " Q1: a/b? ", "", &crypto).unwrap(), "Projects/2026/Q1- a-b-.md");
        assert_eq!(create_note(&root, "", "..hidden", "", &crypto).unwrap(), "hidden.md", "never a hidden file");
        assert_eq!(create_note(&root, "Mail", "Habari ya leo 🌍", "", &crypto).unwrap(), "Mail/Habari ya leo 🌍.md");
        for blank in ["", "   ", "..."] {
            assert_eq!(create_note(&root, "", blank, "", &crypto).unwrap_err().to_string(), "Give the note a name.");
        }
        assert!(create_note(&root, "../out", "Plan", "", &crypto).is_err());
        assert!(!root.parent().unwrap().join("out/Plan.md").exists());
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn new_note_folder_ignores_bad_settings() {
        let (root, _) = temp_vault("newloc-bad");
        put(&root, ".obsidian/app.json", r#"{"newFileLocation":"folder","newFileFolderPath":"../outside"}"#);
        assert_eq!(new_note_folder(&root, Some("Projects/Plan.md")), "", "a folder outside the vault is ignored");
        put(&root, ".obsidian/app.json", r#"{"newFileLocation":"folder","newFileFolderPath":"/Inbox/"}"#);
        assert_eq!(new_note_folder(&root, None), "Inbox");
        put(&root, ".obsidian/app.json", r#"{"newFileLocation":"current"}"#);
        assert_eq!(new_note_folder(&root, None), "", "no open note: the root");
        assert_eq!(new_note_folder(&root, Some("Top.md")), "");
        assert_eq!(new_note_folder(&root, Some("a/b/c/Deep.md")), "a/b/c");
        put(&root, ".obsidian/app.json", "not json");
        assert_eq!(new_note_folder(&root, Some("Projects/Plan.md")), "");
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn discard_keeps_anything_named_written_or_missing() {
        let (root, crypto) = temp_vault("discard-more");
        put(&root, "Untitled 3.md", "  \n\t\n");
        put(&root, "Untitled copy.md", "");
        put(&root, "Untitled.txt", "");
        put(&root, "Projects/Untitled.md", "");
        assert!(discard_if_empty(&root, "Untitled 3.md", &crypto).unwrap(), "whitespace only counts as empty");
        assert!(!root.join("Untitled 3.md").exists());
        assert!(!discard_if_empty(&root, "Untitled copy.md", &crypto).unwrap());
        assert!(!discard_if_empty(&root, "Untitled.txt", &crypto).unwrap());
        assert!(!discard_if_empty(&root, "Untitled 9.md", &crypto).unwrap(), "already gone");
        assert!(discard_if_empty(&root, "Projects/Untitled.md", &crypto).unwrap());
        assert!(discard_if_empty(&root, "../Untitled.md", &crypto).is_err());
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn create_folder_makes_nested_folders_inside_the_vault_only() {
        let (root, _) = temp_vault("folder");
        create_folder(&root, "a/b/Ünï").unwrap();
        assert!(root.join("a/b/Ünï").is_dir());
        create_folder(&root, "a/b/Ünï").unwrap();
        assert!(create_folder(&root, "../escape").is_err());
        assert!(create_folder(&root, "").is_err());
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn rename_handles_folders_types_clashes_and_no_ops() {
        let (root, _) = temp_vault("rename-more");
        put(&root, "Plan.md", "");
        put(&root, "Taken.md", "");
        put(&root, "Private/Diary.md.age", "x");
        put(&root, "Private/2025/Old.md.age", "x");
        put(&root, "attachments/pic.png.age", "x");
        put(&root, "attachments/scan.jpeg", "x");
        put(&root, "LICENSE", "x");
        crypto::save_config(&root, &crypto::EncConfig { folders: vec!["Private".into(), "Private/2025".into(), "Work".into()], ..Default::default() }).unwrap();
        let crypto = Crypto::load(&root, &crate::secrets::Secrets::new(root.join(".secrets")), "test/rename-more");
        let mut index = Index::default();

        assert_eq!(rename(&root, "Plan.md", "Plan", &crypto, &mut index).unwrap(), "Plan.md", "same name: nothing to do");
        assert_eq!(rename(&root, "Plan.md", "Taken", &crypto, &mut index).unwrap_err().to_string(), "“Taken” already exists here.");
        assert!(root.join("Plan.md").exists());
        assert_eq!(rename(&root, "Plan.md", "", &crypto, &mut index).unwrap_err().to_string(), "Give the note a name.");
        assert_eq!(rename(&root, "attachments/pic.png.age", "beach", &crypto, &mut index).unwrap(), "attachments/beach.png.age");
        assert_eq!(rename(&root, "attachments/scan.jpeg", "receipt.JPEG", &crypto, &mut index).unwrap(), "attachments/receipt.JPEG", "a typed extension isn't doubled");
        assert_eq!(rename(&root, "LICENSE", "COPYING", &crypto, &mut index).unwrap(), "COPYING");
        assert_eq!(rename(&root, "Private/Diary.md.age", "Journal", &crypto, &mut index).unwrap(), "Private/Journal.md.age");

        // A folder moves with everything in it, and stays encrypted under its new name.
        assert_eq!(rename(&root, "Private", "Siri", &crypto, &mut index).unwrap(), "Siri");
        assert!(root.join("Siri/2025/Old.md.age").exists());
        let cfg: crypto::EncConfig = serde_json::from_slice(&std::fs::read(root.join(crypto::CONFIG_PATH)).unwrap()).unwrap();
        assert_eq!(cfg.folders, vec!["Siri", "Siri/2025", "Work"]);
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn trash_replaces_an_older_copy_and_forgets_encrypted_folders() {
        let (root, _) = temp_vault("trash-more");
        put(&root, "Plan.md", "first");
        put(&root, "Private/Diary.md.age", "x");
        crypto::save_config(&root, &crypto::EncConfig { folders: vec!["Private".into(), "Work".into()], ..Default::default() }).unwrap();
        let crypto = Crypto::load(&root, &crate::secrets::Secrets::new(root.join(".secrets")), "test/trash-more");
        trash(&root, "Plan.md", &crypto).unwrap();
        put(&root, "Plan.md", "second");
        trash(&root, "Plan.md", &crypto).unwrap();
        assert_eq!(get(&root, ".trash/Plan.md"), "second", "the newest deletion is the one kept");
        trash(&root, "Private", &crypto).unwrap();
        assert!(root.join(".trash/Private/Diary.md.age").exists());
        let cfg: crypto::EncConfig = serde_json::from_slice(&std::fs::read(root.join(crypto::CONFIG_PATH)).unwrap()).unwrap();
        assert_eq!(cfg.folders, vec!["Work"]);
        assert!(trash(&root, "../x", &crypto).is_err());
        assert!(trash(&root, "Missing.md", &crypto).is_err());
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn restore_never_overwrites_something_new() {
        let (root, crypto) = temp_vault("restore-taken");
        put(&root, "Projects/Plan.md", "old");
        trash(&root, "Projects/Plan.md", &crypto).unwrap();
        std::fs::remove_dir_all(root.join("Projects")).unwrap();
        put(&root, "Projects/Plan.md", "new");
        assert_eq!(
            restore(&root, "Projects/Plan.md").unwrap_err().to_string(),
            "Something new has the same name there now, so it stays in the trash."
        );
        assert_eq!(get(&root, "Projects/Plan.md"), "new");
        std::fs::remove_dir_all(root.join("Projects")).unwrap();
        restore(&root, "Projects/Plan.md").unwrap();
        assert_eq!(get(&root, "Projects/Plan.md"), "old", "its folder is made again");
        assert_eq!(restore(&root, "Projects/Plan.md").unwrap_err().to_string(), "It isn't in the trash any more.");
        assert!(restore(&root, "../Plan.md").is_err());
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn set_encrypted_converts_notes_and_folders_both_ways() {
        let (root, mut locked) = temp_vault("encrypt");
        put(&root, "Plan.md", "plan");
        assert_eq!(set_encrypted(&root, "Plan.md", true, &mut locked).unwrap_err().to_string(), "Set up or unlock encryption first.");
        assert_eq!(set_encrypted(&root, "Plan.md", false, &mut locked).unwrap_err().to_string(), "Unlock encrypted notes first.");

        let secrets = crate::secrets::Secrets::new(root.join(".secrets"));
        let mut crypto = Crypto::set_up(&root, &secrets, "test/encrypt", "long passphrase").unwrap();
        assert_eq!(set_encrypted(&root, "Plan.md", true, &mut crypto).unwrap(), "Plan.md.age");
        assert!(!root.join("Plan.md").exists());
        assert!(get(&root, "Plan.md.age").starts_with("-----BEGIN AGE ENCRYPTED FILE-----"));
        assert_eq!(read_note(&root, "Plan.md.age", &crypto).unwrap(), "plan");
        assert_eq!(set_encrypted(&root, "Plan.md.age", true, &mut crypto).unwrap(), "Plan.md.age", "already encrypted");
        assert_eq!(set_encrypted(&root, "Plan.md.age", false, &mut crypto).unwrap(), "Plan.md");
        assert_eq!(get(&root, "Plan.md"), "plan");

        // A folder: its notes are encrypted, pictures and hidden files left, and new notes follow.
        put(&root, "Private/Diary.md", "dear diary");
        put(&root, "Private/2025/Old.md", "old");
        put(&root, "Private/photo.png", "png");
        put(&root, "Private/.obsidian/x.md", "hidden");
        assert_eq!(set_encrypted(&root, "Private/", true, &mut crypto).unwrap(), "Private/");
        assert!(root.join("Private/Diary.md.age").exists() && root.join("Private/2025/Old.md.age").exists());
        assert_eq!(get(&root, "Private/photo.png"), "png");
        assert_eq!(get(&root, "Private/.obsidian/x.md"), "hidden");
        assert_eq!(crypto.status().folders, vec!["Private"]);
        assert_eq!(Crypto::load(&root, &secrets, "test/encrypt").status().folders, vec!["Private"], "saved in the vault");
        assert_eq!(create_note(&root, "Private/2025", "New", "x", &crypto).unwrap(), "Private/2025/New.md.age");
        set_encrypted(&root, "Private", true, &mut crypto).unwrap();
        assert_eq!(crypto.status().folders, vec!["Private"], "listed once");

        set_encrypted(&root, "Private", false, &mut crypto).unwrap();
        assert_eq!(get(&root, "Private/Diary.md"), "dear diary");
        assert_eq!(get(&root, "Private/2025/New.md"), "x");
        assert!(crypto.status().folders.is_empty());
        assert!(set_encrypted(&root, "../x", true, &mut crypto).is_err());
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn parse_reads_nested_tags_once_and_skips_non_tags() {
        let m = parse("a.md", "#area/home and #Idea, #idea again\nemail a#b, #1 and # heading\n#idea", 7, true, true);
        assert_eq!(m.tags, vec!["Idea", "area/home", "idea"]);
        assert_eq!((m.modified, m.encrypted, m.locked), (7, true, true));
        let m = parse("a.md", "[[A]] [[A]] [[ B |x]] [[C#Head]] [[A|again]] [[B]]", 0, false, false);
        assert_eq!(m.links, vec!["A", "B", "C"], "each link once, in order; names are trimmed");
        assert!(!parse("a.md", "plain", 0, false, false).board);
    }

    #[test]
    fn boards_need_the_kanban_key_in_the_frontmatter() {
        assert!(is_board("---\ntags: [x]\n  kanban-plugin: board\n---\n"));
        assert!(is_board("---\nkanban-plugin: basic"), "frontmatter that never closes still counts");
        assert!(!is_board("---\ntitle: x\n---\nkanban-plugin: basic\n"));
        assert!(!is_board(""));
    }

    #[test]
    fn strip_code_drops_fenced_blocks_only() {
        assert_eq!(strip_code("a\n```rust\n#[derive]\n```\nb\n  ```\n[[x]]\n  ```\nc"), "a\nb\nc\n");
        assert_eq!(strip_code("inline `#tag` stays"), "inline `#tag` stays\n");
    }

    #[test]
    fn snippets_show_the_match_in_context() {
        assert_eq!(snippet("first line\nsecond", "absent"), "first line second");
        let long = format!("{}needle here", "word ".repeat(40));
        let s = snippet(&long, "needle");
        assert!(s.starts_with('…') && s.contains("needle here"), "{s}");
        assert!(!snippet("needle at the start", "needle").starts_with('…'));
        // Lowercasing İ adds a byte, so the snippet starts at the top instead of mid-character.
        let turkish = format!("İ{}needle", "x".repeat(100));
        assert!(snippet(&turkish, "needle").starts_with('İ'));
        let multibyte = format!("{}needle", "日本".repeat(40));
        assert!(snippet(&multibyte, "needle").contains("needle"), "never cuts inside a character");
    }

    #[test]
    fn tasks_in_reads_every_list_style_and_skips_code() {
        let t = tasks_in("a.md", "A", "- [ ] one\n  * [x] two 📅 2026-01-02\n+ [X] three\n- [] not\n-[ ] not\n```\n- [ ] code\n```\n1. [ ] numbered");
        let texts: Vec<(&str, bool, usize)> = t.iter().map(|t| (t.text.as_str(), t.done, t.line)).collect();
        assert_eq!(texts, [("one", false, 0), ("two 📅 2026-01-02", true, 1), ("three", true, 2)]);
        assert_eq!(t[1].due.as_deref(), Some("2026-01-02"));
        assert_eq!((t[0].path.as_str(), t[0].title.as_str()), ("a.md", "A"));
    }

    #[test]
    fn toggle_task_ticks_unticks_and_refuses_stale_lines() {
        let (root, crypto) = temp_vault("toggle");
        put(&root, "T.md", "# T\n  * [X] Done ✅ 2026-01-01\n- [ ] Open\nplain");
        let today = Local::now().format("%Y-%m-%d").to_string();
        assert!(!toggle_task(&root, "T.md", 1, "Done ✅ 2026-01-01", &crypto).unwrap());
        assert!(toggle_task(&root, "T.md", 2, " Open ", &crypto).unwrap());
        assert_eq!(get(&root, "T.md"), format!("# T\n  * [ ] Done\n- [x] Open ✅ {today}\nplain"));
        let moved = "That task moved. Refresh and try again.";
        assert_eq!(toggle_task(&root, "T.md", 9, "Open", &crypto).unwrap_err().to_string(), moved);
        assert_eq!(toggle_task(&root, "T.md", 3, "plain", &crypto).unwrap_err().to_string(), moved);
        assert_eq!(toggle_task(&root, "T.md", 1, "Something else", &crypto).unwrap_err().to_string(), "That task changed. Refresh and try again.");
        assert!(toggle_task(&root, "Missing.md", 0, "x", &crypto).is_err());
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn a_task_carries_the_indented_lines_under_it_as_details() {
        let t = tasks_in("a.md", "A", "- [ ] Call Amina\n  ask about the lease\n\tand the keys\n  - [ ] subtask\n- [ ] Next\nplain\n  - [ ] Nested\n    its note\n\n    after a blank");
        assert_eq!(t[0].details, "ask about the lease\nand the keys");
        assert_eq!(t[1].details, "", "a subtask is its own task, not a note");
        assert_eq!(t[2].details, "");
        assert_eq!(t[3].details, "its note", "a blank line ends the notes");
    }

    #[test]
    fn edit_task_rewrites_the_line_and_its_notes_and_refuses_stale_lines() {
        let (root, crypto) = temp_vault("edit");
        put(&root, "T.md", "# T\n  * [x] Call Amina\n    old note\n    second\n  * [ ] Next\nend");
        edit_task(&root, "T.md", 1, "Call Amina", "Call Amina #home 📌 ⏫ 📅 2026-11-05", "Ask about the lease\n\n  bring keys ", &crypto).unwrap();
        assert_eq!(get(&root, "T.md"), "# T\n  * [x] Call Amina #home 📌 ⏫ 📅 2026-11-05\n    Ask about the lease\n    bring keys\n  * [ ] Next\nend");
        edit_task(&root, "T.md", 1, "Call Amina #home 📌 ⏫ 📅 2026-11-05", "Call Amina", "", &crypto).unwrap();
        assert_eq!(get(&root, "T.md"), "# T\n  * [x] Call Amina\n  * [ ] Next\nend", "clearing the notes removes their lines");
        let said = |r: Result<()>| r.unwrap_err().to_string();
        assert_eq!(said(edit_task(&root, "T.md", 1, "Something else", "x", "", &crypto)), "That task changed. Refresh and try again.");
        assert_eq!(said(edit_task(&root, "T.md", 3, "end", "x", "", &crypto)), "That task moved. Refresh and try again.");
        assert_eq!(said(edit_task(&root, "T.md", 1, "Call Amina", "  ", "", &crypto)), "Give the task a name.");
        assert_eq!(said(edit_task(&root, "T.md", 1, "Call Amina", "a\nb", "", &crypto)), "A task is one line. Put the rest in its notes.");
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn take_task_cuts_the_task_and_its_notes_and_put_back_restores_them() {
        let (root, crypto) = temp_vault("take");
        put(&root, "T.md", "# T\n- [ ] Call Amina\n  ask about the lease\n  - [ ] Subtask\n- [ ] Next\n");
        let taken = take_task(&root, "T.md", 1, "Call Amina", &crypto).unwrap();
        assert_eq!(taken, ["- [ ] Call Amina", "  ask about the lease"]);
        assert_eq!(get(&root, "T.md"), "# T\n  - [ ] Subtask\n- [ ] Next\n", "a subtask is its own task and stays");
        put_back(&root, "T.md", 1, &taken, &crypto).unwrap();
        assert_eq!(get(&root, "T.md"), "# T\n- [ ] Call Amina\n  ask about the lease\n  - [ ] Subtask\n- [ ] Next\n");
        put_back(&root, "T.md", 99, &taken, &crypto).unwrap();
        assert!(get(&root, "T.md").ends_with("- [ ] Next\n- [ ] Call Amina\n  ask about the lease\n"), "a shorter note gets it at the end, before the last newline");
        let said = |r: Result<Vec<String>>| r.unwrap_err().to_string();
        assert_eq!(said(take_task(&root, "T.md", 1, "Something else", &crypto)), "That task changed. Refresh and try again.");
        assert_eq!(said(take_task(&root, "T.md", 0, "T", &crypto)), "That task moved. Refresh and try again.");
        assert_eq!(put_back(&root, "T.md", 0, &["not a task".into()], &crypto).unwrap_err().to_string(), "There's no task to put back.");
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn archive_task_moves_it_to_the_archive_note_and_out_of_task_lists() {
        let (root, crypto) = temp_vault("archive");
        put(&root, "Projects/Plan.md", "# Plan\n  - [ ] Call Amina 📅 2026-11-05\n    ask about the lease\n  - [ ] Next\n");
        let done = archive_task(&root, "Projects/Plan.md", 1, "Call Amina 📅 2026-11-05", &crypto).unwrap();
        assert_eq!(done.archive, "Archive.md");
        assert_eq!(get(&root, "Projects/Plan.md"), "# Plan\n  - [ ] Next\n");
        let today = Local::now().format("%Y-%m-%d");
        assert_eq!(
            get(&root, "Archive.md"),
            format!("# Archive\n- [ ] Call Amina 📅 2026-11-05\n  From [[Projects/Plan]], archived {today}\n  ask about the lease\n"),
            "a new archive note, the task at the top level, where it came from as its first note"
        );
        let mut index = Index::default();
        index.refresh(&root, &crypto);
        let texts: Vec<String> = index.tasks().into_iter().map(|t| t.text).collect();
        assert_eq!(texts, ["Next"], "archived tasks leave every task list");

        // A second task is added after the first; Undo takes only its own block back.
        let second = archive_task(&root, "Projects/Plan.md", 1, "Next", &crypto).unwrap();
        assert_eq!(get(&root, "Projects/Plan.md"), "# Plan\n");
        unarchive_task(&root, &second.archive, &second.appended, "Projects/Plan.md", 1, &second.taken, &crypto).unwrap();
        assert_eq!(get(&root, "Projects/Plan.md"), "# Plan\n  - [ ] Next\n");
        assert!(get(&root, "Archive.md").ends_with("ask about the lease\n"), "the first archived task stays");
        assert_eq!(archive_task(&root, "Archive.md", 1, "Call Amina 📅 2026-11-05", &crypto).unwrap_err().to_string(), "That task is already in the archive.");
        assert_eq!(archive_note_for("Private/Diary.md.age"), "Archive.md.age", "an encrypted task goes to the encrypted archive");
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn edit_task_keeps_windows_line_endings() {
        let (root, crypto) = temp_vault("edit-crlf");
        put(&root, "T.md", "- [ ] One\r\n  note\r\nnext\r\n");
        edit_task(&root, "T.md", 0, "One", "One 📌", "new note", &crypto).unwrap();
        assert_eq!(get(&root, "T.md"), "- [ ] One 📌\r\n  new note\r\nnext\r\n");
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn add_task_goes_to_the_end_of_the_tasks_section() {
        let (root, crypto) = temp_vault("add");
        put(&root, "D.md", "# Day\n\n## Tasks\n\n- [ ] First\n\n## Notes\nhello\n");
        add_task(&root, "D.md", "Reply to Amina", &crypto).unwrap();
        assert_eq!(get(&root, "D.md"), "# Day\n\n## Tasks\n\n- [ ] First\n- [ ] Reply to Amina\n\n## Notes\nhello\n");
        put(&root, "E.md", "# Day\n\n## Tasks\n\n## Notes\n");
        add_task(&root, "E.md", "One", &crypto).unwrap();
        assert_eq!(get(&root, "E.md"), "# Day\n\n## Tasks\n\n- [ ] One\n\n## Notes\n", "an empty section gets its first task");
        put(&root, "F.md", "# Day\ntext\n\n");
        add_task(&root, "F.md", "One", &crypto).unwrap();
        assert_eq!(get(&root, "F.md"), "# Day\ntext\n\n## Tasks\n\n- [ ] One\n", "no section yet: one is added");
        put(&root, "G.md", "## Tasks");
        add_task(&root, "G.md", "Last", &crypto).unwrap();
        assert_eq!(get(&root, "G.md"), "## Tasks\n\n- [ ] Last\n");
        assert_eq!(add_task(&root, "G.md", " ", &crypto).unwrap_err().to_string(), "Give the task a name.");
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn index_rescans_only_when_due() {
        let (root, crypto) = temp_vault("fresh");
        put(&root, "A.md", "alpha");
        let mut index = Index::default();
        index.ensure_fresh(&root, &crypto);
        assert_eq!(index.titles().len(), 1);
        // Changed outside the app, within the rescan interval: not seen until marked stale.
        put(&root, "B.md", "beta");
        index.ensure_fresh(&root, &crypto);
        assert_eq!(index.titles().len(), 1);
        index.mark_stale();
        index.ensure_fresh(&root, &crypto);
        assert_eq!(index.titles().len(), 2);
        // Deleted notes leave the index.
        std::fs::remove_file(root.join("A.md")).unwrap();
        index.refresh(&root, &crypto);
        assert_eq!(index.titles().iter().map(|n| n.path.as_str()).collect::<Vec<_>>(), ["B.md"]);
        // Another vault replaces everything.
        let (other, other_crypto) = temp_vault("fresh-other");
        put(&other, "C.md", "gamma");
        index.ensure_fresh(&other, &other_crypto);
        assert_eq!(index.titles().iter().map(|n| n.path.as_str()).collect::<Vec<_>>(), ["C.md"]);
        let _ = std::fs::remove_dir_all(&root);
        let _ = std::fs::remove_dir_all(&other);
    }

    #[test]
    fn index_lists_titles_newest_first_and_marks_locked_notes() {
        let (root, crypto) = temp_vault("titles");
        put(&root, "Old.md", "old");
        put(&root, "Private/Diary.md.age", "-----BEGIN AGE ENCRYPTED FILE-----");
        put(&root, ".obsidian/Hidden.md", "x");
        put(&root, "photo.png", "x");
        let old = std::fs::File::options().write(true).open(root.join("Old.md")).unwrap();
        old.set_modified(SystemTime::now() - Duration::from_secs(3600)).unwrap();
        let mut index = Index::default();
        index.refresh(&root, &crypto);
        let titles = index.titles();
        assert_eq!(titles.iter().map(|n| n.title.as_str()).collect::<Vec<_>>(), ["Diary", "Old"]);
        assert!(titles[0].encrypted && titles[0].locked);
        assert!(!titles[1].encrypted && !titles[1].locked);
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn resolve_matches_names_paths_and_prefers_the_shortest() {
        let (root, crypto) = temp_vault("resolve");
        for p in ["Plan.md", "Projects/Plan.md", "Projects/Deep/Plan.md", "Private/Diary.md.age", "Kampala Trip.md", "Ünïcode/Ndiyo.md"] {
            put(&root, p, "");
        }
        let mut index = Index::default();
        index.refresh(&root, &crypto);
        assert_eq!(index.resolve("Plan").as_deref(), Some("Plan.md"));
        assert_eq!(index.resolve(" plan.md ").as_deref(), Some("Plan.md"));
        assert_eq!(index.resolve("Projects/Plan").as_deref(), Some("Projects/Plan.md"));
        assert_eq!(index.resolve("Deep/Plan").as_deref(), Some("Projects/Deep/Plan.md"));
        assert_eq!(index.resolve("diary").as_deref(), Some("Private/Diary.md.age"));
        assert_eq!(index.resolve("kampala trip").as_deref(), Some("Kampala Trip.md"));
        assert_eq!(index.resolve("Ndiyo").as_deref(), Some("Ünïcode/Ndiyo.md"));
        assert_eq!(index.resolve("lan"), None, "part of a name is not a match");
        assert_eq!(index.resolve("Missing"), None);
        put(&root, "L.md", "[[projects/plan]] [[Other]]");
        index.refresh(&root, &crypto);
        assert_eq!(index.notes_linking_to("PLAN"), ["L.md"], "by name, without case");
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn search_needs_every_word_and_ranks_titles_first() {
        let (root, crypto) = temp_vault("search");
        put(&root, "Kampala.md", "A city.");
        put(&root, "Kampala Trip.md", "Bags.");
        put(&root, "Notes.md", "Went to kampala, then kampala again. Trip was long.");
        put(&root, "Other.md", "Nothing here.");
        let mut index = Index::default();
        index.refresh(&root, &crypto);
        assert!(index.search("   ", &crypto).is_empty());
        let titles: Vec<String> = index.search("Kampala", &crypto).into_iter().map(|h| h.title).collect();
        assert_eq!(titles, ["Kampala", "Kampala Trip", "Notes"], "exact title, then title start, then body");
        let both: Vec<String> = index.search("kampala trip", &crypto).into_iter().map(|h| h.title).collect();
        assert_eq!(both, ["Kampala Trip", "Notes"], "every word must appear somewhere");
        assert_eq!(index.search("projects", &crypto).len(), 0);
        put(&root, "Projects/x.md", "");
        index.refresh(&root, &crypto);
        assert_eq!(index.search("projects", &crypto)[0].path, "Projects/x.md", "the folder counts");
        for i in 0..60 {
            put(&root, &format!("many/n{i}.md"), "common");
        }
        index.refresh(&root, &crypto);
        assert_eq!(index.search("common", &crypto).len(), 50, "at most 50 results");
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn backlinks_list_other_notes_by_title() {
        let (root, crypto) = temp_vault("backlinks");
        put(&root, "Plan.md", "I link [[Plan]] myself");
        put(&root, "b.md", "See [[Projects/Plan|it]]");
        put(&root, "A.md", "Also [[plan#Goals]]");
        put(&root, "C.md", "No link to Plan");
        let mut index = Index::default();
        index.refresh(&root, &crypto);
        let hits = index.backlinks("Plan.md", &crypto);
        assert_eq!(hits.iter().map(|h| h.title.as_str()).collect::<Vec<_>>(), ["A", "b"]);
        assert!(hits[0].snippet.contains("[[plan#Goals]]"));
        assert!(index.backlinks("Nobody.md", &crypto).is_empty());
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn vault_tasks_sort_by_due_date_and_skip_templates() {
        let (root, crypto) = temp_vault("tasks");
        put(&root, "b.md", "- [ ] no date\n- [ ] later 📅 2026-12-01");
        put(&root, "a.md", "- [ ] sooner 📅 2026-11-05\n- [ ] undated a");
        put(&root, "Templates/Daily.md", "- [ ] template blank");
        let mut index = Index::default();
        index.refresh(&root, &crypto);
        let texts: Vec<String> = index.tasks().into_iter().map(|t| t.text).collect();
        assert_eq!(texts, ["sooner 📅 2026-11-05", "later 📅 2026-12-01", "undated a", "no date"]);
        put(&root, ".obsidian/templates.json", r#"{"folder":"Kits"}"#);
        put(&root, "Kits/T.md", "- [ ] kit blank");
        index.refresh(&root, &crypto);
        let texts: Vec<String> = index.tasks().into_iter().map(|t| t.text).collect();
        assert!(texts.contains(&"template blank".to_string()), "Templates is ordinary once another folder is set");
        assert!(!texts.contains(&"kit blank".to_string()));
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn daily_note_reuses_existing_notes_and_fills_its_template() {
        let (root, crypto) = temp_vault("daily-more");
        let day = NaiveDate::from_ymd_opt(2026, 11, 3).unwrap();
        let rel = daily_note(&root, day, &crypto).unwrap();
        assert_eq!(get(&root, &rel), "# Tuesday 3 November 2026\n\n## Agenda\n\n## Notes\n\n## Tasks\n\n");
        put(&root, &rel, "edited");
        assert_eq!(daily_note(&root, day, &crypto).unwrap(), rel);
        assert_eq!(get(&root, &rel), "edited", "an existing note is never rewritten");

        // An encrypted daily note counts as today's note.
        put(&root, "Daily/2026-11-04.md.age", "x");
        assert_eq!(daily_note(&root, day.succ_opt().unwrap(), &crypto).unwrap(), "Daily/2026-11-04.md.age");

        put(&root, ".obsidian/daily-notes.json", r#"{"folder":"Journal/","format":"dddd D MMM","template":"Templates/Day.md"}"#);
        put(&root, "Templates/Day.md", "# {{title}}\nDate: {{date:YYYY-MM-DD}}");
        assert_eq!(daily_note(&root, day, &crypto).unwrap(), "Journal/Tuesday 3 Nov.md");
        assert_eq!(get(&root, "Journal/Tuesday 3 Nov.md"), "# Tuesday 3 Nov\nDate: 2026-11-03");
        put(&root, ".obsidian/daily-notes.json", r#"{"folder":"Journal","template":"Templates/Gone"}"#);
        assert_eq!(daily_note(&root, day.pred_opt().unwrap(), &crypto).unwrap(), "Journal/2026-11-02.md");
        assert_eq!(get(&root, "Journal/2026-11-02.md"), "", "a missing template gives an empty note");
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn template_variables_cover_defaults_spacing_and_unknowns() {
        let at = NaiveDate::from_ymd_opt(2026, 1, 5).unwrap().and_hms_opt(7, 3, 9).unwrap();
        assert_eq!(fill_template("{{ title }}|{{date:}}|{{time:HH:mm:ss}}|{{foo}}|{{Title}}", "T", at), "T|2026-01-05|07:03:09|{{foo}}|{{Title}}");
        assert_eq!(fill_template("no variables", "T", at), "no variables");
        assert_eq!(moment_format("YY M D H h A a hh ddd MMM", at), "26 1 5 7 7 AM am 07 Mon Jan");
        assert_eq!(moment_format("Wk 日本", at), "Wk 日本", "other text passes through");
    }

    #[test]
    fn templates_come_from_the_configured_folder_sorted_by_name() {
        let (root, _) = temp_vault("templates");
        assert!(templates(&root).is_empty(), "no Templates folder");
        put(&root, "Templates/zeta.md", "");
        put(&root, "Templates/Alpha.md", "");
        put(&root, "Templates/Sub/Beta.md.age", "");
        put(&root, "Templates/logo.png", "");
        put(&root, "Templates/.hidden.md", "");
        assert_eq!(templates(&root), ["Templates/Alpha.md", "Templates/Sub/Beta.md.age", "Templates/zeta.md"]);
        put(&root, ".obsidian/templates.json", r#"{"folder":"/Kits/"}"#);
        assert!(templates(&root).is_empty(), "the configured folder doesn't exist yet");
        put(&root, "Kits/Meeting.md", "");
        assert_eq!(templates(&root), ["Kits/Meeting.md"]);
        put(&root, ".obsidian/templates.json", r#"{"folder":"../outside"}"#);
        assert!(templates(&root).is_empty());
        put(&root, ".obsidian/templates.json", r#"{"folder":""}"#);
        assert_eq!(templates(&root).len(), 3, "an empty setting falls back to Templates");
        let _ = std::fs::remove_dir_all(&root);
    }
}
