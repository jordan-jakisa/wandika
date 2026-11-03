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

#[cfg(test)]
mod tests {
    use super::*;
    use crate::test_http::{block_on, reply, serve};
    use serde_json::json;

    fn secrets(tag: &str) -> (std::path::PathBuf, Secrets) {
        let dir = std::env::temp_dir().join(format!("wandika-oauth-{tag}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        (dir.clone(), Secrets::new(dir))
    }

    fn stored(access: &str, refresh: Option<&str>, expires_at: i64) -> TokenSet {
        TokenSet { access_token: access.into(), refresh_token: refresh.map(str::to_string), expires_at, account: Some("amina@example.com".into()) }
    }

    #[test]
    fn pkce_challenge_is_the_s256_of_a_fresh_verifier() {
        let p = pkce();
        assert_eq!(p.verifier.len(), 64);
        assert!(p.verifier.chars().all(|c| c.is_ascii_alphanumeric()));
        let expected = base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(Sha256::digest(p.verifier.as_bytes()));
        assert_eq!(p.challenge, expected);
        assert_eq!(p.challenge.len(), 43);
        assert!(!p.challenge.contains(['=', '+', '/']), "URL-safe, unpadded");
        assert_ne!(pkce().verifier, p.verifier);
        let s = random_state();
        assert_eq!(s.len(), 24);
        assert!(s.chars().all(|c| c.is_ascii_alphanumeric()));
        assert_ne!(random_state(), s);
    }

    #[test]
    fn token_answers_keep_the_old_refresh_token_unless_rotated() {
        let t = token_from("Google", &json!({ "access_token": "a1", "expires_in": 120 }), Some("r-old".into())).unwrap();
        assert_eq!((t.access_token.as_str(), t.refresh_token.as_deref()), ("a1", Some("r-old")));
        assert!((t.expires_at - (now() + 120)).abs() <= 1);
        assert!(t.account.is_none());
        let t = token_from("Google", &json!({ "access_token": "a2", "refresh_token": "r-new" }), Some("r-old".into())).unwrap();
        assert_eq!(t.refresh_token.as_deref(), Some("r-new"));
        assert!((t.expires_at - (now() + 3600)).abs() <= 1, "an hour when the provider doesn't say");

        let e = token_from("Outlook", &json!({ "error": "invalid_grant", "error_description": "AADSTS70008: expired" }), None).err().unwrap();
        assert!(matches!(&e, Error::Provider { provider: "Outlook", status: 400, message } if message == "AADSTS70008: expired"));
        assert_eq!(e.friendly().0, "provider_auth");
        let e = token_from("Google", &json!({ "error": "invalid_client" }), None).err().unwrap();
        assert!(matches!(&e, Error::Provider { message, .. } if message == "invalid_client"));
        let e = token_from("Google", &json!({ "token_type": "Bearer" }), None).err().unwrap();
        assert_eq!(e.to_string(), "Google didn't return a token.");
    }

    #[test]
    fn forms_are_posted_encoded_and_asking_for_json() {
        let s = serve(vec![reply(200, r#"{"ok":true}"#), reply(200, "not json")]);
        let http = reqwest::Client::new();
        let v = block_on(post_form(&http, &format!("{}/token", s.url), &[("code", "a b&c=d"), ("grant_type", "authorization_code")])).unwrap();
        assert_eq!(v, json!({ "ok": true }));
        let req = &s.requests()[0];
        assert_eq!((req.method.as_str(), req.target.as_str()), ("POST", "/token"));
        assert_eq!(req.header("accept"), Some("application/json"));
        assert_eq!(req.header("content-type"), Some("application/x-www-form-urlencoded"));
        assert_eq!(req.body, "code=a+b%26c%3Dd&grant_type=authorization_code");
        let e = block_on(post_form(&http, &s.url, &[])).unwrap_err();
        assert_eq!(e.friendly().0, "bad_response");
    }

    #[test]
    fn error_answers_carry_the_provider_message() {
        let s = serve(vec![
            reply(200, r#"{"items":[]}"#),
            reply(401, r#"{"error":{"code":401,"message":"Request had invalid authentication credentials."}}"#),
            reply(400, r#"{"error":"invalid_request","error_description":"Bad scope"}"#),
            reply(403, r#"{"error":"access_denied"}"#),
            reply(503, "<html>down</html>"),
            reply(204, ""),
        ]);
        let http = reqwest::Client::new();
        let get = || block_on(async { check_json("Google", http.get(&s.url).send().await?).await });
        assert_eq!(get().unwrap(), json!({ "items": [] }));
        let message = |e: Error| match e {
            Error::Provider { message, status, .. } => (status, message),
            other => panic!("{other:?}"),
        };
        assert_eq!(message(get().unwrap_err()), (401, "Request had invalid authentication credentials.".into()));
        assert_eq!(message(get().unwrap_err()), (400, "Bad scope".into()));
        assert_eq!(message(get().unwrap_err()), (403, "access_denied".into()));
        assert_eq!(message(get().unwrap_err()), (503, "request failed".into()));
        assert_eq!(get().unwrap(), Value::Null, "an empty success is fine");
    }

    #[test]
    fn access_tokens_are_reused_until_a_minute_before_they_expire() {
        let (dir, secrets) = secrets("fresh");
        secrets.set_json("google", &stored("still-good", Some("r"), now() + 600)).unwrap();
        let t = block_on(access_token(&secrets, "google", |_| async { panic!("no refresh needed") })).unwrap();
        assert_eq!(t, "still-good");

        secrets.set_json("google", &stored("nearly-gone", Some("r1"), now() + 30)).unwrap();
        let t = block_on(access_token(&secrets, "google", |rt| async move {
            assert_eq!(rt, "r1");
            Ok(TokenSet { access_token: "fresh".into(), refresh_token: Some("r1".into()), expires_at: now() + 3600, account: None })
        }))
        .unwrap();
        assert_eq!(t, "fresh");
        let saved: TokenSet = secrets.get_json("google").unwrap();
        assert_eq!(saved.access_token, "fresh");
        assert_eq!(saved.account.as_deref(), Some("amina@example.com"), "the account survives a refresh");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn missing_or_rejected_refresh_asks_to_reconnect() {
        let (dir, secrets) = secrets("reconnect");
        let never = |_: String| async { panic!("not called") };
        let e = block_on(access_token(&secrets, "google", never)).unwrap_err();
        assert_eq!(e.to_string(), "Connect Google in Settings first.");
        let e = block_on(access_token(&secrets, "microsoft", |_| async { panic!("not called") })).unwrap_err();
        assert_eq!(e.to_string(), "Connect Outlook in Settings first.");

        secrets.set_json("microsoft", &stored("old", None, now() - 10)).unwrap();
        let e = block_on(access_token(&secrets, "microsoft", |_| async { panic!("not called") })).unwrap_err();
        assert!(matches!(&e, Error::Provider { provider: "Outlook", status: 401, .. }));
        assert_eq!(e.friendly().0, "provider_auth");

        secrets.set_json("microsoft", &stored("old", Some("revoked"), now() - 10)).unwrap();
        let e = block_on(access_token(&secrets, "microsoft", |_| async {
            Err(Error::Provider { provider: "Outlook", status: 400, message: "invalid_grant".into() })
        }))
        .unwrap_err();
        assert!(matches!(&e, Error::Provider { status: 401, message, .. } if message == "refresh token missing or rejected"));
        let e = block_on(access_token(&secrets, "microsoft", |_| async { Err(Error::Offline) })).unwrap_err();
        assert!(matches!(e, Error::Offline), "being offline is not a sign-in problem");
        let kept: TokenSet = secrets.get_json("microsoft").unwrap();
        assert_eq!(kept.access_token, "old", "a failed refresh changes nothing stored");
        let _ = std::fs::remove_dir_all(&dir);
    }
}
