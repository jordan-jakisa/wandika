//! Encrypted notes and folders.
//!
//! A vault gets one age X25519 key. Its secret half is stored in the repo, encrypted with Jordan's
//! passphrase (scrypt), in `.wandika/encryption.json`. Each device unlocks it once and keeps it in
//! the keychain. Encrypted notes are ASCII-armored `.age` files, readable with the `age` CLI.

use crate::error::{msg, Result};
use crate::secrets::Secrets;
use age::armor::{ArmoredReader, ArmoredWriter, Format};
use age::secrecy::{ExposeSecret, SecretString};
use serde::{Deserialize, Serialize};
use std::io::{Read, Write};
use std::path::{Path, PathBuf};

pub const CONFIG_PATH: &str = ".wandika/encryption.json";
pub const EXT: &str = ".age";

#[derive(Serialize, Deserialize, Clone, Default)]
pub struct EncConfig {
    pub version: u32,
    /// Public half; anyone with the repo can encrypt, only the key holder can read.
    pub recipient: String,
    /// The secret key, encrypted with the passphrase (armored age file).
    pub identity: String,
    /// Folders whose new notes are encrypted automatically.
    #[serde(default)]
    pub folders: Vec<String>,
}

pub struct Crypto {
    pub config: Option<EncConfig>,
    identity: Option<age::x25519::Identity>,
}

#[derive(Serialize)]
pub struct CryptoStatus {
    pub set_up: bool,
    pub unlocked: bool,
    pub folders: Vec<String>,
}

fn secret_key(vault_id: &str) -> String {
    format!("age-identity:{vault_id}")
}

fn config_file(root: &Path) -> PathBuf {
    root.join(CONFIG_PATH)
}

pub fn is_encrypted(rel: &str) -> bool {
    rel.ends_with(EXT)
}

fn encrypt_to(recipient: &dyn age::Recipient, data: &[u8]) -> Result<Vec<u8>> {
    let enc = age::Encryptor::with_recipients(std::iter::once(recipient))
        .map_err(|_| msg("Couldn't encrypt this note. Try again."))?;
    let mut out = Vec::new();
    let armor = ArmoredWriter::wrap_output(&mut out, Format::AsciiArmor)?;
    let mut w = enc.wrap_output(armor)?;
    w.write_all(data)?;
    w.finish()?.finish()?;
    Ok(out)
}

fn decrypt_with(identity: &dyn age::Identity, data: &[u8]) -> Result<Vec<u8>> {
    let dec = age::Decryptor::new_buffered(ArmoredReader::new(data))
        .map_err(|_| msg("This file is damaged, or isn't an encrypted note."))?;
    let mut r = dec
        .decrypt(std::iter::once(identity))
        .map_err(|_| msg("This note was encrypted with a different key, so this vault's passphrase can't open it."))?;
    let mut out = Vec::new();
    r.read_to_end(&mut out)?;
    Ok(out)
}

impl Crypto {
    pub fn load(root: &Path, secrets: &Secrets, vault_id: &str) -> Self {
        let config = std::fs::read(config_file(root))
            .ok()
            .and_then(|b| serde_json::from_slice::<EncConfig>(&b).ok());
        let identity = config.as_ref().and_then(|_| {
            secrets.get(&secret_key(vault_id)).and_then(|s| s.trim().parse().ok())
        });
        Self { config, identity }
    }

    pub fn status(&self) -> CryptoStatus {
        CryptoStatus {
            set_up: self.config.is_some(),
            unlocked: self.identity.is_some(),
            folders: self.config.as_ref().map(|c| c.folders.clone()).unwrap_or_default(),
        }
    }

    pub fn unlocked(&self) -> bool {
        self.identity.is_some()
    }

    /// First-time setup: new key, protected by the passphrase, written into the vault.
    pub fn set_up(root: &Path, secrets: &Secrets, vault_id: &str, passphrase: &str) -> Result<Self> {
        if passphrase.chars().count() < 8 {
            return Err(msg("Use a passphrase of at least 8 characters."));
        }
        if config_file(root).exists() {
            return Err(msg("Encryption is already set up for this vault. Unlock it instead."));
        }
        let identity = age::x25519::Identity::generate();
        let secret = identity.to_string();
        let scrypt = age::scrypt::Recipient::new(SecretString::from(passphrase.to_string()));
        let wrapped = encrypt_to(&scrypt, secret.expose_secret().as_bytes())?;
        let config = EncConfig {
            version: 1,
            recipient: identity.to_public().to_string(),
            identity: String::from_utf8(wrapped).map_err(|_| msg("Couldn't armor the key."))?,
            folders: Vec::new(),
        };
        save_config(root, &config)?;
        secrets.set(&secret_key(vault_id), secret.expose_secret())?;
        Ok(Self { config: Some(config), identity: Some(identity) })
    }

    pub fn unlock(root: &Path, secrets: &Secrets, vault_id: &str, passphrase: &str) -> Result<Self> {
        let mut me = Self::load(root, secrets, vault_id);
        let config = me.config.clone().ok_or_else(|| msg("Encryption isn't set up for this vault."))?;
        let scrypt = age::scrypt::Identity::new(SecretString::from(passphrase.to_string()));
        let secret = decrypt_with(&scrypt, config.identity.as_bytes())
            .map_err(|_| msg("That passphrase didn't unlock this vault. Check it and try again."))?;
        let secret = String::from_utf8(secret).map_err(|_| msg("The stored key is damaged."))?;
        let identity: age::x25519::Identity =
            secret.trim().parse().map_err(|_| msg("The stored key is damaged."))?;
        secrets.set(&secret_key(vault_id), secret.trim())?;
        me.identity = Some(identity);
        Ok(me)
    }

    pub fn lock(secrets: &Secrets, vault_id: &str) {
        secrets.delete(&secret_key(vault_id));
    }

    pub fn encrypt(&self, data: &[u8]) -> Result<Vec<u8>> {
        let config = self.config.as_ref().ok_or_else(|| msg("Set up encryption first."))?;
        let recipient: age::x25519::Recipient =
            config.recipient.parse().map_err(|_| msg("The vault's public key is damaged."))?;
        encrypt_to(&recipient, data)
    }

    pub fn decrypt(&self, data: &[u8]) -> Result<Vec<u8>> {
        let identity = self
            .identity
            .as_ref()
            .ok_or(crate::error::Error::Locked)?;
        decrypt_with(identity, data)
    }

    /// True when a new note at `rel` should be created encrypted.
    pub fn folder_is_encrypted(&self, folder: &str) -> bool {
        let folder = folder.trim_matches('/');
        self.config.as_ref().is_some_and(|c| {
            c.folders.iter().any(|f| folder == f || folder.starts_with(&format!("{f}/")))
        })
    }
}

pub fn save_config(root: &Path, config: &EncConfig) -> Result<()> {
    let path = config_file(root);
    std::fs::create_dir_all(path.parent().unwrap())?;
    std::fs::write(path, serde_json::to_vec_pretty(config)?)?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::error::Error;

    /// A vault folder and this device's secrets, kept apart like the real app keeps them.
    fn vault(tag: &str) -> (PathBuf, Secrets) {
        let base = std::env::temp_dir().join(format!("wandika-crypto-{tag}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&base);
        std::fs::create_dir_all(base.join("files")).unwrap();
        (base.join("files"), Secrets::new(base.join("device")))
    }

    fn cleanup(root: &Path) {
        let _ = std::fs::remove_dir_all(root.parent().unwrap());
    }

    fn message(e: Error) -> String {
        e.to_string()
    }

    #[test]
    fn set_up_encrypts_round_trips_and_another_device_unlocks_with_the_passphrase() {
        let (root, secrets) = vault("setup");
        let me = Crypto::set_up(&root, &secrets, "local/notes", "kampala river").unwrap();
        assert!(me.unlocked());
        let status = me.status();
        assert!(status.set_up && status.unlocked && status.folders.is_empty());

        let config: EncConfig = serde_json::from_slice(&std::fs::read(root.join(CONFIG_PATH)).unwrap()).unwrap();
        assert_eq!(config.version, 1);
        assert!(config.recipient.starts_with("age1"));
        assert!(config.identity.starts_with("-----BEGIN AGE ENCRYPTED FILE-----"), "the key is stored armored");
        assert!(!config.identity.contains("AGE-SECRET-KEY"), "never in the clear");
        assert!(secrets.get(&secret_key("local/notes")).unwrap().starts_with("AGE-SECRET-KEY-"));

        let text = "Diary: 🌧 in Kampala\n".as_bytes();
        let sealed = me.encrypt(text).unwrap();
        assert!(String::from_utf8(sealed.clone()).unwrap().starts_with("-----BEGIN AGE ENCRYPTED FILE-----"));
        assert_eq!(me.decrypt(&sealed).unwrap(), text);
        assert_ne!(me.encrypt(text).unwrap(), sealed, "each encryption is fresh");
        assert_eq!(me.decrypt(&me.encrypt(b"").unwrap()).unwrap(), b"", "an empty note round trips");

        // The same vault on a phone: set up, locked, and anyone with the repo can still encrypt.
        let phone = Secrets::new(root.parent().unwrap().join("phone"));
        let locked = Crypto::load(&root, &phone, "local/notes");
        assert_eq!((locked.status().set_up, locked.status().unlocked), (true, false));
        assert!(matches!(locked.decrypt(&sealed), Err(Error::Locked)));
        let from_phone = locked.encrypt(b"written while locked").unwrap();

        let wrong = Crypto::unlock(&root, &phone, "local/notes", "kampala rivers").err().unwrap();
        assert_eq!(message(wrong), "That passphrase didn't unlock this vault. Check it and try again.");
        assert!(phone.get(&secret_key("local/notes")).is_none(), "a wrong passphrase stores nothing");

        let unlocked = Crypto::unlock(&root, &phone, "local/notes", "kampala river").unwrap();
        assert_eq!(unlocked.decrypt(&sealed).unwrap(), text);
        assert_eq!(me.decrypt(&from_phone).unwrap(), b"written while locked");
        // Unlocked once, the phone stays unlocked on the next start.
        assert!(Crypto::load(&root, &phone, "local/notes").unlocked());

        Crypto::lock(&phone, "local/notes");
        assert!(!Crypto::load(&root, &phone, "local/notes").unlocked());
        assert!(Crypto::load(&root, &secrets, "local/notes").unlocked(), "locking one device leaves the other");
        cleanup(&root);
    }

    #[test]
    fn set_up_refuses_short_passphrases_and_a_second_set_up() {
        let (root, secrets) = vault("refuse");
        let short = Crypto::set_up(&root, &secrets, "v", "seven77").err().unwrap();
        assert_eq!(message(short), "Use a passphrase of at least 8 characters.");
        // Characters, not bytes: four two-byte letters are still too short.
        assert!(Crypto::set_up(&root, &secrets, "v", "ééüü").is_err());
        assert!(!root.join(CONFIG_PATH).exists(), "nothing written for a refused passphrase");

        std::fs::create_dir_all(root.join(".wandika")).unwrap();
        std::fs::write(root.join(CONFIG_PATH), "{}").unwrap();
        let again = Crypto::set_up(&root, &secrets, "v", "long enough").err().unwrap();
        assert!(message(again).starts_with("Encryption is already set up"));
        cleanup(&root);
    }

    #[test]
    fn unlock_without_set_up_says_so() {
        let (root, secrets) = vault("unset");
        let e = Crypto::unlock(&root, &secrets, "v", "whatever passphrase").err().unwrap();
        assert_eq!(message(e), "Encryption isn't set up for this vault.");
        let none = Crypto::load(&root, &secrets, "v");
        assert!(!none.status().set_up && !none.unlocked());
        assert_eq!(message(none.encrypt(b"x").unwrap_err()), "Set up encryption first.");
        assert!(matches!(none.decrypt(b"x"), Err(Error::Locked)));
        cleanup(&root);
    }

    #[test]
    fn damaged_or_foreign_files_are_refused() {
        let (root, _) = vault("tamper");
        let a = Crypto { config: None, identity: Some(age::x25519::Identity::generate()) };
        let recipient = a.identity.as_ref().unwrap().to_public();
        let sealed = encrypt_to(&recipient, b"secret plans").unwrap();
        assert_eq!(a.decrypt(&sealed).unwrap(), b"secret plans");

        assert_eq!(message(a.decrypt(b"# Just a note\n").unwrap_err()), "This file is damaged, or isn't an encrypted note.");

        // One changed character in the body: the armor or the authentication catches it.
        let mut tampered = String::from_utf8(sealed.clone()).unwrap();
        let at = tampered.len() / 2;
        let c = tampered.as_bytes()[at];
        let swap = if c == b'A' { "B" } else { "A" };
        tampered.replace_range(at..at + 1, swap);
        assert!(a.decrypt(tampered.as_bytes()).is_err(), "a tampered note never decrypts");

        // Cut short.
        assert!(a.decrypt(&sealed[..sealed.len() / 2]).is_err());

        let b = Crypto { config: None, identity: Some(age::x25519::Identity::generate()) };
        assert_eq!(
            message(b.decrypt(&sealed).unwrap_err()),
            "This note was encrypted with a different key, so this vault's passphrase can't open it."
        );
        cleanup(&root);
    }

    #[test]
    fn damaged_config_and_stored_key_read_as_not_set_up_or_locked() {
        let (root, secrets) = vault("damaged");
        std::fs::create_dir_all(root.join(".wandika")).unwrap();
        std::fs::write(root.join(CONFIG_PATH), "not json").unwrap();
        assert!(Crypto::load(&root, &secrets, "v").config.is_none());

        let mut config = EncConfig { version: 1, recipient: "age1nope".into(), identity: String::new(), folders: vec![] };
        save_config(&root, &config).unwrap();
        secrets.set(&secret_key("v"), "not a key").unwrap();
        let c = Crypto::load(&root, &secrets, "v");
        assert!(c.status().set_up && !c.unlocked(), "a damaged stored key reads as locked");
        assert_eq!(message(c.encrypt(b"x").unwrap_err()), "The vault's public key is damaged.");

        // A stored identity whose armor holds something other than a key.
        let scrypt = age::scrypt::Recipient::new(SecretString::from("long enough".to_string()));
        config.identity = String::from_utf8(encrypt_to(&scrypt, b"not a key").unwrap()).unwrap();
        save_config(&root, &config).unwrap();
        let e = Crypto::unlock(&root, &secrets, "v", "long enough").err().unwrap();
        assert_eq!(message(e), "The stored key is damaged.");
        cleanup(&root);
    }

    #[test]
    fn folders_cover_their_subfolders_only() {
        let c = Crypto {
            config: Some(EncConfig { folders: vec!["Private".into(), "Work/HR".into()], ..Default::default() }),
            identity: None,
        };
        assert!(c.folder_is_encrypted("Private"));
        assert!(c.folder_is_encrypted("/Private/"));
        assert!(c.folder_is_encrypted("Private/Diary/2026"));
        assert!(c.folder_is_encrypted("Work/HR"));
        assert!(!c.folder_is_encrypted("Work"));
        assert!(!c.folder_is_encrypted("Private notes"), "a longer name is another folder");
        assert!(!c.folder_is_encrypted(""));
        assert_eq!(c.status().folders, vec!["Private", "Work/HR"]);
        let none = Crypto { config: None, identity: None };
        assert!(!none.folder_is_encrypted("Private"));
    }

    #[test]
    fn age_files_are_encrypted_and_others_are_not() {
        assert!(is_encrypted("Private/Diary.md.age"));
        assert!(is_encrypted("photo.png.age"));
        assert!(!is_encrypted("Plan.md"));
        assert!(!is_encrypted("age"));
        assert!(!is_encrypted("Notes/page.agenda.md"));
    }

    #[test]
    fn save_config_creates_its_folder() {
        let (root, _) = vault("save");
        let config = EncConfig { version: 1, recipient: "r".into(), identity: "i".into(), folders: vec!["Ünïcode/日記".into()] };
        save_config(&root, &config).unwrap();
        let back: EncConfig = serde_json::from_slice(&std::fs::read(root.join(CONFIG_PATH)).unwrap()).unwrap();
        assert_eq!(back.folders, vec!["Ünïcode/日記"]);
        // Older configs without a folder list still load.
        let old: EncConfig = serde_json::from_str(r#"{"version":1,"recipient":"r","identity":"i"}"#).unwrap();
        assert!(old.folders.is_empty());
        cleanup(&root);
    }
}
