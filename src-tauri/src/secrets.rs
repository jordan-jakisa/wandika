//! Tokens and keys. Keychain on Mac and iPhone; app-private storage on Android
//! (only Wandika can read its own data directory there). Tests use the file store everywhere, so
//! they never touch the keychain.
//!
//! Everything lives in one item, read once per launch and kept in memory. On the Mac each keychain
//! item can ask for the login password on its own, so one item means one ask at most, and the
//! status checks that run all the time never reach the keychain.

use crate::error::Result;
use serde::{Deserialize, Serialize};
use std::collections::{BTreeMap, BTreeSet};
use std::path::PathBuf;
use std::sync::Mutex;

const SERVICE: &str = "me.jordanjakisa.wandika";
/// The keychain account (or file name) that holds every secret.
const STORE: &str = "store";

#[derive(Default, Serialize, Deserialize)]
struct Blob {
    items: BTreeMap<String, String>,
    /// Keys whose old one-item-per-key copy has been moved in (or found missing), so it is never
    /// read again, and a disconnected account can't come back from it.
    #[serde(default)]
    moved: BTreeSet<String>,
}

pub struct Secrets {
    #[allow(dead_code)]
    dir: PathBuf,
    blob: Mutex<Option<Blob>>,
}

impl Secrets {
    pub fn new(dir: PathBuf) -> Self {
        Self { dir, blob: Mutex::new(None) }
    }

    pub fn get_json<T: serde::de::DeserializeOwned>(&self, key: &str) -> Option<T> {
        self.get(key).and_then(|s| serde_json::from_str(&s).ok())
    }

    pub fn set_json<T: serde::Serialize>(&self, key: &str, value: &T) -> Result<()> {
        self.set(key, &serde_json::to_string(value)?)
    }

    pub fn get(&self, key: &str) -> Option<String> {
        self.with(key, |b| Ok(b.items.get(key).cloned())).ok().flatten()
    }

    pub fn set(&self, key: &str, value: &str) -> Result<()> {
        self.with(key, |b| {
            b.items.insert(key.to_string(), value.to_string());
            Ok(true)
        })
        .map(|_| ())
    }

    pub fn delete(&self, key: &str) {
        let _ = self.with(key, |b| Ok(b.items.remove(key).is_some()));
    }

    /// Runs `f` on the loaded store and writes it back when `f` returns `true` (or any `Some`),
    /// or when an old copy of `key` was moved in first.
    fn with<T: Changed>(&self, key: &str, f: impl FnOnce(&mut Blob) -> Result<T>) -> Result<T> {
        let mut guard = self.blob.lock().unwrap_or_else(|e| e.into_inner());
        if guard.is_none() {
            let blob = match self.read_store()? {
                Some(text) => serde_json::from_str(&text).unwrap_or_default(),
                None => Blob::default(),
            };
            *guard = Some(blob);
        }
        let blob = guard.as_mut().expect("loaded above");
        let mut dirty = false;
        if blob.moved.insert(key.to_string()) {
            if let Some(old) = self.take_old(key) {
                blob.items.entry(key.to_string()).or_insert(old);
            }
            dirty = true;
        }
        let out = f(blob)?;
        if dirty || out.changed() {
            self.write_store(&serde_json::to_string(blob)?)?;
        }
        Ok(out)
    }

    #[cfg(all(any(target_os = "macos", target_os = "ios"), not(test)))]
    fn read_store(&self) -> Result<Option<String>> {
        match keyring::Entry::new(SERVICE, STORE).and_then(|e| e.get_password()) {
            Ok(text) => Ok(Some(text)),
            Err(keyring::Error::NoEntry) => Ok(None),
            Err(_) => Err(crate::error::msg("Wandika couldn't open your sign-ins in the keychain. Try again.")),
        }
    }

    #[cfg(all(any(target_os = "macos", target_os = "ios"), not(test)))]
    fn write_store(&self, text: &str) -> Result<()> {
        keyring::Entry::new(SERVICE, STORE)
            .and_then(|e| e.set_password(text))
            .map_err(|_| crate::error::msg("Couldn't save your sign-in to the keychain. Try again."))
    }

    /// Older builds kept one keychain item per key. Read it once; it is left in place, because
    /// deleting an item another build made can ask for the password again.
    #[cfg(all(any(target_os = "macos", target_os = "ios"), not(test)))]
    fn take_old(&self, key: &str) -> Option<String> {
        keyring::Entry::new(SERVICE, key).ok()?.get_password().ok()
    }

    #[cfg(any(not(any(target_os = "macos", target_os = "ios")), test))]
    fn store_file(&self) -> PathBuf {
        let _ = SERVICE;
        self.dir.join("secrets").join(format!("{STORE}.json"))
    }

    #[cfg(any(not(any(target_os = "macos", target_os = "ios")), test))]
    fn read_store(&self) -> Result<Option<String>> {
        match std::fs::read_to_string(self.store_file()) {
            Ok(text) => Ok(Some(text)),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(None),
            Err(e) => Err(e.into()),
        }
    }

    #[cfg(any(not(any(target_os = "macos", target_os = "ios")), test))]
    fn write_store(&self, text: &str) -> Result<()> {
        let path = self.store_file();
        std::fs::create_dir_all(path.parent().unwrap())?;
        let tmp = path.with_extension("tmp");
        std::fs::write(&tmp, text)?;
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            std::fs::set_permissions(&tmp, std::fs::Permissions::from_mode(0o600))?;
        }
        std::fs::rename(&tmp, &path)?;
        Ok(())
    }

    /// Older builds kept one file per key; move it in and remove it.
    #[cfg(any(not(any(target_os = "macos", target_os = "ios")), test))]
    fn take_old(&self, key: &str) -> Option<String> {
        let path = self.dir.join("secrets").join(key);
        let text = std::fs::read_to_string(&path).ok()?;
        let _ = std::fs::remove_file(&path);
        Some(text)
    }
}

/// Whether a store operation changed anything that needs writing back.
trait Changed {
    fn changed(&self) -> bool;
}

impl Changed for bool {
    fn changed(&self) -> bool {
        *self
    }
}

impl Changed for Option<String> {
    fn changed(&self) -> bool {
        false
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn dir(tag: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("wandika-secrets-{tag}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        dir
    }

    #[test]
    fn stores_reads_and_deletes_a_secret() {
        let dir = dir("plain");
        let s = Secrets::new(dir.clone());
        assert_eq!(s.get("github"), None, "nothing stored yet");
        s.set("github", "gho_token").unwrap();
        assert_eq!(s.get("github").as_deref(), Some("gho_token"));
        s.set("github", "gho_newer").unwrap();
        assert_eq!(s.get("github").as_deref(), Some("gho_newer"), "a second save replaces the first");
        s.delete("github");
        assert_eq!(s.get("github"), None);
        s.delete("github");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn every_secret_shares_one_store_that_a_new_launch_reads_back() {
        let dir = dir("one");
        let s = Secrets::new(dir.clone());
        s.set("github", "gho").unwrap();
        s.set("google", "{}").unwrap();
        s.set("age-identity:local/notes", "AGE-SECRET-KEY-1").unwrap();
        let files: Vec<_> = std::fs::read_dir(dir.join("secrets")).unwrap().flatten().map(|e| e.file_name()).collect();
        assert_eq!(files, vec![std::ffi::OsString::from("store.json")]);
        let again = Secrets::new(dir.clone());
        assert_eq!(again.get("google").as_deref(), Some("{}"));
        assert_eq!(again.get("age-identity:local/notes").as_deref(), Some("AGE-SECRET-KEY-1"));
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn reads_after_the_first_come_from_memory() {
        let dir = dir("cache");
        let s = Secrets::new(dir.clone());
        s.set("github", "gho").unwrap();
        assert!(s.get("microsoft").is_none(), "checks the old copy once and records it");
        std::fs::remove_dir_all(&dir).unwrap();
        assert_eq!(s.get("github").as_deref(), Some("gho"), "no second read of the store");
        assert!(s.get("microsoft").is_none());
        assert!(!dir.exists(), "a read that changes nothing writes nothing");
    }

    #[test]
    fn an_old_one_per_key_copy_moves_in_once_and_a_disconnect_stays_disconnected() {
        let dir = dir("move");
        std::fs::create_dir_all(dir.join("secrets")).unwrap();
        std::fs::write(dir.join("secrets").join("github"), "gho_old").unwrap();
        let s = Secrets::new(dir.clone());
        assert_eq!(s.get("github").as_deref(), Some("gho_old"));
        assert!(!dir.join("secrets").join("github").exists());
        s.delete("github");
        std::fs::write(dir.join("secrets").join("github"), "gho_stale").unwrap();
        assert_eq!(Secrets::new(dir.clone()).get("github"), None, "an old copy is read only once");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[cfg(unix)]
    #[test]
    fn stored_secrets_are_readable_only_by_this_user() {
        use std::os::unix::fs::PermissionsExt;
        let dir = dir("mode");
        let s = Secrets::new(dir.clone());
        s.set("age-identity:local/notes", "AGE-SECRET-KEY-1").unwrap();
        let mode = std::fs::metadata(s.store_file()).unwrap().permissions().mode();
        assert_eq!(mode & 0o777, 0o600);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn json_round_trips_and_bad_json_reads_as_missing() {
        let dir = dir("json");
        let s = Secrets::new(dir.clone());
        s.set_json("google", &serde_json::json!({ "access_token": "a", "expires_at": 5 })).unwrap();
        let v: serde_json::Value = s.get_json("google").unwrap();
        assert_eq!(v["access_token"], "a");
        s.set("google", "not json").unwrap();
        assert!(s.get_json::<serde_json::Value>("google").is_none());
        assert!(s.get_json::<serde_json::Value>("missing").is_none());
        let _ = std::fs::remove_dir_all(&dir);
    }
}
