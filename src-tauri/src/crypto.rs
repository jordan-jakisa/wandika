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
        .map_err(|e| msg(format!("Couldn't encrypt: {e}")))?;
    let mut out = Vec::new();
    let armor = ArmoredWriter::wrap_output(&mut out, Format::AsciiArmor)?;
    let mut w = enc.wrap_output(armor)?;
    w.write_all(data)?;
    w.finish()?.finish()?;
    Ok(out)
}

fn decrypt_with(identity: &dyn age::Identity, data: &[u8]) -> Result<Vec<u8>> {
    let dec = age::Decryptor::new_buffered(ArmoredReader::new(data))
        .map_err(|e| msg(format!("This file isn't a readable age file: {e}")))?;
    let mut r = dec
        .decrypt(std::iter::once(identity))
        .map_err(|_| msg("Wrong passphrase, or this file was encrypted with another key."))?;
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
        let secret = decrypt_with(&scrypt, config.identity.as_bytes())?;
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
            .ok_or_else(|| msg("Encrypted notes are locked. Unlock them with your passphrase."))?;
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
