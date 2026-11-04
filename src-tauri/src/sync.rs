//! Sync is git. Every vault has a real repository on the device (libgit2, built into the app), kept
//! in Wandika's own storage so the vault folder gets no `.git` of ours. One sync:
//!
//! 1. **Commit** what changed here since the last sync. `.gitignore` and per-device files are left
//!    out, files over 50 MB stay on this device, iCloud placeholders count as unchanged, and a sync
//!    that would delete many files at once holds the deletions until you confirm them.
//! 2. **Fetch** GitHub's branch: one small exchange when nothing changed, new objects otherwise.
//! 3. **Merge** both sides. Line edits on both sides merge; where the same lines changed, or a file
//!    can't merge, this device's version stays and the other is kept beside it as
//!    "Name (conflict 2026-11-03 0930).md". An edit beats a deletion. Nothing is lost.
//! 4. **Push** fast-forward only, in parts of at most 100 MB, at most one push every 10 seconds.
//!    If GitHub moved meanwhile, fetch, merge and push again.
//!
//! Git's own transfer is used for files, not one API request per file, so a sync of any size stays
//! inside GitHub's API limits; pushes stay under its recommended 6 a minute and 2 GB each.

use crate::error::{msg, Error, Result};
use chrono::Local;
use git2::build::{CheckoutBuilder, TreeUpdateBuilder};
use git2::{
    Cred, Delta, FetchOptions, FileMode, IndexAddOption, Oid, PushOptions, RemoteCallbacks, Repository,
    RepositoryInitOptions, Signature, Tree,
};
use serde::{Deserialize, Serialize};
use std::collections::BTreeSet;
use std::path::{Path, PathBuf};
use std::time::Duration;

/// Larger files stay on the device they were added on; GitHub warns at 50 MB and refuses 100 MB.
const MAX_FILE: u64 = 50 * 1024 * 1024;
/// Largest push. A bigger change goes up as a chain of commits, each sent on its own.
const PUSH_BYTES: u64 = if cfg!(test) { 1000 } else { 100 * 1024 * 1024 };
/// Between the parts of a big upload: GitHub recommends at most 6 pushes a minute per repository.
const PUSH_GAP: Duration = Duration::from_secs(if cfg!(test) { 0 } else { 10 });
/// A sync that would delete more than this many files, and more than a fifth of the vault, waits
/// for you to confirm: an emptied or moved folder must not empty the vault on every device.
const HOLD_DELETES_OVER: usize = 25;

/// Files only one device cares about. Added to git's own exclude list, beside the vault's
/// `.gitignore`.
const DEVICE_FILES: &[&str] = &[
    ".git",
    ".DS_Store",
    ".obsidian/workspace.json",
    ".obsidian/workspace-mobile.json",
    "*.wandika-tmp",
    // iCloud's stand-in for a file it moved off this Mac to save space.
    ".*.icloud",
];

const WELCOME: &str = "# Welcome to Wandika\n\nThis repository is your notes vault. Every note is a Markdown file, so it also opens in Obsidian.\n\n- [ ] Write your first note\n";

#[derive(Serialize, Deserialize, Clone)]
pub struct Target {
    pub owner: String,
    pub repo: String,
    pub branch: String,
}

#[derive(Serialize, Deserialize, Clone, Default)]
pub struct SyncState {
    pub last_sync: Option<i64>,
    /// Set by "Delete them on GitHub too": the next sync may delete many files at once.
    #[serde(default)]
    pub confirm_deletions: bool,
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
    /// Missing here but kept on GitHub until you confirm (see HOLD_DELETES_OVER).
    pub held_deletions: Vec<String>,
    /// Everything that syncs, in bytes, to compare with GitHub's 1 GB recommendation.
    pub vault_bytes: u64,
    pub head: Option<String>,
    pub at: i64,
}

/// (phase, done, total): "checking", "downloading", "uploading", "saving".
pub type Progress = Box<dyn Fn(&str, usize, usize) + Send + Sync>;

/// What a running sync tells the interface, and how it is asked to stop.
pub struct Ctl {
    pub cancel: std::sync::Arc<std::sync::atomic::AtomicBool>,
    pub progress: Progress,
}

impl Ctl {
    fn stopped(&self) -> bool {
        self.cancel.load(std::sync::atomic::Ordering::Relaxed)
    }
    fn check(&self) -> Result<()> {
        if self.stopped() {
            return Err(Error::Cancelled);
        }
        Ok(())
    }
}

pub struct Paths {
    /// The vault's files: a folder chosen on the Mac, or Wandika's storage.
    pub files: PathBuf,
    pub state: PathBuf,
    /// The repository, kept apart from the vault folder.
    pub git: PathBuf,
}

/// Who commits, and how to reach GitHub.
pub struct Remote {
    pub url: String,
    pub token: String,
    pub branch: String,
    pub author: String,
    pub email: String,
    /// "macos", "ios", "android": shown in commit messages.
    pub device: String,
}

impl From<git2::Error> for Error {
    fn from(e: git2::Error) -> Self {
        let m = e.message().to_lowercase();
        if e.code() == git2::ErrorCode::User {
            return Error::Cancelled;
        }
        if e.code() == git2::ErrorCode::Auth || m.contains("401") || m.contains("authentication") {
            return crate::error::Error::GitHubSignIn;
        }
        if m.contains("403") || m.contains("permission") {
            return msg("GitHub didn't let this account write to the repository. Check you can push to it.");
        }
        if ["resolve", "timed out", "network", "could not connect", "unreachable", "offline"].iter().any(|w| m.contains(w)) {
            return Error::Offline;
        }
        Error::Git(e.message().to_string())
    }
}

pub fn load_state(p: &Paths) -> SyncState {
    std::fs::read(&p.state).ok().and_then(|b| serde_json::from_slice(&b).ok()).unwrap_or_default()
}

pub fn save_state(p: &Paths, s: &SyncState) -> Result<()> {
    crate::vault::write_atomic(&p.state, &serde_json::to_vec(s)?)
}

/// Opens the vault's repository, or makes one, pointing at the vault folder and at GitHub.
fn open(p: &Paths, remote: &Remote) -> Result<Repository> {
    std::fs::create_dir_all(&p.files)?;
    let repo = if p.git.join("HEAD").exists() {
        Repository::open(&p.git)?
    } else {
        // Made without a working folder, which is set below: made with one, libgit2 writes a
        // `.git` link file into the vault folder (and fails when the folder is a git repo itself).
        let mut opts = RepositoryInitOptions::new();
        opts.bare(true).initial_head(&remote.branch).mkpath(true);
        Repository::init_opts(&p.git, &opts)?
    };
    // A folder vault can move; follow it.
    repo.set_workdir(&p.files, false)?;
    remove_old_link(p);
    std::fs::create_dir_all(p.git.join("info"))?;
    std::fs::write(p.git.join("info/exclude"), DEVICE_FILES.join("\n") + "\n")?;
    match repo.find_remote("origin") {
        Ok(r) if r.url() == Some(remote.url.as_str()) => {}
        Ok(_) => repo.remote_set_url("origin", &remote.url)?,
        Err(_) => {
            repo.remote("origin", &remote.url)?;
        }
    }
    let mut cfg = repo.config()?;
    // Notes keep their line endings exactly as written, on every platform.
    cfg.set_bool("core.autocrlf", false)?;
    cfg.set_bool("core.precomposeunicode", true)?;
    Ok(repo)
}

/// Earlier versions left a `.git` link file in the vault folder, pointing at this repository.
fn remove_old_link(p: &Paths) {
    let link = p.files.join(".git");
    let ours = |text: String| {
        let dir = text.trim().strip_prefix("gitdir:").map(|d| PathBuf::from(d.trim()));
        dir.and_then(|d| d.canonicalize().ok()) == p.git.canonicalize().ok()
    };
    if link.is_file() && std::fs::read_to_string(&link).is_ok_and(ours) {
        let _ = std::fs::remove_file(link);
    }
}

fn callbacks<'a>(remote: &'a Remote, ctl: &'a Ctl, phase: &'static str) -> RemoteCallbacks<'a> {
    let mut cb = RemoteCallbacks::new();
    cb.credentials(move |_, _, _| Cred::userpass_plaintext(&remote.token, "x-oauth-basic"));
    cb.transfer_progress(move |p| {
        (ctl.progress)(phase, p.received_objects(), p.total_objects());
        !ctl.stopped()
    });
    cb.push_transfer_progress(move |done, total, _| (ctl.progress)("uploading", done, total));
    cb
}

/// Fetches the branch and returns GitHub's commit, None for an empty repository. When nothing
/// changed this is one small exchange; only new objects are downloaded.
fn fetch(repo: &Repository, remote: &Remote, ctl: &Ctl) -> Result<Option<Oid>> {
    let mut origin = repo.find_remote("origin")?;
    let refspec = format!("+refs/heads/{0}:refs/remotes/origin/{0}", remote.branch);
    let mut opts = FetchOptions::new();
    opts.remote_callbacks(callbacks(remote, ctl, "downloading")).prune(git2::FetchPrune::On);
    origin.fetch(&[refspec.as_str()], Some(&mut opts), None)?;
    Ok(repo.refname_to_id(&format!("refs/remotes/origin/{}", remote.branch)).ok())
}

/// Pushes `commit` to the branch. False when GitHub moved meanwhile (not a fast-forward).
fn push(repo: &Repository, remote: &Remote, ctl: &Ctl, commit: Oid) -> Result<bool> {
    let tmp = "refs/wandika/push";
    repo.reference(tmp, commit, true, "push")?;
    let mut origin = repo.find_remote("origin")?;
    let rejected = std::cell::Cell::new(false);
    let mut cb = callbacks(remote, ctl, "uploading");
    cb.push_update_reference(|_, status| {
        if status.is_some() {
            rejected.set(true);
        }
        Ok(())
    });
    let mut opts = PushOptions::new();
    opts.remote_callbacks(cb);
    let spec = format!("{tmp}:refs/heads/{}", remote.branch);
    let result = origin.push(&[spec.as_str()], Some(&mut opts));
    let _ = repo.find_reference(tmp).and_then(|mut r| r.delete());
    match result {
        Ok(()) => Ok(!rejected.get()),
        Err(e) if e.code() == git2::ErrorCode::NotFastForward => Ok(false),
        Err(e) => Err(e.into()),
    }
}

fn head_commit(repo: &Repository) -> Option<Oid> {
    repo.head().ok().and_then(|h| h.target())
}

fn empty_tree(repo: &Repository) -> Result<Tree<'_>> {
    Ok(repo.find_tree(repo.treebuilder(None)?.write()?)?)
}

fn sig(remote: &Remote) -> Result<Signature<'static>> {
    Ok(Signature::now(&remote.author, &remote.email)?)
}

/// Step 1: what changed here becomes a commit on the local branch. Returns the paths it changed.
fn commit_local(repo: &Repository, p: &Paths, remote: &Remote, state: &SyncState, report: &mut SyncReport) -> Result<Vec<String>> {
    let mut index = repo.index()?;
    let root = &p.files;
    let mut too_big = Vec::new();

    // Files that are tracked but gone from the folder.
    let tracked: Vec<String> = index.iter().map(|e| String::from_utf8_lossy(&e.path).into_owned()).collect();
    // iCloud moved it off this Mac: it still exists, unchanged.
    let placeholder = |rel: &str| {
        let path = Path::new(rel);
        let name = path.file_name().and_then(|n| n.to_str()).unwrap_or("");
        root.join(path.with_file_name(format!(".{name}.icloud"))).exists()
    };
    let deletions: BTreeSet<String> =
        tracked.iter().filter(|r| !root.join(r).exists() && !placeholder(r)).cloned().collect();
    let hold = !state.confirm_deletions
        && deletions.len() > HOLD_DELETES_OVER
        && deletions.len() * 5 > tracked.len().max(1);
    if hold {
        report.held_deletions = deletions.iter().cloned().collect();
    }

    let device_file = |rel: &str| rel.starts_with(".obsidian/workspace") || rel.ends_with(".DS_Store");
    index.add_all(
        ["*"],
        IndexAddOption::DEFAULT,
        Some(&mut |path: &Path, _: &[u8]| {
            let rel = path.to_string_lossy();
            // add_all also removes tracked files that are gone, so the same holds apply here.
            if device_file(&rel) || (!root.join(path).exists() && (hold || placeholder(&rel))) {
                return 1;
            }
            let size = std::fs::metadata(root.join(path)).map(|m| m.len()).unwrap_or(0);
            if size > MAX_FILE {
                too_big.push(rel.into_owned());
                return 1;
            }
            0
        }),
    )?;
    index.update_all(
        ["*"],
        Some(&mut |path: &Path, _: &[u8]| {
            let rel = path.to_string_lossy();
            if device_file(&rel) || (!root.join(path).exists() && (hold || placeholder(&rel))) {
                return 1;
            }
            0
        }),
    )?;
    index.write()?;
    report.too_big = too_big;
    report.vault_bytes = index.iter().map(|e| e.file_size as u64).sum();

    let tree = repo.find_tree(index.write_tree()?)?;
    let parent = head_commit(repo).map(|h| repo.find_commit(h)).transpose()?;
    if parent.as_ref().is_some_and(|c| c.tree_id() == tree.id()) {
        return Ok(Vec::new());
    }
    let parent_tree = parent.as_ref().map(|c| c.tree()).transpose()?;
    let changed = changed_paths(repo, parent_tree.as_ref(), &tree)?;
    if changed.is_empty() {
        return Ok(Vec::new());
    }
    let n = changed.len();
    let message = format!("Update {n} {} from Wandika on {}", if n == 1 { "file" } else { "files" }, remote.device);
    let s = sig(remote)?;
    let parents: Vec<&git2::Commit> = parent.iter().collect();
    repo.commit(Some("HEAD"), &s, &s, &message, &tree, &parents)?;
    Ok(changed)
}

fn changed_paths(repo: &Repository, from: Option<&Tree>, to: &Tree) -> Result<Vec<String>> {
    let empty;
    let from = match from {
        Some(t) => t,
        None => {
            empty = empty_tree(repo)?;
            &empty
        }
    };
    let diff = repo.diff_tree_to_tree(Some(from), Some(to), None)?;
    Ok(diff
        .deltas()
        .filter_map(|d| d.new_file().path().or(d.old_file().path()).map(|p| p.to_string_lossy().into_owned()))
        .collect())
}

/// Step 3: brings GitHub's commit into the local branch and the folder. Returns the new head.
fn integrate(repo: &Repository, remote: &Remote, theirs: Oid, report: &mut SyncReport) -> Result<Oid> {
    let theirs_commit = repo.find_commit(theirs)?;
    let Some(ours) = head_commit(repo) else {
        // A new device: take GitHub's files as they are.
        checkout(repo, &theirs_commit.tree()?)?;
        set_branch(repo, remote, theirs)?;
        report.pulled = changed_paths(repo, None, &theirs_commit.tree()?)?;
        return Ok(theirs);
    };
    if ours == theirs || repo.graph_descendant_of(ours, theirs)? {
        return Ok(ours);
    }
    let ours_commit = repo.find_commit(ours)?;
    if repo.graph_descendant_of(theirs, ours)? {
        // Only GitHub moved: fast-forward.
        report.pulled = changed_paths(repo, Some(&ours_commit.tree()?), &theirs_commit.tree()?)?;
        checkout(repo, &theirs_commit.tree()?)?;
        set_branch(repo, remote, theirs)?;
        return Ok(theirs);
    }

    // Both moved (or, connecting a vault, two separate histories): a three-way merge.
    let base = match repo.merge_base(ours, theirs) {
        Ok(b) => repo.find_commit(b)?.tree()?,
        Err(_) => empty_tree(repo)?,
    };
    let mut merged = repo.merge_trees(&base, &ours_commit.tree()?, &theirs_commit.tree()?, None)?;
    let conflicts: Vec<git2::IndexConflict> = merged.conflicts()?.collect::<std::result::Result<_, _>>()?;
    let stamp = Local::now().format("%Y-%m-%d %H%M").to_string();
    for c in conflicts {
        let path_of = |e: &Option<git2::IndexEntry>| e.as_ref().map(|e| String::from_utf8_lossy(&e.path).into_owned());
        let path = path_of(&c.our).or(path_of(&c.their)).or(path_of(&c.ancestor)).unwrap_or_default();
        merged.conflict_remove(Path::new(&path))?;
        match (c.our, c.their) {
            // Changed on both sides: this device's version stays; the other is kept beside it.
            (Some(our), Some(their)) => {
                merged.add(&stage0(our, &path))?;
                let copy = conflict_path(&path, &stamp);
                merged.add(&stage0(their, &copy))?;
                report.conflicts.push(copy);
            }
            // An edit beats a deletion, from either side.
            (Some(our), None) => merged.add(&stage0(our, &path))?,
            (None, Some(their)) => merged.add(&stage0(their, &path))?,
            (None, None) => {}
        }
    }
    let tree = repo.find_tree(merged.write_tree_to(repo)?)?;
    report.pulled = changed_paths(repo, Some(&ours_commit.tree()?), &tree)?;
    report.merged = report.pulled.clone();
    let s = sig(remote)?;
    let message = format!("Merge changes from other devices on {}", remote.device);
    let commit = repo.commit(None, &s, &s, &message, &tree, &[&ours_commit, &theirs_commit])?;
    checkout(repo, &tree)?;
    set_branch(repo, remote, commit)?;
    Ok(commit)
}

fn stage0(mut e: git2::IndexEntry, path: &str) -> git2::IndexEntry {
    e.path = path.as_bytes().to_vec();
    // Stage 0 (resolved), and the path length git keeps in the low bits.
    e.flags = path.len().min(0xFFF) as u16;
    e
}

/// Updates the folder from the current commit (HEAD) to `tree`. Files changed here since that
/// commit (you typing during a sync) are left alone; the next sync takes them in.
fn checkout(repo: &Repository, tree: &Tree) -> Result<()> {
    let mut b = CheckoutBuilder::new();
    b.safe().allow_conflicts(true).recreate_missing(true);
    repo.checkout_tree(tree.as_object(), Some(&mut b))?;
    Ok(())
}

fn set_branch(repo: &Repository, remote: &Remote, commit: Oid) -> Result<()> {
    let name = format!("refs/heads/{}", remote.branch);
    repo.reference(&name, commit, true, "sync")?;
    repo.set_head(&name)?;
    // The index follows the new commit; the folder already does.
    let mut index = repo.index()?;
    index.read_tree(&repo.find_commit(commit)?.tree()?)?;
    index.write()?;
    Ok(())
}

type Change = (String, Option<(Oid, FileMode)>, u64);

/// Step 4: pushes the local branch. A change bigger than PUSH_BYTES goes up as a chain of commits
/// on top of GitHub's, each under PUSH_BYTES, pushed in turn; the last has the same files as the
/// local branch, which then points at it. False when GitHub moved meanwhile.
fn push_sized(repo: &Repository, remote: &Remote, ctl: &Ctl, theirs: Option<Oid>, ours: Oid, report: &mut SyncReport) -> Result<bool> {
    let ours_tree = repo.find_commit(ours)?.tree()?;
    let theirs_tree = match theirs {
        Some(t) => repo.find_commit(t)?.tree()?,
        None => empty_tree(repo)?,
    };
    let diff = repo.diff_tree_to_tree(Some(&theirs_tree), Some(&ours_tree), None)?;
    let odb = repo.odb()?;
    let mut changes: Vec<Change> = Vec::new();
    for d in diff.deltas() {
        let path = d.new_file().path().or(d.old_file().path()).map(|p| p.to_string_lossy().into_owned()).unwrap_or_default();
        if d.status() == Delta::Deleted {
            changes.push((path, None, 0));
        } else {
            let id = d.new_file().id();
            let size = odb.read_header(id).map(|(s, _)| s as u64).unwrap_or(0);
            let mode = if d.new_file().mode() == FileMode::BlobExecutable { FileMode::BlobExecutable } else { FileMode::Blob };
            changes.push((path, Some((id, mode)), size));
        }
    }
    report.pushed = changes.iter().map(|c| c.0.clone()).collect();
    let total: u64 = changes.iter().map(|c| c.2).sum();
    if total <= PUSH_BYTES {
        ctl.check()?;
        return push(repo, remote, ctl, ours);
    }

    // Deletions first, then the smallest files, so most of the vault arrives early.
    changes.sort_by_key(|c| (c.1.is_some(), c.2));
    let mut parts: Vec<Vec<&Change>> = vec![Vec::new()];
    let mut size = 0;
    for c in &changes {
        if size + c.2 > PUSH_BYTES && !parts.last().is_some_and(|p| p.is_empty()) {
            parts.push(Vec::new());
            size = 0;
        }
        size += c.2;
        parts.last_mut().expect("one part").push(c);
    }
    let s = sig(remote)?;
    let mut parent = theirs.map(|t| repo.find_commit(t)).transpose()?;
    let mut tree = theirs_tree;
    let mut sent = 0;
    let n = parts.len();
    for (i, part) in parts.into_iter().enumerate() {
        ctl.check()?;
        let mut b = TreeUpdateBuilder::new();
        for (path, blob, _) in &part {
            match blob {
                Some((id, mode)) => b.upsert(path.as_str(), *id, *mode),
                None => b.remove(path.as_str()),
            };
        }
        tree = repo.find_tree(b.create_updated(repo, &tree)?)?;
        let message = format!("Add files from Wandika on {} (part {} of {n})", remote.device, i + 1);
        let parents: Vec<&git2::Commit> = parent.iter().collect();
        let commit = repo.commit(None, &s, &s, &message, &tree, &parents)?;
        if !push(repo, remote, ctl, commit)? {
            return Ok(false);
        }
        sent += part.len();
        (ctl.progress)("uploading", sent, changes.len());
        repo.reference(&format!("refs/remotes/origin/{}", remote.branch), commit, true, "pushed part")?;
        parent = Some(repo.find_commit(commit)?);
        if i + 1 < n {
            std::thread::sleep(PUSH_GAP);
        }
    }
    // The chain ends with exactly the local files; the local branch takes it over.
    if let Some(last) = parent.filter(|_| tree.id() == ours_tree.id()) {
        set_branch(repo, remote, last.id())?;
    }
    Ok(true)
}

/// One full sync. Blocking: run it off the async runtime.
pub fn sync(p: &Paths, remote: &Remote, ctl: &Ctl) -> Result<SyncReport> {
    let mut state = load_state(p);
    let repo = open(p, remote)?;
    let mut report = SyncReport::default();
    (ctl.progress)("checking", 0, 0);

    for _ in 0..4 {
        ctl.check()?;
        commit_local(&repo, p, remote, &state, &mut report)?;
        let theirs = fetch(&repo, remote, ctl)?;

        let mut ours = head_commit(&repo);
        if let Some(t) = theirs {
            ours = Some(integrate(&repo, remote, t, &mut report)?);
        } else if ours.is_none() {
            // An empty repository and an empty vault: start both with the Welcome note.
            std::fs::write(p.files.join("Welcome.md"), WELCOME)?;
            commit_local(&repo, p, remote, &state, &mut report)?;
            ours = head_commit(&repo);
        }

        let Some(ours) = ours else { break };
        if theirs == Some(ours) || theirs.is_some_and(|t| repo.graph_descendant_of(t, ours).unwrap_or(false)) {
            break;
        }
        if push_sized(&repo, remote, ctl, theirs, ours, &mut report)? {
            let head = head_commit(&repo).unwrap_or(ours);
            repo.reference(&format!("refs/remotes/origin/{}", remote.branch), head, true, "pushed")?;
            break;
        }
        // GitHub moved while we were pushing: go round again.
    }
    (ctl.progress)("saving", 0, 0);
    state.confirm_deletions = false;
    report.removed = report.pulled.iter().filter(|r| !p.files.join(r).exists()).cloned().collect();
    report.head = head_commit(&repo).map(|h| h.to_string());
    report.at = Local::now().timestamp_millis();
    state.last_sync = Some(report.at);
    save_state(p, &state)?;
    Ok(report)
}

/// "Delete them on GitHub too": the next sync may remove the held files everywhere.
pub fn confirm_deletions(p: &Paths) -> Result<()> {
    let mut s = load_state(p);
    s.confirm_deletions = true;
    save_state(p, &s)
}

/// "Bring them back": restores held files from the last commit into the folder.
pub fn restore_held(p: &Paths, paths: &[String]) -> Result<()> {
    let repo = Repository::open(&p.git)?;
    repo.set_workdir(&p.files, false)?;
    let mut b = CheckoutBuilder::new();
    b.force();
    for path in paths {
        b.path(path);
    }
    repo.checkout_head(Some(&mut b))?;
    Ok(())
}

pub fn conflict_path(rel: &str, stamp: &str) -> String {
    let (dir, name) = rel.rsplit_once('/').map(|(d, n)| (format!("{d}/"), n)).unwrap_or((String::new(), rel));
    // Keep `.md.age` intact; any other dot belongs to the name ("Standup 3.11.md").
    let (base, age) = name.strip_suffix(crate::crypto::EXT).map_or((name, ""), |b| (b, crate::crypto::EXT));
    let (stem, ext) = match base.rfind('.') {
        Some(i) if i > 0 => (&base[..i], &base[i..]),
        _ => (base, ""),
    };
    format!("{dir}{stem} (conflict {stamp}){ext}{age}")
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::AtomicBool;
    use std::sync::Arc;

    fn ctl() -> Ctl {
        Ctl { cancel: Arc::new(AtomicBool::new(false)), progress: Box::new(|_, _, _| {}) }
    }

    struct Device {
        p: Paths,
        r: Remote,
    }

    fn device(base: &Path, name: &str, url: &str) -> Device {
        let dir = base.join(name);
        Device {
            p: Paths { files: dir.join("files"), state: dir.join("state.json"), git: dir.join("git") },
            r: Remote {
                url: url.into(),
                token: String::new(),
                branch: "main".into(),
                author: "Test".into(),
                email: "test@example.com".into(),
                device: name.into(),
            },
        }
    }

    fn setup(tag: &str) -> (PathBuf, String) {
        let base = std::env::temp_dir().join(format!("wandika-git-{tag}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&base);
        std::fs::create_dir_all(&base).unwrap();
        let hub = base.join("hub.git");
        Repository::init_bare(&hub).unwrap();
        (base, format!("file://{}", hub.display()))
    }

    fn write(d: &Device, rel: &str, text: &str) {
        let path = d.p.files.join(rel);
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        std::fs::write(path, text).unwrap();
    }

    fn read(d: &Device, rel: &str) -> Option<String> {
        std::fs::read_to_string(d.p.files.join(rel)).ok()
    }

    #[test]
    fn two_devices_stay_in_sync_and_keep_both_sides_of_a_clash() {
        let (base, url) = setup("devices");
        let mac = device(&base, "mac", &url);
        let phone = device(&base, "phone", &url);

        write(&mac, "Plan.md", "one\ntwo\nthree\n");
        write(&mac, ".obsidian/workspace.json", "{}");
        sync(&mac.p, &mac.r, &ctl()).unwrap();
        sync(&phone.p, &phone.r, &ctl()).unwrap();
        assert_eq!(read(&phone, "Plan.md").as_deref(), Some("one\ntwo\nthree\n"));
        assert_eq!(read(&phone, ".obsidian/workspace.json"), None, "per-device files stay put");

        // Different lines on each side merge.
        write(&mac, "Plan.md", "ONE\ntwo\nthree\n");
        write(&phone, "Plan.md", "one\ntwo\nTHREE\n");
        sync(&mac.p, &mac.r, &ctl()).unwrap();
        let r = sync(&phone.p, &phone.r, &ctl()).unwrap();
        assert!(r.conflicts.is_empty());
        assert_eq!(read(&phone, "Plan.md").as_deref(), Some("ONE\ntwo\nTHREE\n"));
        sync(&mac.p, &mac.r, &ctl()).unwrap();
        assert_eq!(read(&mac, "Plan.md").as_deref(), Some("ONE\ntwo\nTHREE\n"));

        // The same line on both sides: both versions are kept.
        write(&mac, "Plan.md", "mac\ntwo\nTHREE\n");
        write(&phone, "Plan.md", "phone\ntwo\nTHREE\n");
        sync(&mac.p, &mac.r, &ctl()).unwrap();
        let r = sync(&phone.p, &phone.r, &ctl()).unwrap();
        assert_eq!(r.conflicts.len(), 1);
        assert_eq!(read(&phone, "Plan.md").as_deref(), Some("phone\ntwo\nTHREE\n"));
        assert_eq!(read(&phone, &r.conflicts[0]).as_deref(), Some("mac\ntwo\nTHREE\n"));

        // Deletions travel.
        std::fs::remove_file(phone.p.files.join("Plan.md")).unwrap();
        sync(&phone.p, &phone.r, &ctl()).unwrap();
        sync(&mac.p, &mac.r, &ctl()).unwrap();
        assert_eq!(read(&mac, "Plan.md"), None);
        let _ = std::fs::remove_dir_all(&base);
    }

    #[test]
    fn connecting_an_existing_vault_merges_both_and_holds_mass_deletes() {
        let (base, url) = setup("connect");
        let other = device(&base, "other", &url);
        write(&other, "Shared.md", "from GitHub\n");
        write(&other, "Only there.md", "x\n");
        sync(&other.p, &other.r, &ctl()).unwrap();

        let mac = device(&base, "mac", &url);
        write(&mac, "Shared.md", "from the Mac\n");
        for i in 0..40 {
            write(&mac, &format!("notes/n{i}.md"), "note\n");
        }
        let r = sync(&mac.p, &mac.r, &ctl()).unwrap();
        assert_eq!(read(&mac, "Only there.md").as_deref(), Some("x\n"));
        assert_eq!(read(&mac, "Shared.md").as_deref(), Some("from the Mac\n"));
        assert_eq!(r.conflicts.len(), 1, "GitHub's version kept beside it");

        // The folder empties (moved, or not yet downloaded): nothing is deleted on GitHub.
        std::fs::remove_dir_all(mac.p.files.join("notes")).unwrap();
        let r = sync(&mac.p, &mac.r, &ctl()).unwrap();
        assert_eq!(r.held_deletions.len(), 40);
        sync(&other.p, &other.r, &ctl()).unwrap();
        assert_eq!(read(&other, "notes/n1.md").as_deref(), Some("note\n"));

        // Bring them back.
        restore_held(&mac.p, &r.held_deletions).unwrap();
        assert_eq!(read(&mac, "notes/n1.md").as_deref(), Some("note\n"));
        let _ = std::fs::remove_dir_all(&base);
    }

    #[test]
    fn icloud_placeholders_count_as_unchanged() {
        let (base, url) = setup("icloud");
        let mac = device(&base, "mac", &url);
        write(&mac, "Photo.png", "png");
        sync(&mac.p, &mac.r, &ctl()).unwrap();
        std::fs::remove_file(mac.p.files.join("Photo.png")).unwrap();
        write(&mac, ".Photo.png.icloud", "placeholder");
        let r = sync(&mac.p, &mac.r, &ctl()).unwrap();
        assert!(r.pushed.is_empty(), "nothing deleted, placeholder not uploaded");
        let _ = std::fs::remove_dir_all(&base);
    }

    #[test]
    fn a_big_first_upload_goes_up_in_parts() {
        let (base, url) = setup("parts");
        let mac = device(&base, "mac", &url);
        for i in 0..6 {
            write(&mac, &format!("img/{i}.png"), &"x".repeat(400));
        }
        sync(&mac.p, &mac.r, &ctl()).unwrap();
        let hub = Repository::open_bare(base.join("hub.git")).unwrap();
        let mut walk = hub.revwalk().unwrap();
        walk.push_ref("refs/heads/main").unwrap();
        let parts = walk.count();
        assert!(parts >= 3, "6 × 400 bytes in parts of at most 1000: got {parts} commits");
        let phone = device(&base, "phone", &url);
        sync(&phone.p, &phone.r, &ctl()).unwrap();
        assert_eq!(read(&phone, "img/5.png").map(|s| s.len()), Some(400));
        // The Mac's branch took over the pushed chain: nothing left to send.
        let r = sync(&mac.p, &mac.r, &ctl()).unwrap();
        assert!(r.pushed.is_empty());
        let _ = std::fs::remove_dir_all(&base);
    }

    #[test]
    fn conflict_names_keep_extensions() {
        let c = conflict_path("Private/Diary.md.age", "2026-11-03 0930");
        assert_eq!(c, "Private/Diary (conflict 2026-11-03 0930).md.age");
        // A dot inside the name is part of the name.
        assert_eq!(conflict_path("Meetings/Standup 3.11.md", "S"), "Meetings/Standup 3.11 (conflict S).md");
        assert_eq!(conflict_path("v1.2 notes.md.age", "S"), "v1.2 notes (conflict S).md.age");
        assert_eq!(conflict_path("img/photo.png", "S"), "img/photo (conflict S).png");
        assert_eq!(conflict_path("README", "S"), "README (conflict S)");
        assert_eq!(conflict_path(".gitignore", "S"), ".gitignore (conflict S)");
        assert_eq!(conflict_path("a/b/c/Café 日本.md", "S"), "a/b/c/Café 日本 (conflict S).md");
    }

    fn files_on_hub(base: &Path) -> Vec<String> {
        let hub = Repository::open_bare(base.join("hub.git")).unwrap();
        let tree = hub.find_reference("refs/heads/main").unwrap().peel_to_tree().unwrap();
        let mut out = Vec::new();
        tree.walk(git2::TreeWalkMode::PreOrder, |dir, e| {
            if e.kind() == Some(git2::ObjectType::Blob) {
                out.push(format!("{dir}{}", e.name().unwrap()));
            }
            git2::TreeWalkResult::Ok
        })
        .unwrap();
        out.sort();
        out
    }

    #[test]
    fn the_vault_gitignore_and_device_files_stay_on_the_device() {
        let (base, url) = setup("ignore");
        let mac = device(&base, "mac", &url);
        write(&mac, ".gitignore", "drafts/\n*.log\n");
        write(&mac, "Plan.md", "plan");
        write(&mac, "drafts/secret.md", "not yet");
        write(&mac, "build.log", "noise");
        write(&mac, ".DS_Store", "x");
        write(&mac, "Projects/.DS_Store", "x");
        write(&mac, ".obsidian/workspace-mobile.json", "{}");
        write(&mac, ".obsidian/app.json", "{}");
        write(&mac, "Plan.md.wandika-tmp", "half written");
        write(&mac, ".Photo.png.icloud", "placeholder");
        sync(&mac.p, &mac.r, &ctl()).unwrap();
        assert_eq!(files_on_hub(&base), [".gitignore", ".obsidian/app.json", "Plan.md"], "shared Obsidian settings do sync");
        let phone = device(&base, "phone", &url);
        sync(&phone.p, &phone.r, &ctl()).unwrap();
        assert_eq!(read(&phone, "Plan.md").as_deref(), Some("plan"));
        assert_eq!(read(&phone, "drafts/secret.md"), None);
        let exclude = std::fs::read_to_string(mac.p.git.join("info/exclude")).unwrap();
        assert!(exclude.contains(".DS_Store\n") && exclude.contains("*.wandika-tmp\n") && exclude.contains(".*.icloud\n"));
        assert!(!mac.p.files.join(".git").exists(), "the vault folder gets no .git");
        let _ = std::fs::remove_dir_all(&base);
    }

    #[test]
    fn files_over_50_mb_stay_on_this_device_and_are_named() {
        let (base, url) = setup("big");
        let mac = device(&base, "mac", &url);
        write(&mac, "Plan.md", "plan");
        std::fs::create_dir_all(mac.p.files.join("video")).unwrap();
        // Sparse: takes no real space.
        std::fs::File::create(mac.p.files.join("video/talk.mov")).unwrap().set_len(MAX_FILE + 1).unwrap();
        let r = sync(&mac.p, &mac.r, &ctl()).unwrap();
        assert_eq!(r.too_big, ["video/talk.mov"]);
        assert_eq!(files_on_hub(&base), ["Plan.md"]);
        assert_eq!(r.vault_bytes, 4, "only what syncs is counted");
        let again = sync(&mac.p, &mac.r, &ctl()).unwrap();
        assert_eq!(again.too_big, ["video/talk.mov"], "named on every sync");
        assert!(again.pushed.is_empty());
        let _ = std::fs::remove_dir_all(&base);
    }

    #[test]
    fn confirmed_deletions_go_everywhere_once() {
        let (base, url) = setup("confirm");
        let mac = device(&base, "mac", &url);
        for i in 0..30 {
            write(&mac, &format!("notes/n{i}.md"), "note\n");
        }
        sync(&mac.p, &mac.r, &ctl()).unwrap();
        let phone = device(&base, "phone", &url);
        sync(&phone.p, &phone.r, &ctl()).unwrap();

        std::fs::remove_dir_all(mac.p.files.join("notes")).unwrap();
        write(&mac, "New.md", "kept going\n");
        let r = sync(&mac.p, &mac.r, &ctl()).unwrap();
        assert_eq!(r.held_deletions.len(), 30);
        assert_eq!(r.held_deletions[0], "notes/n0.md");
        assert!(files_on_hub(&base).contains(&"New.md".to_string()), "other changes still sync while deletions wait");
        assert_eq!(files_on_hub(&base).len(), 31);

        confirm_deletions(&mac.p).unwrap();
        assert!(load_state(&mac.p).confirm_deletions);
        let r = sync(&mac.p, &mac.r, &ctl()).unwrap();
        assert!(r.held_deletions.is_empty());
        assert_eq!(files_on_hub(&base), ["New.md"]);
        assert!(!load_state(&mac.p).confirm_deletions, "the confirmation is used once");
        let r = sync(&phone.p, &phone.r, &ctl()).unwrap();
        assert_eq!(read(&phone, "notes/n3.md"), None);
        assert_eq!(r.removed.len(), 30);
        assert!(r.removed.contains(&"notes/n3.md".to_string()));
        let _ = std::fs::remove_dir_all(&base);
    }

    #[test]
    fn deletions_are_held_only_when_many_and_a_large_share() {
        let (base, url) = setup("threshold");
        let mac = device(&base, "mac", &url);
        for i in 0..200 {
            write(&mac, &format!("n{i:03}.md"), "x");
        }
        sync(&mac.p, &mac.r, &ctl()).unwrap();
        // 26 of 200 is over 25 files but under a fifth: they go.
        for i in 0..26 {
            std::fs::remove_file(mac.p.files.join(format!("n{i:03}.md"))).unwrap();
        }
        let r = sync(&mac.p, &mac.r, &ctl()).unwrap();
        assert!(r.held_deletions.is_empty());
        assert_eq!(files_on_hub(&base).len(), 174);
        // 25 at once is never held, whatever the share.
        let (base2, url2) = setup("threshold-small");
        let small = device(&base2, "mac", &url2);
        for i in 0..25 {
            write(&small, &format!("n{i}.md"), "x");
        }
        sync(&small.p, &small.r, &ctl()).unwrap();
        std::fs::remove_dir_all(&small.p.files).unwrap();
        std::fs::create_dir_all(&small.p.files).unwrap();
        let r = sync(&small.p, &small.r, &ctl()).unwrap();
        assert!(r.held_deletions.is_empty());
        let _ = std::fs::remove_dir_all(&base);
        let _ = std::fs::remove_dir_all(&base2);
    }

    #[test]
    fn an_edit_beats_a_deletion_from_either_side() {
        let (base, url) = setup("edit-wins");
        let mac = device(&base, "mac", &url);
        let phone = device(&base, "phone", &url);
        write(&mac, "A.md", "a\n");
        write(&mac, "B.md", "b\n");
        sync(&mac.p, &mac.r, &ctl()).unwrap();
        sync(&phone.p, &phone.r, &ctl()).unwrap();

        std::fs::remove_file(mac.p.files.join("A.md")).unwrap();
        write(&mac, "B.md", "b edited on the mac\n");
        write(&phone, "A.md", "a edited on the phone\n");
        std::fs::remove_file(phone.p.files.join("B.md")).unwrap();
        sync(&mac.p, &mac.r, &ctl()).unwrap();
        let r = sync(&phone.p, &phone.r, &ctl()).unwrap();
        assert!(r.conflicts.is_empty());
        sync(&mac.p, &mac.r, &ctl()).unwrap();
        for d in [&mac, &phone] {
            assert_eq!(read(d, "A.md").as_deref(), Some("a edited on the phone\n"));
            assert_eq!(read(d, "B.md").as_deref(), Some("b edited on the mac\n"));
        }
        let _ = std::fs::remove_dir_all(&base);
    }

    #[test]
    fn files_that_cannot_merge_keep_both_versions() {
        let (base, url) = setup("binary");
        let mac = device(&base, "mac", &url);
        let phone = device(&base, "phone", &url);
        std::fs::create_dir_all(mac.p.files.join("img")).unwrap();
        std::fs::write(mac.p.files.join("img/pic.png"), b"\x89PNG\0base").unwrap();
        sync(&mac.p, &mac.r, &ctl()).unwrap();
        sync(&phone.p, &phone.r, &ctl()).unwrap();
        std::fs::write(mac.p.files.join("img/pic.png"), b"\x89PNG\0mac").unwrap();
        std::fs::write(phone.p.files.join("img/pic.png"), b"\x89PNG\0phone").unwrap();
        sync(&mac.p, &mac.r, &ctl()).unwrap();
        let r = sync(&phone.p, &phone.r, &ctl()).unwrap();
        assert_eq!(r.conflicts.len(), 1);
        let copy = &r.conflicts[0];
        assert!(copy.starts_with("img/pic (conflict ") && copy.ends_with(").png"), "{copy}");
        assert_eq!(std::fs::read(phone.p.files.join("img/pic.png")).unwrap(), b"\x89PNG\0phone");
        assert_eq!(std::fs::read(phone.p.files.join(copy)).unwrap(), b"\x89PNG\0mac");
        assert!(r.merged.contains(copy));
        // The other device gets both after its next sync.
        sync(&mac.p, &mac.r, &ctl()).unwrap();
        assert_eq!(std::fs::read(mac.p.files.join("img/pic.png")).unwrap(), b"\x89PNG\0phone");
        assert_eq!(std::fs::read(mac.p.files.join(copy)).unwrap(), b"\x89PNG\0mac");
        let _ = std::fs::remove_dir_all(&base);
    }

    #[test]
    fn unicode_and_nested_paths_travel_intact() {
        let (base, url) = setup("unicode");
        let mac = device(&base, "mac", &url);
        let phone = device(&base, "phone", &url);
        write(&mac, "Safari/Café ñ/日本語 ノート.md", "Habari\r\nza asubuhi\r\n");
        write(&mac, "a/b/c/d/e/Deep.md", "deep");
        write(&mac, "Emoji 🌍.md", "🌍");
        sync(&mac.p, &mac.r, &ctl()).unwrap();
        sync(&phone.p, &phone.r, &ctl()).unwrap();
        assert_eq!(read(&phone, "Safari/Café ñ/日本語 ノート.md").as_deref(), Some("Habari\r\nza asubuhi\r\n"), "line endings kept");
        assert_eq!(read(&phone, "a/b/c/d/e/Deep.md").as_deref(), Some("deep"));
        assert_eq!(read(&phone, "Emoji 🌍.md").as_deref(), Some("🌍"));
        // A rename is a deletion and an addition.
        std::fs::rename(phone.p.files.join("Emoji 🌍.md"), phone.p.files.join("Dunia.md")).unwrap();
        sync(&phone.p, &phone.r, &ctl()).unwrap();
        let r = sync(&mac.p, &mac.r, &ctl()).unwrap();
        assert_eq!(read(&mac, "Dunia.md").as_deref(), Some("🌍"));
        assert_eq!(read(&mac, "Emoji 🌍.md"), None);
        assert_eq!(r.removed, ["Emoji 🌍.md"]);
        let _ = std::fs::remove_dir_all(&base);
    }

    #[test]
    fn an_empty_repository_and_vault_start_with_the_welcome_note() {
        let (base, url) = setup("welcome");
        let mac = device(&base, "mac", &url);
        let r = sync(&mac.p, &mac.r, &ctl()).unwrap();
        assert_eq!(read(&mac, "Welcome.md").as_deref(), Some(WELCOME));
        assert_eq!(files_on_hub(&base), ["Welcome.md"]);
        assert_eq!(r.pushed, ["Welcome.md"]);
        let hub = Repository::open_bare(base.join("hub.git")).unwrap();
        let head = hub.find_reference("refs/heads/main").unwrap().peel_to_commit().unwrap();
        assert_eq!(head.message(), Some("Update 1 file from Wandika on mac"));
        assert_eq!(head.author().email(), Some("test@example.com"));
        assert_eq!(r.head.as_deref(), Some(head.id().to_string().as_str()));
        // A vault with files of its own gets no Welcome note.
        let (base2, url2) = setup("welcome-not");
        let other = device(&base2, "mac", &url2);
        write(&other, "Mine.md", "mine");
        sync(&other.p, &other.r, &ctl()).unwrap();
        assert_eq!(files_on_hub(&base2), ["Mine.md"]);
        let _ = std::fs::remove_dir_all(&base);
        let _ = std::fs::remove_dir_all(&base2);
    }

    #[test]
    fn nothing_changed_means_nothing_pushed_and_the_state_is_saved() {
        let (base, url) = setup("idle");
        let mac = device(&base, "mac", &url);
        assert!(load_state(&mac.p).last_sync.is_none());
        write(&mac, "Plan.md", "plan");
        let first = sync(&mac.p, &mac.r, &ctl()).unwrap();
        assert_eq!(first.pushed, ["Plan.md"]);
        let second = sync(&mac.p, &mac.r, &ctl()).unwrap();
        assert!(second.pushed.is_empty() && second.pulled.is_empty() && second.conflicts.is_empty());
        assert_eq!(second.head, first.head);
        assert_eq!(load_state(&mac.p).last_sync, Some(second.at));
        assert!(second.at >= first.at);
        let _ = std::fs::remove_dir_all(&base);
    }

    #[test]
    fn only_github_moved_is_a_fast_forward() {
        let (base, url) = setup("ff");
        let mac = device(&base, "mac", &url);
        let phone = device(&base, "phone", &url);
        write(&mac, "A.md", "a");
        sync(&mac.p, &mac.r, &ctl()).unwrap();
        sync(&phone.p, &phone.r, &ctl()).unwrap();
        write(&mac, "B.md", "b");
        write(&mac, "A.md", "a2");
        sync(&mac.p, &mac.r, &ctl()).unwrap();
        let r = sync(&phone.p, &phone.r, &ctl()).unwrap();
        let mut pulled = r.pulled.clone();
        pulled.sort();
        assert_eq!(pulled, ["A.md", "B.md"]);
        assert!(r.merged.is_empty(), "no merge commit");
        assert!(r.pushed.is_empty());
        let repo = Repository::open(&phone.p.git).unwrap();
        assert_eq!(repo.head().unwrap().peel_to_commit().unwrap().parent_count(), 1);
        let _ = std::fs::remove_dir_all(&base);
    }

    #[test]
    fn a_stopped_sync_changes_nothing_on_github() {
        let (base, url) = setup("cancel");
        let mac = device(&base, "mac", &url);
        write(&mac, "Plan.md", "plan");
        let stop = ctl();
        stop.cancel.store(true, std::sync::atomic::Ordering::Relaxed);
        assert!(matches!(sync(&mac.p, &mac.r, &stop), Err(Error::Cancelled)));
        let hub = Repository::open_bare(base.join("hub.git")).unwrap();
        assert!(hub.find_reference("refs/heads/main").is_err(), "GitHub still empty");
        assert!(load_state(&mac.p).last_sync.is_none());
        // The next sync carries on.
        sync(&mac.p, &mac.r, &ctl()).unwrap();
        assert_eq!(files_on_hub(&base), ["Plan.md"]);
        let _ = std::fs::remove_dir_all(&base);
    }

    #[test]
    fn progress_starts_checking_and_ends_saving() {
        let (base, url) = setup("progress");
        let mac = device(&base, "mac", &url);
        for i in 0..4 {
            write(&mac, &format!("img/{i}.png"), &"x".repeat(400));
        }
        let seen = Arc::new(std::sync::Mutex::new(Vec::<String>::new()));
        let log = seen.clone();
        let c = Ctl { cancel: Arc::new(AtomicBool::new(false)), progress: Box::new(move |phase, _, _| log.lock().unwrap().push(phase.into())) };
        sync(&mac.p, &mac.r, &c).unwrap();
        let seen = seen.lock().unwrap();
        assert_eq!(seen.first().map(String::as_str), Some("checking"));
        assert_eq!(seen.last().map(String::as_str), Some("saving"));
        assert!(seen.iter().any(|p| p == "uploading"), "parts report their upload");
        let _ = std::fs::remove_dir_all(&base);
    }

    #[test]
    fn big_uploads_send_deletions_first_then_smallest_files_and_big_files_alone() {
        let (base, url) = setup("order");
        let mac = device(&base, "mac", &url);
        write(&mac, "old1.md", "x");
        write(&mac, "old2.md", "x");
        sync(&mac.p, &mac.r, &ctl()).unwrap();
        std::fs::remove_file(mac.p.files.join("old1.md")).unwrap();
        std::fs::remove_file(mac.p.files.join("old2.md")).unwrap();
        write(&mac, "huge.png", &"h".repeat(1500));
        write(&mac, "tiny.md", "t");
        write(&mac, "mid.png", &"m".repeat(600));
        write(&mac, "mid2.png", &"n".repeat(600));
        let r = sync(&mac.p, &mac.r, &ctl()).unwrap();
        assert_eq!(r.pushed.len(), 6);

        let hub = Repository::open_bare(base.join("hub.git")).unwrap();
        let mut walk = hub.revwalk().unwrap();
        walk.push_ref("refs/heads/main").unwrap();
        walk.set_sorting(git2::Sort::TOPOLOGICAL | git2::Sort::REVERSE).unwrap();
        let parts: Vec<git2::Commit> = walk.skip(1).map(|id| hub.find_commit(id.unwrap()).unwrap()).collect();
        let files = |c: &git2::Commit| {
            let mut v: Vec<String> = c.tree().unwrap().iter().map(|e| e.name().unwrap().to_string()).collect();
            v.sort();
            v
        };
        assert_eq!(parts.len(), 3, "{:?}", parts.iter().map(|c| c.message().unwrap().to_string()).collect::<Vec<_>>());
        assert_eq!(parts[0].message(), Some("Add files from Wandika on mac (part 1 of 3)"));
        assert_eq!(files(&parts[0]), ["mid.png", "tiny.md"], "deletions, then the smallest files, up to 1000 bytes");
        assert_eq!(files(&parts[1]), ["mid.png", "mid2.png", "tiny.md"]);
        assert_eq!(files(&parts[2]), ["huge.png", "mid.png", "mid2.png", "tiny.md"], "a file over the part size goes alone");
        let _ = std::fs::remove_dir_all(&base);
    }

    #[test]
    fn when_github_moves_during_a_sync_it_merges_and_pushes_again() {
        let (base, url) = setup("race");
        let mac = device(&base, "mac", &url);
        let phone = device(&base, "phone", &url);
        write(&mac, "Plan.md", "one\n");
        sync(&mac.p, &mac.r, &ctl()).unwrap();
        sync(&phone.p, &phone.r, &ctl()).unwrap();
        write(&mac, "FromMac.md", "mac\n");
        sync(&mac.p, &mac.r, &ctl()).unwrap();

        // While the phone downloads, the Mac pushes again; the phone's first push is then refused.
        write(&phone, "FromPhone.md", "phone\n");
        let ran = Arc::new(AtomicBool::new(false));
        let (flag, b, u) = (ran.clone(), base.clone(), url.clone());
        let c = Ctl {
            cancel: Arc::new(AtomicBool::new(false)),
            progress: Box::new(move |phase, _, _| {
                if phase == "downloading" && !flag.swap(true, std::sync::atomic::Ordering::SeqCst) {
                    let mac = device(&b, "mac", &u);
                    write(&mac, "Meanwhile.md", "meanwhile\n");
                    sync(&mac.p, &mac.r, &ctl()).unwrap();
                }
            }),
        };
        sync(&phone.p, &phone.r, &c).unwrap();
        assert!(ran.load(std::sync::atomic::Ordering::SeqCst), "the Mac pushed during the phone's sync");
        assert_eq!(files_on_hub(&base), ["FromMac.md", "FromPhone.md", "Meanwhile.md", "Plan.md"]);
        assert_eq!(read(&phone, "Meanwhile.md").as_deref(), Some("meanwhile\n"));
        let _ = std::fs::remove_dir_all(&base);
    }

    #[test]
    fn a_push_github_refuses_reports_false() {
        let (base, url) = setup("refused");
        let mac = device(&base, "mac", &url);
        let phone = device(&base, "phone", &url);
        write(&mac, "A.md", "a");
        sync(&mac.p, &mac.r, &ctl()).unwrap();
        write(&phone, "B.md", "b");
        // The phone commits on its own history, unrelated to GitHub's, and pushes without merging.
        let repo = open(&phone.p, &phone.r).unwrap();
        commit_local(&repo, &phone.p, &phone.r, &SyncState::default(), &mut SyncReport::default()).unwrap();
        let head = head_commit(&repo).unwrap();
        assert!(!push(&repo, &phone.r, &ctl(), head).unwrap());
        assert_eq!(files_on_hub(&base), ["A.md"]);
        assert!(repo.find_reference("refs/wandika/push").is_err(), "the temporary ref is cleaned up");
        let _ = std::fs::remove_dir_all(&base);
    }

    #[test]
    fn typing_during_a_sync_is_not_overwritten() {
        let (base, url) = setup("typing");
        let mac = device(&base, "mac", &url);
        let phone = device(&base, "phone", &url);
        write(&mac, "Plan.md", "one\n");
        sync(&mac.p, &mac.r, &ctl()).unwrap();
        sync(&phone.p, &phone.r, &ctl()).unwrap();
        write(&mac, "Plan.md", "from the mac\n");
        write(&mac, "Other.md", "other\n");
        sync(&mac.p, &mac.r, &ctl()).unwrap();

        // The phone has committed, then the person types before GitHub's files are brought in.
        let repo = open(&phone.p, &phone.r).unwrap();
        let theirs = fetch(&repo, &phone.r, &ctl()).unwrap().unwrap();
        write(&phone, "Plan.md", "typed just now\n");
        integrate(&repo, &phone.r, theirs, &mut SyncReport::default()).unwrap();
        assert_eq!(read(&phone, "Plan.md").as_deref(), Some("typed just now\n"));
        assert_eq!(read(&phone, "Other.md").as_deref(), Some("other\n"), "everything else came in");
        drop(repo);
        // The next sync takes the typing in.
        sync(&phone.p, &phone.r, &ctl()).unwrap();
        sync(&mac.p, &mac.r, &ctl()).unwrap();
        assert_eq!(read(&mac, "Plan.md").as_deref(), Some("typed just now\n"));
        let _ = std::fs::remove_dir_all(&base);
    }

    #[test]
    fn bring_back_restores_only_the_named_files() {
        let (base, url) = setup("bring-back");
        let mac = device(&base, "mac", &url);
        write(&mac, "A.md", "a");
        write(&mac, "B.md", "b");
        write(&mac, "Ünï/C.md", "c");
        sync(&mac.p, &mac.r, &ctl()).unwrap();
        std::fs::remove_file(mac.p.files.join("A.md")).unwrap();
        std::fs::remove_file(mac.p.files.join("B.md")).unwrap();
        std::fs::remove_dir_all(mac.p.files.join("Ünï")).unwrap();
        restore_held(&mac.p, &["A.md".into(), "Ünï/C.md".into()]).unwrap();
        assert_eq!(read(&mac, "A.md").as_deref(), Some("a"));
        assert_eq!(read(&mac, "Ünï/C.md").as_deref(), Some("c"));
        assert_eq!(read(&mac, "B.md"), None);
        let none = device(&base, "never-synced", &url);
        assert!(restore_held(&none.p, &["A.md".into()]).is_err(), "no repository yet");
        let _ = std::fs::remove_dir_all(&base);
    }

    #[test]
    fn opening_follows_a_new_remote_address_and_keeps_line_endings() {
        let (base, url) = setup("open");
        let mut mac = device(&base, "mac", &url);
        let repo = open(&mac.p, &mac.r).unwrap();
        assert_eq!(repo.find_remote("origin").unwrap().url(), Some(url.as_str()));
        assert!(!repo.is_bare() && repo.workdir().is_some());
        let cfg = repo.config().unwrap().snapshot().unwrap();
        assert!(!cfg.get_bool("core.autocrlf").unwrap());
        assert!(cfg.get_bool("core.precomposeunicode").unwrap());
        drop(repo);
        mac.r.url = format!("{url}-renamed");
        let repo = open(&mac.p, &mac.r).unwrap();
        assert_eq!(repo.find_remote("origin").unwrap().url(), Some(mac.r.url.as_str()));
        // A folder vault that moved: the repository follows it.
        mac.p.files = base.join("moved-files");
        let repo = open(&mac.p, &mac.r).unwrap();
        assert_eq!(repo.workdir().unwrap().canonicalize().unwrap(), mac.p.files.canonicalize().unwrap());
        let _ = std::fs::remove_dir_all(&base);
    }

    #[test]
    fn a_vault_folder_that_is_a_git_repo_keeps_its_own_git() {
        let (base, url) = setup("own-git");
        let mac = device(&base, "mac", &url);
        let own = Repository::init(&mac.p.files).unwrap();
        write(&mac, "Plan.md", "plan");
        sync(&mac.p, &mac.r, &ctl()).unwrap();
        assert!(mac.p.files.join(".git").is_dir(), "their repository is untouched");
        assert!(own.head().is_err(), "and gets no commits from us");
        assert_eq!(files_on_hub(&base), ["Plan.md"]);
        let _ = std::fs::remove_dir_all(&base);
    }

    #[test]
    fn a_link_file_left_by_an_earlier_version_is_removed() {
        let (base, url) = setup("old-link");
        let mac = device(&base, "mac", &url);
        std::fs::create_dir_all(&mac.p.git).unwrap();
        write(&mac, ".git", &format!("gitdir: {}/\n", mac.p.git.display()));
        let mut opts = RepositoryInitOptions::new();
        opts.bare(true).initial_head("main");
        Repository::init_opts(&mac.p.git, &opts).unwrap();
        sync(&mac.p, &mac.r, &ctl()).unwrap();
        assert!(!mac.p.files.join(".git").exists());
        // A link to some other repository is not ours to remove.
        write(&mac, ".git", "gitdir: /somewhere/else\n");
        sync(&mac.p, &mac.r, &ctl()).unwrap();
        assert!(mac.p.files.join(".git").is_file());
        let _ = std::fs::remove_dir_all(&base);
    }

    #[test]
    fn sync_state_reads_missing_or_damaged_files_as_new() {
        let (base, url) = setup("state");
        let mac = device(&base, "mac", &url);
        let s = load_state(&mac.p);
        assert!(s.last_sync.is_none() && !s.confirm_deletions);
        save_state(&mac.p, &SyncState { last_sync: Some(42), confirm_deletions: true }).unwrap();
        let s = load_state(&mac.p);
        assert_eq!((s.last_sync, s.confirm_deletions), (Some(42), true));
        std::fs::write(&mac.p.state, "{broken").unwrap();
        assert!(load_state(&mac.p).last_sync.is_none());
        std::fs::write(&mac.p.state, r#"{"last_sync":7}"#).unwrap();
        assert_eq!(load_state(&mac.p).last_sync, Some(7), "older files without confirm_deletions still read");
        let _ = std::fs::remove_dir_all(&base);
    }

    #[test]
    fn git_errors_become_plain_sentences() {
        use git2::{ErrorClass, ErrorCode};
        let e = |code, m: &str| Error::from(git2::Error::new(code, ErrorClass::Net, m));
        assert!(matches!(e(ErrorCode::User, "callback returned"), Error::Cancelled));
        for m in ["unexpected http status code: 401", "authentication required"] {
            assert!(e(ErrorCode::GenericError, m).to_string().starts_with("Your GitHub sign-in expired"), "{m}");
        }
        assert!(e(ErrorCode::Auth, "x").to_string().starts_with("Your GitHub sign-in expired"));
        for m in ["unexpected http status code: 403", "Permission to x denied"] {
            assert!(e(ErrorCode::GenericError, m).to_string().starts_with("GitHub didn't let this account write"), "{m}");
        }
        for m in ["failed to resolve address for github.com", "Operation timed out", "network is unreachable", "could not connect to server", "offline"] {
            assert!(matches!(e(ErrorCode::GenericError, m), Error::Offline), "{m}");
        }
        let other = e(ErrorCode::GenericError, "object not found");
        assert!(matches!(&other, Error::Git(m) if m == "object not found"));
        assert_eq!(other.friendly().0, "git");
    }
}
