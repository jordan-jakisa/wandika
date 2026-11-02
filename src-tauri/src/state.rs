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
        Ok(Paths { files: v.folder.clone().unwrap_or_else(|| base.join("files")), state: base.join("state.json") })
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
