//! Two-way sync between the local working copy and one branch on GitHub.
//!
//! The last synced commit and its file hashes are the merge base. Each sync:
//! 1. pulls files that changed only on GitHub,
//! 2. merges notes changed on both sides (three-way, line based); when lines clash, the remote
//!    version is kept beside the local one as "Name (conflict 2026-11-02 0930).md",
//! 3. pushes everything else as one commit, fast-forward only, retrying if GitHub moved meanwhile.

use crate::error::{msg, Result};
use crate::github::{blob_sha, GitHub};
use crate::vault::{self, TMP_SUFFIX};
use chrono::Local;
use futures::{stream, StreamExt, TryStreamExt};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::collections::{BTreeMap, BTreeSet, HashMap, HashSet};
use std::io::Read;
use std::path::{Path, PathBuf};
use ignore::gitignore::{Gitignore, GitignoreBuilder};
use walkdir::WalkDir;

/// Larger files stay on the device they were added on; GitHub's blob API stops at 100 MB.
const MAX_FILE: u64 = 50 * 1024 * 1024;
/// Above this many remote changes, one tarball download beats one request per file.
const TARBALL_THRESHOLD: usize = 40;

const WELCOME: &str = "# Welcome to Wandika\n\nThis repository is your notes vault. Every note is a Markdown file, so it also opens in Obsidian.\n\n- [ ] Write your first note\n";

#[derive(Serialize, Deserialize, Clone)]
pub struct Target {
    pub owner: String,
    pub repo: String,
    pub branch: String,
}


#[derive(Serialize, Deserialize, Clone, PartialEq)]
struct Stat {
    mtime: u64,
    size: u64,
    sha: String,
}

#[derive(Serialize, Deserialize, Clone, Default)]
pub struct SyncState {
    pub head: Option<String>,
    pub files: BTreeMap<String, String>,
    #[serde(default)]
    stat: BTreeMap<String, Stat>,
    pub last_sync: Option<i64>,
}

#[derive(Serialize, Clone, Default)]
pub struct SyncReport {
    pub pulled: Vec<String>,
    pub pushed: Vec<String>,
    pub removed: Vec<String>,
    pub merged: Vec<String>,
    pub conflicts: Vec<String>,
    /// Over 50 MB: kept on this device, not uploaded.
    pub too_big: Vec<String>,
    /// Files left for a later sync: this sync's size, or GitHub's hourly limit, was reached.
    pub waiting: usize,
    /// Everything that syncs, in bytes, to compare with GitHub's 1 GB recommendation.
    pub vault_bytes: u64,
    pub head: Option<String>,
    pub at: i64,
}

/// What a running sync tells the interface, and how it is asked to stop.
pub struct Ctl {
    pub cancel: std::sync::Arc<std::sync::atomic::AtomicBool>,
    /// (phase, done, total): "checking", "downloading", "uploading", "saving".
    pub progress: Box<dyn Fn(&str, usize, usize) + Send + Sync>,
}

impl Ctl {
    fn check(&self) -> Result<()> {
        if self.cancel.load(std::sync::atomic::Ordering::Relaxed) {
            return Err(crate::error::Error::Cancelled);
        }
        Ok(())
    }
}

/// At most this much file data goes up in one sync, so a big first sync arrives in steps (and a
/// phone on mobile data isn't asked for hundreds of megabytes at once).
const BYTES_PER_SYNC: u64 = 100 * 1024 * 1024;

/// Text files up to this size go into the tree request itself, saving one request each.
const INLINE_MAX: usize = 256 * 1024;
/// Inline text per tree request; larger change sets are sent as a chain of trees.
const TREE_BATCH_BYTES: usize = 2 * 1024 * 1024;

pub struct Paths {
    pub files: PathBuf,
    pub state: PathBuf,
}

pub fn load_state(p: &Paths) -> SyncState {
    std::fs::read(&p.state).ok().and_then(|b| serde_json::from_slice(&b).ok()).unwrap_or_default()
}

fn save_state(p: &Paths, s: &SyncState) -> Result<()> {
    vault::write_atomic(&p.state, &serde_json::to_vec(s)?)
}

/// Paths sync leaves alone on both sides: the vault's `.gitignore`, plus files that only describe
/// one device (Obsidian's open tabs, Finder's .DS_Store). Ignored files are never uploaded,
/// downloaded or deleted, so a file GitHub already has stays as it is there.
struct Ignored(Gitignore);

impl Ignored {
    fn load(root: &Path) -> Self {
        let mut b = GitignoreBuilder::new(root);
        for line in [".git", ".DS_Store", ".obsidian/workspace.json", ".obsidian/workspace-mobile.json"] {
            let _ = b.add_line(None, line);
        }
        let _ = b.add_line(None, &format!("*{TMP_SUFFIX}"));
        if root.join(".gitignore").is_file() {
            let _ = b.add(root.join(".gitignore"));
        }
        Ignored(b.build().unwrap_or_else(|_| Gitignore::empty()))
    }

    fn file(&self, rel: &str) -> bool {
        self.0.matched_path_or_any_parents(rel, false).is_ignore()
    }

    fn dir(&self, rel: &str) -> bool {
        self.0.matched_path_or_any_parents(rel, true).is_ignore()
    }
}

/// Hashes every local file, reusing the cached hash when size and mtime are unchanged.
fn scan(
    root: &Path,
    cache: &BTreeMap<String, Stat>,
    ignored: &Ignored,
) -> Result<(BTreeMap<String, String>, BTreeMap<String, Stat>)> {
    let mut files = BTreeMap::new();
    let mut stat = BTreeMap::new();
    if !root.exists() {
        return Ok((files, stat));
    }
    let rel_of = |p: &Path| {
        p.strip_prefix(root)
            .unwrap()
            .components()
            .filter_map(|c| c.as_os_str().to_str())
            .collect::<Vec<_>>()
            .join("/")
    };
    let walk = WalkDir::new(root)
        .follow_links(false)
        .into_iter()
        .filter_entry(|e| e.depth() == 0 || !(e.file_type().is_dir() && ignored.dir(&rel_of(e.path()))));
    for e in walk {
        let e = e.map_err(|_| msg("Wandika can't read the vault folder. Allow access in System Settings, or choose the folder again."))?;
        if !e.file_type().is_file() {
            continue;
        }
        let rel = rel_of(e.path());
        if ignored.file(&rel) {
            continue;
        }
        let meta = e.metadata().map_err(|e| crate::error::Error::Io(e.into()))?;
        let mtime = meta
            .modified()
            .ok()
            .and_then(|t| t.duration_since(std::time::SystemTime::UNIX_EPOCH).ok())
            .map(|d| d.as_nanos() as u64)
            .unwrap_or(0);
        let sha = match cache.get(&rel) {
            Some(s) if s.mtime == mtime && s.size == meta.len() => s.sha.clone(),
            _ => blob_sha(&std::fs::read(e.path())?),
        };
        files.insert(rel.clone(), sha.clone());
        stat.insert(rel, Stat { mtime, size: meta.len(), sha });
    }
    Ok((files, stat))
}

fn changed(a: &BTreeMap<String, String>, b: &BTreeMap<String, String>) -> BTreeSet<String> {
    a.keys().chain(b.keys()).filter(|k| a.get(*k) != b.get(*k)).cloned().collect()
}

fn remove_local(root: &Path, rel: &str) -> Result<()> {
    let path = vault::safe(root, rel)?;
    if path.exists() {
        std::fs::remove_file(&path)?;
    }
    let mut dir = path.parent();
    while let Some(d) = dir {
        if d == root || std::fs::remove_dir(d).is_err() {
            break;
        }
        dir = d.parent();
    }
    Ok(())
}

fn is_text(rel: &str, bytes: &[u8]) -> bool {
    !rel.ends_with(".age") && !bytes.contains(&0) && std::str::from_utf8(bytes).is_ok()
}

fn conflict_path(rel: &str) -> String {
    let stamp = Local::now().format("%Y-%m-%d %H%M");
    let (dir, name) = rel.rsplit_once('/').map(|(d, n)| (format!("{d}/"), n)).unwrap_or((String::new(), rel));
    // Keep compound extensions like `.md.age` intact.
    let (stem, ext) = match name.find('.') {
        Some(i) if i > 0 => (&name[..i], &name[i..]),
        _ => (name, ""),
    };
    format!("{dir}{stem} (conflict {stamp}){ext}")
}

fn untar(bytes: &[u8], wanted: Option<&HashSet<String>>) -> Result<HashMap<String, Vec<u8>>> {
    let mut out = HashMap::new();
    let mut archive = tar::Archive::new(flate2::read::GzDecoder::new(bytes));
    for entry in archive.entries()? {
        let mut entry = entry?;
        if !entry.header().entry_type().is_file() {
            continue;
        }
        let path = entry.path()?.to_string_lossy().to_string();
        // GitHub wraps everything in an `owner-repo-sha/` folder.
        let Some((_, rel)) = path.split_once('/') else { continue };
        if wanted.is_some_and(|w| !w.contains(rel)) {
            continue;
        }
        let mut buf = Vec::new();
        entry.read_to_end(&mut buf)?;
        out.insert(rel.to_string(), buf);
    }
    Ok(out)
}

async fn fetch_many(gh: &GitHub, t: &Target, head: &str, items: &[(String, String)]) -> Result<HashMap<String, Vec<u8>>> {
    if items.len() > TARBALL_THRESHOLD {
        let wanted: HashSet<String> = items.iter().map(|(p, _)| p.clone()).collect();
        return untar(&gh.tarball(&t.owner, &t.repo, head).await?, Some(&wanted));
    }
    stream::iter(items.iter().cloned())
        .map(|(path, sha)| async move { gh.blob(&t.owner, &t.repo, &sha).await.map(|b| (path, b)) })
        .buffer_unordered(8)
        .try_collect()
        .await
}

pub async fn sync(gh: &GitHub, t: &Target, p: &Paths, ctl: &Ctl) -> Result<SyncReport> {
    let mut state = load_state(p);
    for _ in 0..4 {
        let outcome = sync_once(gh, t, p, &mut state, ctl).await;
        save_state(p, &state)?;
        if let Some(report) = outcome? {
            return Ok(report);
        }
    }
    Err(msg("GitHub kept changing while syncing. Try again in a minute."))
}

/// `Ok(None)` means the branch moved under us; the caller runs it again.
async fn sync_once(gh: &GitHub, t: &Target, p: &Paths, state: &mut SyncState, ctl: &Ctl) -> Result<Option<SyncReport>> {
    let mut report = SyncReport::default();
    (ctl.progress)("checking", 0, 0);
    let Some(remote_head) = gh.head(&t.owner, &t.repo, &t.branch).await? else {
        gh.put_file(&t.owner, &t.repo, &t.branch, "Welcome.md", WELCOME.as_bytes(), "Start Wandika vault")
            .await?;
        return Ok(None);
    };
    let tree_sha = gh.commit_tree(&t.owner, &t.repo, &remote_head).await?;
    let ignored = Ignored::load(&p.files);

    // First sync on this device: clone with one tarball, keeping anything already on disk. A local
    // vault being connected to a repository lands here too; where both sides have a different file
    // at the same path, the GitHub version is kept beside the local one.
    if state.head.is_none() {
        let tree = gh.tree(&t.owner, &t.repo, &tree_sha).await?;
        (ctl.progress)("downloading", 0, 0);
        let files = untar(&gh.tarball(&t.owner, &t.repo, &remote_head).await?, None)?;
        ctl.check()?;
        let (local, _) = scan(&p.files, &BTreeMap::new(), &ignored)?;
        let mut remote = BTreeMap::new();
        for e in tree.iter().filter(|e| e.kind == "blob" && e.mode != "120000" && !ignored.file(&e.path)) {
            remote.insert(e.path.clone(), e.sha.clone());
            if let Some(local_sha) = local.get(&e.path) {
                if local_sha != &e.sha
                    && let Some(bytes) = files.get(&e.path)
                {
                    let copy = conflict_path(&e.path);
                    vault::write_atomic(&vault::safe(&p.files, &copy)?, bytes)?;
                    report.conflicts.push(copy);
                }
                continue;
            }
            if let Some(bytes) = files.get(&e.path) {
                vault::write_atomic(&vault::safe(&p.files, &e.path)?, bytes)?;
                report.pulled.push(e.path.clone());
            }
        }
        state.files = remote;
        state.head = Some(remote_head.clone());
        let (_, stat) = scan(&p.files, &state.stat, &ignored)?;
        state.stat = stat;
        // Files that were already on disk get compared and pushed on the next pass.
        if local.is_empty() {
            report.head = Some(remote_head);
            report.at = Local::now().timestamp_millis();
            state.last_sync = Some(report.at);
            return Ok(Some(report));
        }
    }

    let base = state.files.clone();
    let (local, stat) = scan(&p.files, &state.stat, &ignored)?;
    state.stat = stat;
    let remote_moved = state.head.as_deref() != Some(remote_head.as_str());
    if !remote_moved && local == base {
        report.head = Some(remote_head);
        report.at = Local::now().timestamp_millis();
        state.last_sync = Some(report.at);
        return Ok(Some(report));
    }

    let tree = gh.tree(&t.owner, &t.repo, &tree_sha).await?;
    let mut remote = BTreeMap::new();
    let mut modes = HashMap::new();
    for e in tree.iter().filter(|e| e.kind == "blob" && e.mode != "120000" && !ignored.file(&e.path)) {
        remote.insert(e.path.clone(), e.sha.clone());
        modes.insert(e.path.clone(), e.mode.clone());
    }

    let local_changes = changed(&local, &base);
    let remote_changes = changed(&remote, &base);
    let mut downloads = Vec::new();
    let mut both = Vec::new();
    for path in &remote_changes {
        let (l, r) = (local.get(path), remote.get(path));
        if !local_changes.contains(path) {
            match r {
                Some(sha) => downloads.push((path.clone(), sha.clone())),
                None => {
                    remove_local(&p.files, path)?;
                    report.removed.push(path.clone());
                }
            }
        } else if l != r {
            match (l, r) {
                // Deleted here, edited there: keep the edit.
                (None, Some(sha)) => downloads.push((path.clone(), sha.clone())),
                // Edited here, deleted there: keep the edit; it is pushed back below.
                (Some(_), None) => {}
                (Some(_), Some(sha)) => both.push((path.clone(), sha.clone())),
                (None, None) => {}
            }
        }
    }

    if !downloads.is_empty() {
        (ctl.progress)("downloading", 0, downloads.len());
    }
    for (path, bytes) in fetch_many(gh, t, &remote_head, &downloads).await? {
        vault::write_atomic(&vault::safe(&p.files, &path)?, &bytes)?;
        report.pulled.push(path);
    }

    for (path, remote_sha) in both {
        let remote_bytes = gh.blob(&t.owner, &t.repo, &remote_sha).await?;
        let local_path = vault::safe(&p.files, &path)?;
        let local_bytes = std::fs::read(&local_path)?;
        let merged = if is_text(&path, &local_bytes) && is_text(&path, &remote_bytes) {
            let base_text = match base.get(&path) {
                Some(sha) => String::from_utf8(gh.blob(&t.owner, &t.repo, sha).await?).unwrap_or_default(),
                None => String::new(),
            };
            diffy::merge(
                &base_text,
                std::str::from_utf8(&local_bytes).unwrap(),
                std::str::from_utf8(&remote_bytes).unwrap(),
            )
            .ok()
        } else {
            None
        };
        match merged {
            Some(text) => {
                vault::write_atomic(&local_path, text.as_bytes())?;
                report.merged.push(path);
            }
            None => {
                let copy = conflict_path(&path);
                vault::write_atomic(&vault::safe(&p.files, &copy)?, &remote_bytes)?;
                report.conflicts.push(copy);
            }
        }
    }

    let (final_local, stat) = scan(&p.files, &state.stat, &ignored)?;
    report.vault_bytes = stat.values().map(|s| s.size).sum();
    state.stat = stat;
    // Everything pulled so far is now part of the base, even if the push below has to retry.
    for path in &report.pulled {
        if let Some(sha) = remote.get(path) {
            state.files.insert(path.clone(), sha.clone());
        }
    }
    for path in &report.removed {
        state.files.remove(path);
    }

    let mut entries = Vec::new();
    let mut uploads = Vec::new();
    let mut pushed_files = final_local.clone();
    for (path, sha) in &final_local {
        if remote.get(path) == Some(sha) {
            continue;
        }
        let too_big = std::fs::metadata(vault::safe(&p.files, path)?).is_ok_and(|m| m.len() > MAX_FILE);
        if too_big {
            // Stays on this device only; leaving it out of the base keeps it from being deleted later.
            pushed_files.remove(path);
            report.too_big.push(path.clone());
        } else {
            uploads.push(path.clone());
        }
    }
    // Small text files (notes) travel inside the tree requests; images and other files are
    // uploaded one by one first. Nothing on GitHub changes until the commit at the end, so a
    // stopped sync leaves the branch as it was.
    ctl.check()?;
    let done = std::sync::atomic::AtomicUsize::new(0);
    let mut inline: Vec<(String, String)> = Vec::new();
    let mut binary: Vec<String> = Vec::new();
    for path in uploads {
        let bytes = std::fs::read(vault::safe(&p.files, &path)?)?;
        match String::from_utf8(bytes) {
            Ok(text) if text.len() <= INLINE_MAX => inline.push((path, text)),
            _ => binary.push(path),
        }
    }
    // GitHub allows about 450 new files an hour from us (see github.rs). A first sync with
    // thousands of images sends what fits now, saves it, and the rest goes up on later syncs.
    let inline_bytes: usize = inline.iter().map(|(_, t)| t.len()).sum();
    let reserved = inline_bytes / TREE_BATCH_BYTES + 4;
    let room = crate::github::writes_left_this_hour().saturating_sub(reserved);
    // Smallest first, so the most files arrive in each step.
    let size_of = |path: &String| std::fs::metadata(vault::safe(&p.files, path).unwrap_or_default()).map(|m| m.len()).unwrap_or(0);
    binary.sort_by_key(size_of);
    let mut bytes = inline_bytes as u64;
    let mut fits = 0;
    for path in &binary {
        let size = size_of(path);
        if fits >= room || (bytes + size > BYTES_PER_SYNC && fits > 0) {
            break;
        }
        bytes += size;
        fits += 1;
    }
    for path in binary.split_off(fits) {
        pushed_files.remove(&path);
        report.waiting += 1;
    }
    let total = inline.len() + binary.len();
    let tick = |n: usize| (ctl.progress)("uploading", n, total);
    let created: Vec<(String, String)> = stream::iter(binary)
        .map(|path| {
            let (done, tick) = (&done, &tick);
            async move {
                ctl.check()?;
                let bytes = std::fs::read(vault::safe(&p.files, &path)?)?;
                let sha = gh.create_blob(&t.owner, &t.repo, &bytes).await?;
                tick(done.fetch_add(1, std::sync::atomic::Ordering::Relaxed) + 1);
                Ok::<_, crate::error::Error>((path, sha))
            }
        })
        .buffer_unordered(8)
        .try_collect()
        .await?;
    for (path, sha) in &created {
        let mode = modes.get(path).cloned().unwrap_or_else(|| "100644".into());
        entries.push(json!({ "path": path, "mode": mode, "type": "blob", "sha": sha }));
        pushed_files.insert(path.clone(), sha.clone());
        report.pushed.push(path.clone());
    }
    let mut inline_entries: Vec<(usize, Value)> = Vec::new();
    for (path, text) in inline {
        let mode = modes.get(&path).cloned().unwrap_or_else(|| "100644".into());
        pushed_files.insert(path.clone(), blob_sha(text.as_bytes()));
        inline_entries.push((text.len(), json!({ "path": path, "mode": mode, "type": "blob", "content": text })));
        report.pushed.push(path);
    }
    for (path, mode) in &modes {
        if remote.contains_key(path) && !final_local.contains_key(path) {
            entries.push(json!({ "path": path, "mode": mode, "type": "blob", "sha": null }));
            report.pushed.push(path.clone());
        }
    }

    if entries.is_empty() && inline_entries.is_empty() {
        state.head = Some(remote_head.clone());
        state.files = pushed_files;
    } else {
        // Trees are chained in batches, each built on the last, so a big first sync stays within
        // GitHub's request size.
        let mut new_tree = tree_sha.clone();
        let mut batch = entries;
        let mut size = 0;
        let mut sent = done.load(std::sync::atomic::Ordering::Relaxed);
        for (len, entry) in inline_entries {
            if size + len > TREE_BATCH_BYTES && !batch.is_empty() {
                ctl.check()?;
                new_tree = gh.create_tree(&t.owner, &t.repo, &new_tree, std::mem::take(&mut batch)).await?;
                tick(sent);
                size = 0;
            }
            size += len;
            sent += 1;
            batch.push(entry);
        }
        if !batch.is_empty() {
            ctl.check()?;
            new_tree = gh.create_tree(&t.owner, &t.repo, &new_tree, batch).await?;
        }
        tick(total);
        (ctl.progress)("saving", 0, 0);
        let n = report.pushed.len();
        let message = format!(
            "Update {n} {} from Wandika on {}",
            if n == 1 { "file" } else { "files" },
            std::env::consts::OS
        );
        let commit = gh.create_commit(&t.owner, &t.repo, &message, &new_tree, &remote_head).await?;
        if !gh.update_ref(&t.owner, &t.repo, &t.branch, &commit).await? {
            return Ok(None);
        }
        state.head = Some(commit.clone());
        state.files = pushed_files;
    }
    report.head = state.head.clone();
    report.at = Local::now().timestamp_millis();
    state.last_sync = Some(report.at);
    Ok(Some(report))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn follows_the_vault_gitignore_and_skips_device_state() {
        let root = std::env::temp_dir().join(format!("wandika-ignore-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&root);
        std::fs::create_dir_all(root.join(".smart-env/multi")).unwrap();
        std::fs::create_dir_all(root.join(".obsidian")).unwrap();
        std::fs::create_dir_all(root.join("05_Visuals/Images")).unwrap();
        std::fs::write(root.join(".gitignore"), ".smart-env/\n05_Visuals/Images/*.gif\n").unwrap();
        for f in [".smart-env/multi/a.ajson", ".obsidian/workspace.json", ".obsidian/app.json", "05_Visuals/Images/big.gif", "05_Visuals/Images/ok.png", "Note.md", ".DS_Store"] {
            std::fs::write(root.join(f), f).unwrap();
        }
        let ignored = Ignored::load(&root);
        let (files, _) = scan(&root, &BTreeMap::new(), &ignored).unwrap();
        let names: Vec<&str> = files.keys().map(String::as_str).collect();
        assert_eq!(names, [".gitignore", ".obsidian/app.json", "05_Visuals/Images/ok.png", "Note.md"]);
        assert!(ignored.file(".smart-env/multi/a.ajson"), "remote files under an ignored folder are left alone too");
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn conflict_names_keep_extensions() {
        let c = conflict_path("Private/Diary.md.age");
        assert!(c.starts_with("Private/Diary (conflict "));
        assert!(c.ends_with(").md.age"));
        assert!(conflict_path("Plan.md").ends_with(").md"));
    }

    #[test]
    fn blob_sha_matches_git() {
        // `printf 'hello\n' | git hash-object --stdin`
        assert_eq!(blob_sha(b"hello\n"), "ce013625030ba8dba906f756967f9e9ca394464a");
    }

    #[test]
    fn merges_edits_to_different_lines() {
        let base = "a\nb\nc\n";
        let ours = "A\nb\nc\n";
        let theirs = "a\nb\nC\n";
        assert_eq!(diffy::merge(base, ours, theirs).unwrap(), "A\nb\nC\n");
    }
}
