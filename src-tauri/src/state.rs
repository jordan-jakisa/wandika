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

#[derive(Serialize, Deserialize, Default, Clone)]
pub struct Settings {
    pub user: Option<User>,
    pub target: Option<Target>,
}

pub struct App {
    pub http: reqwest::Client,
    pub data: PathBuf,
    pub secrets: Secrets,
    pub settings: Mutex<Settings>,
    pub sync_lock: tokio::sync::Mutex<()>,
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
        crate::vault::write_atomic(&self.data.join("settings.json"), &serde_json::to_vec_pretty(&*s)?)
    }

    pub fn github(&self) -> Result<GitHub> {
        let token = self.secrets.get(GITHUB_KEY).ok_or_else(|| msg("Sign in with GitHub first."))?;
        Ok(GitHub::new(self.http.clone(), token))
    }

    pub fn target(&self) -> Result<Target> {
        self.settings().target.ok_or_else(|| msg("Choose a repository first."))
    }

    pub fn paths(&self) -> Result<Paths> {
        Ok(Paths::new(&self.data, &self.target()?))
    }

    pub fn root(&self) -> Result<PathBuf> {
        let root = self.paths()?.files;
        std::fs::create_dir_all(&root)?;
        Ok(root)
    }

    pub fn crypto(&self) -> Result<Crypto> {
        Ok(Crypto::load(&self.root()?, &self.secrets, &self.target()?.id()))
    }
}
