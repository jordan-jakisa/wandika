//! Notes changed outside the app, by Claude Code through `wandika mcp`: the server records each
//! change in the vault's data folder and a running app reads the list to reload what changed.

use crate::error::{msg, Result};
use crate::state::App;
use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};

/// How long a change stays in the list a running app reads.
#[cfg(desktop)]
const KEEP_MS: i64 = 120_000;

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
pub struct Change {
    pub path: String,
    pub at: i64,
}

/// The file a running Wandika reads to learn what changed outside it.
pub fn changes_file(app: &App) -> Result<PathBuf> {
    let state = app.paths()?.state;
    Ok(state.parent().ok_or_else(|| msg("No data folder for this vault."))?.join("external.json"))
}

pub fn read_changes(file: &Path) -> Vec<Change> {
    std::fs::read(file).ok().and_then(|b| serde_json::from_slice(&b).ok()).unwrap_or_default()
}

/// Recorded by the Mac's MCP server; phones only read the list.
#[cfg(desktop)]
pub fn record_change(file: &Path, paths: &[String]) -> Result<()> {
    let now = chrono::Utc::now().timestamp_millis();
    let mut list: Vec<Change> = read_changes(file).into_iter().filter(|c| now - c.at < KEEP_MS).collect();
    list.extend(paths.iter().map(|p| Change { path: p.clone(), at: now }));
    if let Some(dir) = file.parent() {
        std::fs::create_dir_all(dir)?;
    }
    let tmp = file.with_extension("json.tmp");
    std::fs::write(&tmp, serde_json::to_vec(&list).map_err(crate::error::Error::from)?)?;
    std::fs::rename(&tmp, file)?;
    Ok(())
}
