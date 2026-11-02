//! Images and other files kept beside the notes. New ones go where Obsidian would put them
//! (`.obsidian/app.json` → `attachmentFolderPath`), and embeds resolve the way Obsidian resolves
//! them: next to the note, from the vault root, then by file name anywhere in the vault.

use crate::crypto::{self, Crypto};
use crate::error::{msg, Result};
use crate::vault::{safe, write_atomic};
use std::path::Path;
use walkdir::WalkDir;

fn folder_of(rel: &str) -> &str {
    rel.rsplit_once('/').map_or("", |(f, _)| f)
}

fn join(folder: &str, name: &str) -> String {
    let folder = folder.trim_matches('/');
    if folder.is_empty() { name.to_string() } else { format!("{folder}/{name}") }
}

/// Obsidian's "Default location for new attachments": `/` is the vault root, `./` the note's
/// folder, `./sub` a folder under the note's, anything else a fixed folder.
pub fn folder_for(root: &Path, note: &str) -> String {
    let setting = std::fs::read(root.join(".obsidian/app.json"))
        .ok()
        .and_then(|b| serde_json::from_slice::<serde_json::Value>(&b).ok())
        .and_then(|v| v.get("attachmentFolderPath")?.as_str().map(str::to_string))
        .unwrap_or_else(|| "/".into());
    let setting = setting.trim();
    if setting.is_empty() || setting == "/" {
        String::new()
    } else if let Some(sub) = setting.strip_prefix("./") {
        join(folder_of(note), sub)
    } else if setting == "." {
        folder_of(note).to_string()
    } else {
        setting.trim_matches('/').to_string()
    }
}

/// Keeps letters, digits, spaces and `.-_()`; Obsidian links break on `[]#^|`.
fn clean_file_name(name: &str) -> Result<String> {
    let name = name.rsplit(['/', '\\']).next().unwrap_or(name);
    let cleaned: String = name
        .chars()
        .map(|c| if c.is_alphanumeric() || " .-_()".contains(c) { c } else { '-' })
        .collect();
    let cleaned = cleaned.trim().trim_start_matches('.').to_string();
    if cleaned.is_empty() {
        return Err(msg("That file has no usable name."));
    }
    Ok(cleaned)
}

/// Saves `bytes` for `note` and returns the vault path. A taken name gets " 1", " 2" and so on.
/// In an encrypted folder, or for an encrypted note, the file is encrypted too, stored with `.age`
/// added.
pub fn save(root: &Path, note: &str, name: &str, bytes: &[u8], crypto: &Crypto) -> Result<String> {
    let folder = folder_for(root, note);
    let name = clean_file_name(name)?;
    let (stem, ext) = match name.rsplit_once('.') {
        Some((s, e)) if !s.is_empty() => (s.to_string(), format!(".{e}")),
        _ => (name.clone(), String::new()),
    };
    // An encrypted note's pictures are as private as its text.
    let encrypt = crypto.folder_is_encrypted(&folder) || crypto::is_encrypted(note);
    // Unique across the whole vault, so `![[name]]` always finds this file and no other.
    let taken: std::collections::HashSet<String> = WalkDir::new(root)
        .min_depth(1)
        .into_iter()
        .filter_entry(|e| !e.file_name().to_string_lossy().starts_with('.'))
        .flatten()
        .filter(|e| e.file_type().is_file())
        .map(|e| e.file_name().to_string_lossy().trim_end_matches(".age").to_lowercase())
        .collect();
    let mut n = 0;
    let rel = loop {
        let file = if n == 0 { format!("{stem}{ext}") } else { format!("{stem} {n}{ext}") };
        if !taken.contains(&file.to_lowercase()) {
            break join(&folder, &file);
        }
        n += 1;
    };
    if encrypt {
        write_atomic(&safe(root, &format!("{rel}.age"))?, &crypto.encrypt(bytes)?)?;
    } else {
        write_atomic(&safe(root, &rel)?, bytes)?;
    }
    Ok(rel)
}

/// Finds the file an embed in `from` points at, or None.
pub fn resolve(root: &Path, target: &str, from: &str) -> Option<String> {
    let target = target.trim().trim_start_matches("./").trim_start_matches('/');
    if target.is_empty() {
        return None;
    }
    let exists = |rel: &str| -> Option<String> {
        [rel.to_string(), format!("{rel}.age")]
            .into_iter()
            .find(|r| safe(root, r).is_ok_and(|p| p.is_file()))
    };
    if let Some(found) = exists(&join(folder_of(from), target)).or_else(|| exists(target)) {
        return Some(found);
    }
    // By name anywhere, preferring the shortest path, as Obsidian does.
    let name = target.rsplit('/').next()?.to_lowercase();
    let mut best: Option<String> = None;
    for e in WalkDir::new(root).min_depth(1).into_iter().filter_entry(|e| !e.file_name().to_string_lossy().starts_with('.')).flatten() {
        if !e.file_type().is_file() {
            continue;
        }
        let file = e.file_name().to_string_lossy().to_lowercase();
        if file == name || file == format!("{name}.age") {
            let rel = e.path().strip_prefix(root).ok()?.to_string_lossy().replace('\\', "/");
            if best.as_ref().is_none_or(|b| rel.len() < b.len()) {
                best = Some(rel);
            }
        }
    }
    best
}

pub fn read(root: &Path, rel: &str, crypto: &Crypto) -> Result<Vec<u8>> {
    let bytes = std::fs::read(safe(root, rel)?)?;
    if crypto::is_encrypted(rel) { crypto.decrypt(&bytes) } else { Ok(bytes) }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn follows_obsidian_attachment_setting_and_resolves_by_name() {
        let dir = std::env::temp_dir().join(format!("wandika-att-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(dir.join(".obsidian")).unwrap();
        let crypto = Crypto::load(&dir, &crate::secrets::Secrets::new(dir.clone()), "test/attachments");

        assert_eq!(folder_for(&dir, "Projects/Plan.md"), "");
        std::fs::write(dir.join(".obsidian/app.json"), r#"{"attachmentFolderPath":"./assets"}"#).unwrap();
        assert_eq!(folder_for(&dir, "Projects/Plan.md"), "Projects/assets");
        std::fs::write(dir.join(".obsidian/app.json"), r#"{"attachmentFolderPath":"attachments"}"#).unwrap();

        let a = save(&dir, "Projects/Plan.md", "Pasted image.png", b"one", &crypto).unwrap();
        let b = save(&dir, "Projects/Plan.md", "Pasted image.png", b"two", &crypto).unwrap();
        assert_eq!(a, "attachments/Pasted image.png");
        assert_eq!(b, "attachments/Pasted image 1.png");
        assert_eq!(clean_file_name("../we[ird]#.png").unwrap(), "we-ird--.png");

        assert_eq!(resolve(&dir, "Pasted image 1.png", "Daily/Today.md").as_deref(), Some(b.as_str()));
        assert_eq!(resolve(&dir, "attachments/Pasted image.png", "Daily/Today.md").as_deref(), Some(a.as_str()));
        assert_eq!(resolve(&dir, "missing.png", "Daily/Today.md"), None);
        assert_eq!(read(&dir, &b, &crypto).unwrap(), b"two");
        let _ = std::fs::remove_dir_all(&dir);
    }
}
