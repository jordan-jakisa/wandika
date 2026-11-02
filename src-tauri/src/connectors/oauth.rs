//! OAuth plumbing shared by Google and Microsoft: PKCE, token storage and refresh.

use crate::error::{msg, Error, Result};
use crate::secrets::Secrets;
use base64::Engine;
use rand::{distributions::Alphanumeric, Rng};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use sha2::{Digest, Sha256};

#[derive(Serialize, Deserialize, Clone)]
pub struct TokenSet {
    pub access_token: String,
    pub refresh_token: Option<String>,
    pub expires_at: i64,
    #[serde(default)]
    pub account: Option<String>,
}

pub struct Pkce {
    pub verifier: String,
    pub challenge: String,
}

pub fn pkce() -> Pkce {
    let verifier: String = rand::thread_rng().sample_iter(&Alphanumeric).take(64).map(char::from).collect();
    let challenge = base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(Sha256::digest(verifier.as_bytes()));
    Pkce { verifier, challenge }
}

pub fn random_state() -> String {
    rand::thread_rng().sample_iter(&Alphanumeric).take(24).map(char::from).collect()
}

/// A browser sign-in that is waiting for its redirect.
#[derive(Clone)]
pub struct Pending {
    pub provider: &'static str,
    pub verifier: String,
    pub state: String,
    pub redirect_uri: String,
}

pub fn now() -> i64 {
    chrono::Utc::now().timestamp()
}

/// Reads an OAuth token response, keeping the old refresh token when the provider doesn't rotate it.
pub fn token_from(provider: &'static str, v: &Value, previous_refresh: Option<String>) -> Result<TokenSet> {
    if let Some(err) = v.get("error").and_then(Value::as_str) {
        let detail = v["error_description"].as_str().unwrap_or(err);
        return Err(Error::Provider { provider, status: 400, message: detail.to_string() });
    }
    Ok(TokenSet {
        access_token: v["access_token"].as_str().ok_or_else(|| msg(format!("{provider} didn't return a token.")))?.to_string(),
        refresh_token: v["refresh_token"].as_str().map(str::to_string).or(previous_refresh),
        expires_at: now() + v["expires_in"].as_i64().unwrap_or(3600),
        account: None,
    })
}

pub async fn post_form(http: &reqwest::Client, url: &str, form: &[(&str, &str)]) -> Result<Value> {
    Ok(http.post(url).header("Accept", "application/json").form(form).send().await?.json().await?)
}

/// Returns a valid access token, refreshing it with `refresh` when it is about to expire.
pub async fn access_token<F, Fut>(secrets: &Secrets, key: &'static str, refresh: F) -> Result<String>
where
    F: FnOnce(String) -> Fut,
    Fut: std::future::Future<Output = Result<TokenSet>>,
{
    let name = match key {
        "google" => "Google",
        "microsoft" => "Outlook",
        other => other,
    };
    let tokens: TokenSet = secrets.get_json(key).ok_or_else(|| msg(format!("Connect {name} in Settings first.")))?;
    if tokens.expires_at - 60 > now() {
        return Ok(tokens.access_token);
    }
    let refresh_token = tokens
        .refresh_token
        .clone()
        .ok_or_else(|| Error::Provider { provider: name, status: 401, message: "refresh token missing or rejected".into() })?;
    let mut fresh = refresh(refresh_token).await.map_err(|e| match e {
        Error::Provider { .. } => Error::Provider { provider: name, status: 401, message: "refresh token missing or rejected".into() },
        other => other,
    })?;
    fresh.account = tokens.account;
    secrets.set_json(key, &fresh)?;
    Ok(fresh.access_token)
}

pub async fn check_json(provider: &'static str, res: reqwest::Response) -> Result<Value> {
    let status = res.status().as_u16();
    let v: Value = res.json().await.unwrap_or(Value::Null);
    if status >= 400 {
        let message = v["error"]["message"]
            .as_str()
            .or_else(|| v["error_description"].as_str())
            .or_else(|| v["error"].as_str())
            .unwrap_or("request failed")
            .to_string();
        return Err(Error::Provider { provider, status, message });
    }
    Ok(v)
}
