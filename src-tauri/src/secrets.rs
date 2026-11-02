//! Tokens and keys. Keychain on Mac and iPhone; app-private storage on Android
//! (only Wandika can read its own data directory there).

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

    #[cfg(any(target_os = "macos", target_os = "ios"))]
    pub fn get(&self, key: &str) -> Option<String> {
        keyring::Entry::new(SERVICE, key).ok()?.get_password().ok()
    }

    #[cfg(any(target_os = "macos", target_os = "ios"))]
    pub fn set(&self, key: &str, value: &str) -> Result<()> {
        keyring::Entry::new(SERVICE, key)
            .and_then(|e| e.set_password(value))
            .map_err(|_| crate::error::msg("Couldn't save your sign-in to the keychain. Try again."))
    }

    #[cfg(any(target_os = "macos", target_os = "ios"))]
    pub fn delete(&self, key: &str) {
        if let Ok(e) = keyring::Entry::new(SERVICE, key) {
            let _ = e.delete_credential();
        }
    }

    #[cfg(not(any(target_os = "macos", target_os = "ios")))]
    fn file(&self, key: &str) -> PathBuf {
        let _ = SERVICE;
        self.dir.join("secrets").join(key)
    }

    #[cfg(not(any(target_os = "macos", target_os = "ios")))]
    pub fn get(&self, key: &str) -> Option<String> {
        std::fs::read_to_string(self.file(key)).ok()
    }

    #[cfg(not(any(target_os = "macos", target_os = "ios")))]
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

    #[cfg(not(any(target_os = "macos", target_os = "ios")))]
    pub fn delete(&self, key: &str) {
        let _ = std::fs::remove_file(self.file(key));
    }
}
