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

    fn temp_vault(tag: &str) -> std::path::PathBuf {
        let dir = std::env::temp_dir().join(format!("wandika-att-{tag}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn put(root: &Path, rel: &str, bytes: &[u8]) {
        let path = root.join(rel);
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        std::fs::write(path, bytes).unwrap();
    }

    fn plain(root: &Path) -> Crypto {
        Crypto::load(root, &crate::secrets::Secrets::new(root.join(".secrets")), "test/att")
    }

    /// An unlocked vault key without the passphrase step: the key is placed where a device keeps it.
    fn unlocked(root: &Path, folders: &[&str]) -> Crypto {
        let identity = age::x25519::Identity::generate();
        let config = crypto::EncConfig {
            version: 1,
            recipient: identity.to_public().to_string(),
            identity: String::new(),
            folders: folders.iter().map(|f| f.to_string()).collect(),
        };
        crypto::save_config(root, &config).unwrap();
        let secrets = crate::secrets::Secrets::new(root.join(".secrets"));
        use age::secrecy::ExposeSecret;
        secrets.set("age-identity:test/att", identity.to_string().expose_secret()).unwrap();
        let c = Crypto::load(root, &secrets, "test/att");
        assert!(c.unlocked());
        c
    }

    #[test]
    fn every_obsidian_attachment_setting() {
        let dir = temp_vault("settings");
        let set = |v: &str| put(&dir, ".obsidian/app.json", format!(r#"{{"attachmentFolderPath":"{v}"}}"#).as_bytes());
        set("/");
        assert_eq!(folder_for(&dir, "Projects/Plan.md"), "");
        set("");
        assert_eq!(folder_for(&dir, "Projects/Plan.md"), "");
        set(".");
        assert_eq!(folder_for(&dir, "Projects/Plan.md"), "Projects");
        assert_eq!(folder_for(&dir, "Top.md"), "");
        set("./img/2026");
        assert_eq!(folder_for(&dir, "a/b/Plan.md"), "a/b/img/2026");
        assert_eq!(folder_for(&dir, "Top.md"), "img/2026");
        set("/Assets/");
        assert_eq!(folder_for(&dir, "Projects/Plan.md"), "Assets");
        put(&dir, ".obsidian/app.json", b"{broken");
        assert_eq!(folder_for(&dir, "Projects/Plan.md"), "", "unreadable settings: the vault root");
        put(&dir, ".obsidian/app.json", br#"{"attachmentFolderPath":5}"#);
        assert_eq!(folder_for(&dir, "Projects/Plan.md"), "");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn file_names_are_cleaned_for_links() {
        assert_eq!(clean_file_name("C:\\Users\\amina\\photo.jpg").unwrap(), "photo.jpg");
        assert_eq!(clean_file_name("/tmp/x/Scan 2026 (1).pdf").unwrap(), "Scan 2026 (1).pdf");
        assert_eq!(clean_file_name("Picha ya Café.png").unwrap(), "Picha ya Café.png", "letters in any script stay");
        assert_eq!(clean_file_name("a|b^c#d.png").unwrap(), "a-b-c-d.png");
        assert_eq!(clean_file_name(".env").unwrap(), "env", "never a hidden file");
        assert_eq!(clean_file_name("  spaced.png  ").unwrap(), "spaced.png");
        for bad in ["", "   ", "dir/", "...", "./"] {
            assert_eq!(clean_file_name(bad).unwrap_err().to_string(), "That file has no usable name.", "{bad:?}");
        }
    }

    #[test]
    fn saved_names_are_unique_across_the_vault_without_case() {
        let dir = temp_vault("unique");
        let crypto = plain(&dir);
        put(&dir, "elsewhere/Photo.PNG", b"x");
        put(&dir, "Private/scan.pdf.age", b"x");
        put(&dir, ".trash/notes.txt", b"x");
        assert_eq!(save(&dir, "Plan.md", "photo.png", b"1", &crypto).unwrap(), "photo 1.png");
        assert_eq!(save(&dir, "Plan.md", "scan.pdf", b"1", &crypto).unwrap(), "scan 1.pdf", "an encrypted copy takes the name");
        assert_eq!(save(&dir, "Plan.md", "notes.txt", b"1", &crypto).unwrap(), "notes.txt", "the trash doesn't count");
        assert_eq!(save(&dir, "Plan.md", "README", b"1", &crypto).unwrap(), "README");
        assert_eq!(save(&dir, "Plan.md", "README", b"2", &crypto).unwrap(), "README 1");
        assert_eq!(save(&dir, "Plan.md", "archive.tar.gz", b"1", &crypto).unwrap(), "archive.tar.gz");
        assert_eq!(save(&dir, "Plan.md", "archive.tar.gz", b"2", &crypto).unwrap(), "archive.tar 1.gz");
        assert_eq!(std::fs::read(dir.join("README 1")).unwrap(), b"2");
        assert!(save(&dir, "Plan.md", "???", b"1", &crypto).is_ok(), "symbols become dashes");
        assert!(save(&dir, "Plan.md", "", b"1", &crypto).is_err());
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn encrypted_folders_and_notes_keep_their_pictures_encrypted() {
        let dir = temp_vault("encrypted");
        put(&dir, ".obsidian/app.json", br#"{"attachmentFolderPath":"./"}"#);
        let crypto = unlocked(&dir, &["Private"]);
        let rel = save(&dir, "Private/Diary.md.age", "face.jpg", b"jpeg bytes", &crypto).unwrap();
        assert_eq!(rel, "Private/face.jpg", "the link names the picture, not the .age file");
        assert!(!dir.join("Private/face.jpg").exists());
        let sealed = std::fs::read(dir.join("Private/face.jpg.age")).unwrap();
        assert!(sealed.starts_with(b"-----BEGIN AGE ENCRYPTED FILE-----"));

        // An encrypted note outside an encrypted folder: its picture is encrypted too.
        let rel = save(&dir, "Health.md.age", "xray.png", b"png", &crypto).unwrap();
        assert_eq!(rel, "xray.png");
        let found = resolve(&dir, "xray.png", "Health.md.age").unwrap();
        assert_eq!(found, "xray.png.age");
        assert_eq!(read(&dir, &found, &crypto).unwrap(), b"png");
        assert_eq!(read(&dir, &resolve(&dir, "face.jpg", "Private/Diary.md.age").unwrap(), &crypto).unwrap(), b"jpeg bytes");

        // A plain note's picture stays plain.
        assert_eq!(save(&dir, "Plan.md", "chart.png", b"c", &crypto).unwrap(), "chart.png");
        assert_eq!(std::fs::read(dir.join("chart.png")).unwrap(), b"c");

        // Locked on another device: the picture can't be read.
        let locked = Crypto::load(&dir, &crate::secrets::Secrets::new(dir.join(".phone")), "test/att");
        assert!(matches!(read(&dir, "xray.png.age", &locked), Err(crate::error::Error::Locked)));
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn an_encrypted_note_without_set_up_cannot_take_pictures() {
        let dir = temp_vault("no-setup");
        let crypto = plain(&dir);
        assert_eq!(save(&dir, "Diary.md.age", "a.png", b"x", &crypto).unwrap_err().to_string(), "Set up encryption first.");
        assert!(!dir.join("a.png").exists() && !dir.join("a.png.age").exists());
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn resolve_looks_beside_the_note_then_the_root_then_by_name() {
        let dir = temp_vault("resolve");
        put(&dir, "Projects/pic.png", b"beside");
        put(&dir, "pic.png", b"root");
        put(&dir, "deep/er/Unique Café.PNG", b"by name");
        put(&dir, "a/far/away/dup.png", b"long");
        put(&dir, "b/dup.png", b"short");
        put(&dir, ".trash/gone.png", b"x");
        assert_eq!(resolve(&dir, "pic.png", "Projects/Plan.md").as_deref(), Some("Projects/pic.png"));
        assert_eq!(resolve(&dir, "pic.png", "Daily/Today.md").as_deref(), Some("pic.png"));
        assert_eq!(resolve(&dir, "./pic.png", "Daily/Today.md").as_deref(), Some("pic.png"));
        assert_eq!(resolve(&dir, " /pic.png ", "Daily/Today.md").as_deref(), Some("pic.png"));
        assert_eq!(resolve(&dir, "unique café.png", "Plan.md").as_deref(), Some("deep/er/Unique Café.PNG"), "any case, any folder");
        assert_eq!(resolve(&dir, "dup.png", "Plan.md").as_deref(), Some("b/dup.png"), "the shortest path wins");
        assert_eq!(resolve(&dir, "other/dup.png", "Plan.md").as_deref(), Some("b/dup.png"), "a wrong folder still finds the name");
        assert_eq!(resolve(&dir, "gone.png", "Plan.md"), None, "hidden folders are not searched");
        assert_eq!(resolve(&dir, "", "Plan.md"), None);
        assert_eq!(resolve(&dir, "  ", "Plan.md"), None);
        assert_eq!(resolve(&dir, "Projects", "Plan.md"), None, "a folder is not a file");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn read_refuses_paths_outside_the_vault() {
        let dir = temp_vault("read");
        let crypto = plain(&dir);
        assert!(read(&dir, "../secret", &crypto).is_err());
        assert_eq!(read(&dir, "missing.png", &crypto).unwrap_err().friendly().0, "not_found");
        let _ = std::fs::remove_dir_all(&dir);
    }
}
