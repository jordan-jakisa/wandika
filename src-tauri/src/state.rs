//! App-wide state: HTTP client, keychain, the chosen vault and its index.

use crate::connectors::oauth::Pending;
use crate::crypto::Crypto;
use crate::error::{msg, Result};
use crate::github::{GitHub, User};
use crate::secrets::Secrets;
use crate::sync::{Paths, Target};
use crate::vault::Index;
use serde::{Deserialize, Serialize};
use std::path::PathBuf;
use std::sync::Mutex;

pub const GITHUB_KEY: &str = "github";

/// A notes vault: a folder of Markdown files, optionally synced with a GitHub repository.
#[derive(Serialize, Deserialize, Clone)]
pub struct VaultConfig {
    /// Fixed for the vault's life, also when a remote is added later; names its data folder.
    pub id: String,
    pub name: String,
    /// A folder chosen on the Mac (an Obsidian vault, a local git repo). None: the app's own storage.
    pub folder: Option<PathBuf>,
    pub remote: Option<Target>,
}

#[derive(Serialize, Deserialize, Default, Clone)]
pub struct Settings {
    pub user: Option<User>,
    pub vault: Option<VaultConfig>,
    /// Every vault opened on this device, for switching back.
    #[serde(default)]
    pub known: Vec<VaultConfig>,
}

pub struct App {
    pub http: reqwest::Client,
    pub data: PathBuf,
    pub secrets: Secrets,
    pub settings: Mutex<Settings>,
    pub sync_lock: tokio::sync::Mutex<()>,
    /// Set to stop the running sync at its next file.
    pub sync_cancel: std::sync::Arc<std::sync::atomic::AtomicBool>,
    pub index: Mutex<Index>,
    pub pending: Mutex<Option<Pending>>,
}

impl App {
    pub fn new(data: PathBuf) -> Self {
        let settings = std::fs::read(data.join("settings.json"))
            .ok()
            .and_then(|b| serde_json::from_slice(&b).ok())
            .unwrap_or_default();
        let http = reqwest::Client::builder()
            .user_agent(concat!("Wandika/", env!("CARGO_PKG_VERSION")))
            .connect_timeout(std::time::Duration::from_secs(15))
            .timeout(std::time::Duration::from_secs(120))
            .build()
            .expect("HTTP client");
        Self {
            http,
            secrets: Secrets::new(data.clone()),
            data,
            settings: Mutex::new(settings),
            sync_lock: tokio::sync::Mutex::new(()),
            sync_cancel: Default::default(),
            index: Mutex::new(Index::default()),
            pending: Mutex::new(None),
        }
    }

    pub fn settings(&self) -> Settings {
        self.settings.lock().unwrap().clone()
    }

    pub fn update_settings(&self, f: impl FnOnce(&mut Settings)) -> Result<()> {
        let mut s = self.settings.lock().unwrap();
        f(&mut s);
        if let Some(v) = s.vault.clone() {
            match s.known.iter_mut().find(|k| k.id == v.id) {
                Some(k) => *k = v,
                None => s.known.push(v),
            }
        }
        crate::vault::write_atomic(&self.data.join("settings.json"), &serde_json::to_vec_pretty(&*s)?)
    }

    pub fn github(&self) -> Result<GitHub> {
        let token = self.secrets.get(GITHUB_KEY).ok_or_else(|| msg("Sign in with GitHub first."))?;
        Ok(GitHub::new(self.http.clone(), token))
    }

    pub fn vault(&self) -> Result<VaultConfig> {
        self.settings().vault.ok_or_else(|| msg("Open or create a vault first."))
    }

    pub fn target(&self) -> Result<Target> {
        self.vault()?.remote.ok_or_else(|| msg("This vault is only on this device. Connect it to GitHub to sync it."))
    }

    pub fn paths(&self) -> Result<Paths> {
        let v = self.vault()?;
        let base = self.data.join("vaults").join(&v.id);
        Ok(Paths {
            files: v.folder.clone().unwrap_or_else(|| base.join("files")),
            state: base.join("state.json"),
            git: base.join("git"),
        })
    }

    pub fn root(&self) -> Result<PathBuf> {
        let root = self.paths()?.files;
        std::fs::create_dir_all(&root)?;
        Ok(root)
    }

    /// A file changed outside the note commands; the next lookup rescans.
    pub fn edited_on_disk(&self) {
        self.index.lock().unwrap().mark_stale();
    }

    pub fn crypto(&self) -> Result<Crypto> {
        Ok(Crypto::load(&self.root()?, &self.secrets, &self.vault()?.id))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn data(tag: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("wandika-state-{tag}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn local(id: &str, folder: Option<PathBuf>) -> VaultConfig {
        VaultConfig { id: id.into(), name: id.into(), folder, remote: None }
    }

    #[test]
    fn a_first_start_has_no_vault_and_says_what_to_do() {
        let dir = data("first");
        let app = App::new(dir.clone());
        let s = app.settings();
        assert!(s.user.is_none() && s.vault.is_none() && s.known.is_empty());
        assert_eq!(app.vault().err().unwrap().to_string(), "Open or create a vault first.");
        assert_eq!(app.target().err().unwrap().to_string(), "Open or create a vault first.");
        assert!(app.paths().is_err() && app.root().is_err() && app.crypto().is_err());
        assert_eq!(app.github().err().unwrap().to_string(), "Sign in with GitHub first.");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn settings_are_saved_and_every_opened_vault_is_remembered() {
        let dir = data("saved");
        let app = App::new(dir.clone());
        app.update_settings(|s| s.vault = Some(local("local/a", None))).unwrap();
        app.update_settings(|s| s.vault = Some(local("local/b", None))).unwrap();
        app.update_settings(|s| s.vault = Some(VaultConfig { name: "B renamed".into(), ..local("local/b", None) })).unwrap();
        let s = app.settings();
        assert_eq!(s.known.iter().map(|k| k.id.as_str()).collect::<Vec<_>>(), ["local/a", "local/b"], "each vault listed once");
        assert_eq!(s.known[1].name, "B renamed", "the list follows changes to the open vault");
        app.update_settings(|s| s.vault = None).unwrap();
        assert_eq!(app.settings().known.len(), 2, "closing keeps the list");

        let again = App::new(dir.clone());
        assert_eq!(again.settings().known.len(), 2, "read back on the next start");
        assert!(!dir.join(format!("settings.json{}", crate::vault::TMP_SUFFIX)).exists());

        std::fs::write(dir.join("settings.json"), "{broken").unwrap();
        assert!(App::new(dir.clone()).settings().known.is_empty(), "unreadable settings start fresh");
        std::fs::write(dir.join("settings.json"), r#"{"user":null,"vault":null}"#).unwrap();
        assert!(App::new(dir.clone()).settings().known.is_empty(), "older settings without the list still load");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn paths_use_wandika_storage_or_the_chosen_folder() {
        let dir = data("paths");
        let app = App::new(dir.clone());
        app.update_settings(|s| s.vault = Some(local("github/amina/notes", None))).unwrap();
        let p = app.paths().unwrap();
        let base = dir.join("vaults/github/amina/notes");
        assert_eq!((p.files, p.state, p.git), (base.join("files"), base.join("state.json"), base.join("git")));
        assert_eq!(app.root().unwrap(), base.join("files"));
        assert!(base.join("files").is_dir(), "root makes the folder");
        assert_eq!(app.target().err().unwrap().to_string(), "This vault is only on this device. Connect it to GitHub to sync it.");

        let folder = dir.join("Obsidian Vault");
        let remote = Target { owner: "amina".into(), repo: "notes".into(), branch: "main".into() };
        app.update_settings(|s| s.vault = Some(VaultConfig { remote: Some(remote), ..local("local/obs", Some(folder.clone())) })).unwrap();
        let p = app.paths().unwrap();
        assert_eq!(p.files, folder, "a chosen folder holds the files");
        assert_eq!(p.git, dir.join("vaults/local/obs/git"), "the repository stays in Wandika's storage");
        assert_eq!(app.target().unwrap().repo, "notes");
        assert!(!app.crypto().unwrap().status().set_up);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn signing_in_gives_a_github_client_with_the_token() {
        let dir = data("token");
        let app = App::new(dir.clone());
        app.secrets.set(GITHUB_KEY, "gho_saved").unwrap();
        assert_eq!(app.github().unwrap().token(), "gho_saved");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn edits_on_disk_reach_the_next_lookup() {
        let dir = data("stale");
        let app = App::new(dir.clone());
        app.update_settings(|s| s.vault = Some(local("local/x", None))).unwrap();
        let (root, crypto) = (app.root().unwrap(), app.crypto().unwrap());
        app.index.lock().unwrap().ensure_fresh(&root, &crypto);
        std::fs::write(root.join("New.md"), "x").unwrap();
        app.index.lock().unwrap().ensure_fresh(&root, &crypto);
        assert!(app.index.lock().unwrap().titles().is_empty(), "not rescanned yet");
        app.edited_on_disk();
        app.index.lock().unwrap().ensure_fresh(&root, &crypto);
        assert_eq!(app.index.lock().unwrap().titles().len(), 1);
        let _ = std::fs::remove_dir_all(&dir);
    }
}
