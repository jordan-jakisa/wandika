//! Tokens and keys. Keychain on Mac and iPhone; app-private storage on Android
//! (only Wandika can read its own data directory there). Tests use the file store everywhere, so
//! they never touch the keychain.

use crate::error::Result;
use std::path::PathBuf;

const SERVICE: &str = "me.jordanjakisa.wandika";

pub struct Secrets {
    #[allow(dead_code)]
    dir: PathBuf,
}

impl Secrets {
    pub fn new(dir: PathBuf) -> Self {
        Self { dir }
    }

    pub fn get_json<T: serde::de::DeserializeOwned>(&self, key: &str) -> Option<T> {
        self.get(key).and_then(|s| serde_json::from_str(&s).ok())
    }

    pub fn set_json<T: serde::Serialize>(&self, key: &str, value: &T) -> Result<()> {
        self.set(key, &serde_json::to_string(value)?)
    }

    #[cfg(all(any(target_os = "macos", target_os = "ios"), not(test)))]
    pub fn get(&self, key: &str) -> Option<String> {
        keyring::Entry::new(SERVICE, key).ok()?.get_password().ok()
    }

    #[cfg(all(any(target_os = "macos", target_os = "ios"), not(test)))]
    pub fn set(&self, key: &str, value: &str) -> Result<()> {
        keyring::Entry::new(SERVICE, key)
            .and_then(|e| e.set_password(value))
            .map_err(|_| crate::error::msg("Couldn't save your sign-in to the keychain. Try again."))
    }

    #[cfg(all(any(target_os = "macos", target_os = "ios"), not(test)))]
    pub fn delete(&self, key: &str) {
        if let Ok(e) = keyring::Entry::new(SERVICE, key) {
            let _ = e.delete_credential();
        }
    }

    #[cfg(any(not(any(target_os = "macos", target_os = "ios")), test))]
    fn file(&self, key: &str) -> PathBuf {
        let _ = SERVICE;
        self.dir.join("secrets").join(key)
    }

    #[cfg(any(not(any(target_os = "macos", target_os = "ios")), test))]
    pub fn get(&self, key: &str) -> Option<String> {
        std::fs::read_to_string(self.file(key)).ok()
    }

    #[cfg(any(not(any(target_os = "macos", target_os = "ios")), test))]
    pub fn set(&self, key: &str, value: &str) -> Result<()> {
        let path = self.file(key);
        std::fs::create_dir_all(path.parent().unwrap())?;
        std::fs::write(&path, value)?;
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o600))?;
        }
        Ok(())
    }

    #[cfg(any(not(any(target_os = "macos", target_os = "ios")), test))]
    pub fn delete(&self, key: &str) {
        let _ = std::fs::remove_file(self.file(key));
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

    #[cfg(unix)]
    #[test]
    fn stored_secrets_are_readable_only_by_this_user() {
        use std::os::unix::fs::PermissionsExt;
        let dir = dir("mode");
        let s = Secrets::new(dir.clone());
        s.set("age-identity:local/notes", "AGE-SECRET-KEY-1").unwrap();
        let mode = std::fs::metadata(s.file("age-identity:local/notes")).unwrap().permissions().mode();
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
