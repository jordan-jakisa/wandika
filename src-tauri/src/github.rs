//! GitHub: device-flow sign-in through the Wandika GitHub App, and the REST calls sync needs.
//!
//! Wandika signs in as a GitHub App, not an OAuth app, so its token reaches only the repositories
//! the person installed the app on, and only their contents. App tokens last eight hours; Wandika
//! renews them with the refresh token it was given at sign-in.
//! https://docs.github.com/en/apps/creating-github-apps/authenticating-with-a-github-app/generating-a-user-access-token-for-a-github-app

use crate::config;
use crate::error::{msg, Error, Result};
use crate::secrets::Secrets;
use reqwest::{Method, RequestBuilder, Response};
use serde::de::DeserializeOwned;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::sync::Mutex;
use std::time::{Duration, Instant};

const API: &str = "https://api.github.com";
const TOKEN_URL: &str = "https://github.com/login/oauth/access_token";
/// A token this close to running out is renewed before use, so a sync never starts with one that
/// lapses halfway through.
const RENEW_BEFORE: i64 = 10 * 60;
/// One renewal at a time: GitHub replaces the refresh token each time, so two at once would leave
/// one of them holding a refresh token that no longer works.
static RENEWING: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());

// When GitHub says to slow down, Wandika sends nothing until GitHub says it may: carrying on while
// limited can get an integration banned.
// https://docs.github.com/en/rest/using-the-rest-api/rate-limits-for-the-rest-api
static BLOCKED_UNTIL: Mutex<Option<Instant>> = Mutex::new(None);

fn limited() -> Error {
    Error::GitHub { status: 429, message: "rate limit: waiting before sending more".into() }
}

/// Fails at once while GitHub has asked us to wait.
fn guard() -> Result<()> {
    match *BLOCKED_UNTIL.lock().unwrap() {
        Some(until) if Instant::now() < until => Err(limited()),
        _ => Ok(()),
    }
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct User {
    pub login: String,
    pub name: Option<String>,
    pub avatar_url: String,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct Owner {
    pub login: String,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct Repo {
    pub name: String,
    pub full_name: String,
    pub owner: Owner,
    pub private: bool,
    pub default_branch: Option<String>,
    pub description: Option<String>,
    pub pushed_at: Option<String>,
}


#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct DeviceCode {
    pub device_code: String,
    pub user_code: String,
    pub verification_uri: String,
    pub expires_in: u64,
    pub interval: u64,
}

/// The saved sign-in. Tokens from the GitHub App expire; one saved by an earlier version, from the
/// old OAuth app, is a plain string that doesn't.
#[derive(Debug, Serialize, Deserialize, Clone, PartialEq)]
pub struct Tokens {
    pub access_token: String,
    #[serde(default)]
    pub refresh_token: Option<String>,
    /// Unix seconds; `None` for a token that doesn't expire.
    #[serde(default)]
    pub expires_at: Option<i64>,
}

impl Tokens {
    fn from_answer(v: &Value, now: i64) -> Option<Tokens> {
        Some(Tokens {
            access_token: v["access_token"].as_str()?.to_string(),
            refresh_token: v["refresh_token"].as_str().map(str::to_string),
            expires_at: v["expires_in"].as_i64().map(|s| now + s),
        })
    }

    /// The saved sign-in, in either form.
    pub fn load(secrets: &Secrets, key: &str) -> Option<Tokens> {
        secrets.get_json(key).or_else(|| {
            secrets.get(key).map(|plain| Tokens { access_token: plain, refresh_token: None, expires_at: None })
        })
    }

    fn fresh(&self, now: i64) -> bool {
        self.expires_at.is_none_or(|at| at - RENEW_BEFORE > now)
    }
}

pub enum Poll {
    Pending,
    SlowDown,
    Done(Tokens),
}

pub async fn start_device_flow(http: &reqwest::Client) -> Result<DeviceCode> {
    let client_id = config::github_client_id()?;
    // No scope: a GitHub App's token carries the permissions set on the app itself.
    let v: Value = http
        .post("https://github.com/login/device/code")
        .header("Accept", "application/json")
        .form(&[("client_id", client_id)])
        .send()
        .await?
        .json()
        .await?;
    device_code(v)
}

/// GitHub's answer to a sign-in request: the code to show, or why it refused.
fn device_code(v: Value) -> Result<DeviceCode> {
    if let Some(err) = v.get("error").and_then(Value::as_str) {
        let detail = v["error_description"].as_str().unwrap_or(err);
        return Err(msg(format!("GitHub refused the sign-in request: {detail}")));
    }
    Ok(serde_json::from_value(v)?)
}

pub async fn poll_device_flow(http: &reqwest::Client, device_code: &str) -> Result<Poll> {
    let client_id = config::github_client_id()?;
    let v: Value = http
        .post(TOKEN_URL)
        .header("Accept", "application/json")
        .form(&[
            ("client_id", client_id),
            ("device_code", device_code),
            ("grant_type", "urn:ietf:params:oauth:grant-type:device_code"),
        ])
        .send()
        .await?
        .json()
        .await?;
    poll_answer(&v)
}

/// GitHub's answer to one poll: still waiting, slow down, the token, or why sign-in ended.
fn poll_answer(v: &Value) -> Result<Poll> {
    match v.get("error").and_then(Value::as_str) {
        Some("authorization_pending") => Ok(Poll::Pending),
        Some("slow_down") => Ok(Poll::SlowDown),
        Some("expired_token") => Err(msg("The code expired. Start sign-in again.")),
        Some("access_denied") => Err(msg("Sign-in was cancelled on GitHub.")),
        Some(_) => Err(msg("GitHub sign-in didn't finish. Start again.")),
        None => Tokens::from_answer(v, chrono::Utc::now().timestamp())
            .map(Poll::Done)
            .ok_or_else(|| msg("GitHub didn't return a token.")),
    }
}

/// A token that is good for at least a few more minutes, renewed and saved when it isn't.
pub async fn access_token(http: &reqwest::Client, secrets: &Secrets, key: &str) -> Result<String> {
    let _one_at_a_time = RENEWING.lock().await;
    let tokens = Tokens::load(secrets, key).ok_or_else(|| msg("Sign in with GitHub first."))?;
    if tokens.fresh(chrono::Utc::now().timestamp()) {
        return Ok(tokens.access_token);
    }
    let refresh_token = tokens.refresh_token.ok_or(Error::GitHubSignIn)?;
    let renewed = renew(http, TOKEN_URL, config::github_client_id()?, &refresh_token).await?;
    secrets.set_json(key, &renewed)?;
    Ok(renewed.access_token)
}

/// Trades a refresh token for new tokens. A device-flow sign-in needs no client secret for this.
/// https://docs.github.com/en/apps/creating-github-apps/authenticating-with-a-github-app/refreshing-user-access-tokens
async fn renew(http: &reqwest::Client, url: &str, client_id: &str, refresh_token: &str) -> Result<Tokens> {
    let v: Value = http
        .post(url)
        .header("Accept", "application/json")
        .form(&[("client_id", client_id), ("grant_type", "refresh_token"), ("refresh_token", refresh_token)])
        .send()
        .await?
        .json()
        .await?;
    renew_answer(&v, chrono::Utc::now().timestamp())
}

/// A refused renewal (the refresh token expired after six months unused, or the person removed
/// Wandika's access) means signing in again.
fn renew_answer(v: &Value, now: i64) -> Result<Tokens> {
    if v.get("error").is_some() {
        return Err(Error::GitHubSignIn);
    }
    Tokens::from_answer(v, now).ok_or_else(|| msg("GitHub didn't return a token."))
}

#[derive(Deserialize)]
struct Installations {
    installations: Vec<Installation>,
}

#[derive(Deserialize)]
struct Installation {
    id: u64,
}

#[derive(Deserialize)]
struct InstallationRepos {
    repositories: Vec<Repo>,
}

#[derive(Clone)]
pub struct GitHub {
    http: reqwest::Client,
    token: String,
    /// The REST API's address; tests point it at a local server.
    api: String,
}

impl GitHub {
    pub fn new(http: reqwest::Client, token: String) -> Self {
        Self { http, token, api: API.into() }
    }

    /// For git over HTTPS, which signs in with the same token.
    pub fn token(&self) -> &str {
        &self.token
    }

    fn req(&self, method: Method, path: &str) -> RequestBuilder {
        self.http
            .request(method, format!("{}{path}", self.api))
            .bearer_auth(&self.token)
            .header("Accept", "application/vnd.github+json")
            .header("X-GitHub-Api-Version", "2022-11-28")
    }

    async fn check(res: Response) -> Result<Response> {
        if res.status().is_success() {
            return Ok(res);
        }
        let status = res.status().as_u16();
        // A rate limit answer: stop sending until GitHub's retry-after or reset, at least a minute.
        let header = |k: &str| res.headers().get(k).and_then(|v| v.to_str().ok()).and_then(|v| v.parse::<u64>().ok());
        let remaining_zero = header("x-ratelimit-remaining") == Some(0);
        let wait = header("retry-after").or_else(|| {
            remaining_zero.then(|| header("x-ratelimit-reset").map(|reset| reset.saturating_sub(chrono::Utc::now().timestamp() as u64))).flatten()
        });
        if status == 401 {
            return Err(crate::error::Error::GitHubSignIn);
        }
        let body = res.text().await.unwrap_or_default();
        let message = serde_json::from_str::<Value>(&body)
            .ok()
            .and_then(|v| v["message"].as_str().map(str::to_string))
            .unwrap_or(body);
        if matches!(status, 403 | 429) && (wait.is_some() || remaining_zero || message.to_lowercase().contains("rate limit")) {
            let secs = wait.unwrap_or(60).max(60);
            *BLOCKED_UNTIL.lock().unwrap() = Some(Instant::now() + Duration::from_secs(secs));
            return Err(Error::GitHub { status: 429, message: format!("rate limit: {message}") });
        }
        Err(Error::GitHub { status, message })
    }

    async fn json<T: DeserializeOwned>(rb: RequestBuilder) -> Result<T> {
        guard()?;
        Ok(Self::check(rb.send().await?).await?.json().await?)
    }

    pub async fn user(&self) -> Result<User> {
        Self::json(self.req(Method::GET, "/user")).await
    }

    /// The repositories Wandika may use: those on accounts where the person installed the
    /// Wandika app, and that they chose for it. Most recently pushed first.
    pub async fn repos(&self) -> Result<Vec<Repo>> {
        let mut ids = Vec::new();
        for page in 1..=3 {
            let batch: Installations =
                Self::json(self.req(Method::GET, &format!("/user/installations?per_page=100&page={page}"))).await?;
            let done = batch.installations.len() < 100;
            ids.extend(batch.installations.into_iter().map(|i| i.id));
            if done {
                break;
            }
        }
        let mut all: Vec<Repo> = Vec::new();
        let mut pages = 0;
        'installs: for id in ids {
            for page in 1.. {
                if pages == 10 {
                    break 'installs;
                }
                pages += 1;
                let batch: InstallationRepos = Self::json(self.req(
                    Method::GET,
                    &format!("/user/installations/{id}/repositories?per_page=100&page={page}"),
                ))
                .await?;
                let done = batch.repositories.len() < 100;
                for r in batch.repositories {
                    if !all.iter().any(|a| a.full_name == r.full_name) {
                        all.push(r);
                    }
                }
                if done {
                    break;
                }
            }
        }
        // ISO 8601 times sort as text; a repository never pushed to goes last.
        all.sort_by(|a, b| b.pushed_at.cmp(&a.pushed_at));
        Ok(all)
    }

    pub async fn repo(&self, owner: &str, repo: &str) -> Result<Repo> {
        Self::json(self.req(Method::GET, &format!("/repos/{owner}/{repo}"))).await
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::test_http::{block_on, reply, serve};
    use serde_json::json;

    /// The rate-limit stop is shared by the whole app, so these tests take
    /// turns and start from a clean slate.
    static SERIAL: Mutex<()> = Mutex::new(());

    fn turn() -> std::sync::MutexGuard<'static, ()> {
        let guard = SERIAL.lock().unwrap_or_else(|e| e.into_inner());
        *BLOCKED_UNTIL.lock().unwrap() = None;
        guard
    }

    fn gh(url: &str) -> GitHub {
        GitHub { http: reqwest::Client::new(), token: "gho_test".into(), api: url.into() }
    }

    fn repo_json(name: &str) -> Value {
        json!({ "name": name, "full_name": format!("amina/{name}"), "owner": { "login": "amina" }, "private": true,
                "default_branch": "main", "description": null, "pushed_at": "2026-11-01T10:00:00Z" })
    }

    fn blocked_for() -> Option<Duration> {
        BLOCKED_UNTIL.lock().unwrap().map(|t| t.saturating_duration_since(Instant::now()))
    }

    #[test]
    fn requests_carry_the_token_and_api_version() {
        let r = GitHub::new(reqwest::Client::new(), "gho_abc".into()).req(Method::GET, "/user").build().unwrap();
        assert_eq!(r.url().as_str(), "https://api.github.com/user");
        assert_eq!(r.headers()["authorization"], "Bearer gho_abc");
        assert_eq!(r.headers()["accept"], "application/vnd.github+json");
        assert_eq!(r.headers()["x-github-api-version"], "2022-11-28");
        assert_eq!(GitHub::new(reqwest::Client::new(), "t".into()).token(), "t");
    }

    #[test]
    fn reads_the_user_and_one_repository() {
        let _t = turn();
        let s = serve(vec![
            reply(200, r#"{"login":"amina","name":null,"avatar_url":"https://a/1.png","id":5}"#),
            reply(200, json!({ "name": "notes", "full_name": "amina/notes", "owner": { "login": "amina" }, "private": false }).to_string()),
        ]);
        let g = gh(&s.url);
        let user = block_on(g.user()).unwrap();
        assert_eq!((user.login.as_str(), user.name.as_deref()), ("amina", None));
        let repo = block_on(g.repo("amina", "notes")).unwrap();
        assert_eq!(repo.default_branch, None, "an empty repository has no default branch yet");
        let reqs = s.requests();
        assert_eq!((reqs[0].method.as_str(), reqs[0].target.as_str()), ("GET", "/user"));
        assert_eq!(reqs[1].target, "/repos/amina/notes");
        assert_eq!(reqs[0].header("authorization"), Some("Bearer gho_test"));
    }

    #[test]
    fn lists_the_repositories_wandika_was_given_newest_first() {
        let _t = turn();
        let installs = |ids: &[u64]| json!({ "total_count": ids.len(), "installations": ids.iter().map(|i| json!({ "id": i })).collect::<Vec<_>>() }).to_string();
        let repos = |list: Vec<Value>| json!({ "total_count": list.len(), "repositories": list }).to_string();
        let at = |name: &str, pushed: Option<&str>| {
            let mut r = repo_json(name);
            r["pushed_at"] = pushed.map_or(Value::Null, |p| json!(p));
            r
        };
        let s = serve(vec![
            reply(200, installs(&[7, 9])),
            reply(200, repos(vec![at("old", Some("2026-01-01T00:00:00Z")), at("empty", None)])),
            reply(200, repos(vec![at("new", Some("2026-11-01T00:00:00Z")), at("old", Some("2026-01-01T00:00:00Z"))])),
        ]);
        let list = block_on(gh(&s.url).repos()).unwrap();
        let names: Vec<&str> = list.iter().map(|r| r.name.as_str()).collect();
        assert_eq!(names, ["new", "old", "empty"], "newest first, each once, never-pushed last");
        let targets: Vec<String> = s.requests().into_iter().map(|r| r.target).collect();
        assert_eq!(
            targets,
            [
                "/user/installations?per_page=100&page=1",
                "/user/installations/7/repositories?per_page=100&page=1",
                "/user/installations/9/repositories?per_page=100&page=1",
            ]
        );

        let page = |n: usize, from: usize| repos((from..from + n).map(|i| repo_json(&format!("r{i}"))).collect());
        let s = serve(vec![reply(200, installs(&[1])), reply(200, page(100, 0)), reply(200, page(3, 100))]);
        assert_eq!(block_on(gh(&s.url).repos()).unwrap().len(), 103, "a second page when the first is full");

        let mut answers = vec![reply(200, installs(&[1]))];
        answers.extend((0..11).map(|i| reply(200, page(100, i * 100))));
        let s = serve(answers);
        assert_eq!(block_on(gh(&s.url).repos()).unwrap().len(), 1000);
        assert_eq!(s.requests().len(), 11, "never more than ten pages of repositories");

        let s = serve(vec![reply(200, installs(&[]))]);
        assert!(block_on(gh(&s.url).repos()).unwrap().is_empty(), "the app isn't installed anywhere yet");
    }

    #[test]
    fn error_answers_become_github_errors_with_the_service_message() {
        let _t = turn();
        let s = serve(vec![
            reply(401, r#"{"message":"Bad credentials"}"#),
            reply(404, r#"{"message":"Not Found","documentation_url":"x"}"#),
            reply(502, "<html>Bad gateway</html>"),
            reply(403, r#"{"message":"Resource not accessible by integration"}"#),
            reply(200, "not json"),
        ]);
        let g = gh(&s.url);
        let e = block_on(g.user()).unwrap_err();
        assert_eq!(e.friendly().0, "github_auth");
        let e = block_on(g.repo("a", "gone")).unwrap_err();
        assert!(matches!(&e, Error::GitHub { status: 404, message } if message == "Not Found"));
        let e = block_on(g.user()).unwrap_err();
        assert!(matches!(&e, Error::GitHub { status: 502, message } if message == "<html>Bad gateway</html>"), "a body that isn't JSON is kept whole");
        let e = block_on(g.user()).unwrap_err();
        assert_eq!(e.friendly().0, "github_forbidden");
        assert!(blocked_for().is_none(), "a plain refusal is not a rate limit");
        let e = block_on(g.user()).unwrap_err();
        assert_eq!(e.friendly().0, "bad_response");
    }

    #[test]
    fn a_rate_limit_answer_stops_every_request_until_github_says() {
        let _t = turn();
        let s = serve(vec![reply(429, r#"{"message":"slow"}"#).with("retry-after", "120")]);
        let e = block_on(gh(&s.url).user()).unwrap_err();
        assert!(matches!(&e, Error::GitHub { status: 429, message } if message == "rate limit: slow"));
        let wait = blocked_for().unwrap();
        assert!(wait > Duration::from_secs(115) && wait <= Duration::from_secs(120), "{wait:?}");

        // While blocked, nothing is sent at all.
        let s = serve(vec![reply(200, "{}")]);
        let e = block_on(gh(&s.url).user()).unwrap_err();
        assert_eq!(e.friendly().0, "github_rate_limit");
        assert!(s.requests().is_empty());
    }

    #[test]
    fn rate_limit_waits_follow_the_reset_time_and_are_never_under_a_minute() {
        let _t = turn();
        let reset = chrono::Utc::now().timestamp() + 300;
        let s = serve(vec![
            reply(403, r#"{"message":"API rate limit exceeded"}"#).with("x-ratelimit-remaining", "0").with("x-ratelimit-reset", reset.to_string()),
        ]);
        assert_eq!(block_on(gh(&s.url).user()).unwrap_err().friendly().0, "github_rate_limit");
        let wait = blocked_for().unwrap();
        assert!(wait > Duration::from_secs(290) && wait <= Duration::from_secs(301), "{wait:?}");

        *BLOCKED_UNTIL.lock().unwrap() = None;
        let s = serve(vec![reply(429, "{}").with("retry-after", "5")]);
        assert!(block_on(gh(&s.url).user()).is_err());
        assert!(blocked_for().unwrap() > Duration::from_secs(55), "at least a minute");

        *BLOCKED_UNTIL.lock().unwrap() = None;
        let s = serve(vec![reply(403, r#"{"message":"You have exceeded a secondary rate limit"}"#)]);
        assert!(block_on(gh(&s.url).user()).is_err());
        assert!(blocked_for().unwrap() > Duration::from_secs(55), "no headers: a minute");

        // A limit that has passed lets requests through again.
        *BLOCKED_UNTIL.lock().unwrap() = Some(Instant::now() - Duration::from_secs(1));
        assert!(guard().is_ok());
    }

    #[test]
    fn device_flow_answers() {
        let code = device_code(json!({ "device_code": "dc", "user_code": "ABCD-1234", "verification_uri": "https://github.com/login/device", "expires_in": 899, "interval": 5 })).unwrap();
        assert_eq!((code.user_code.as_str(), code.interval), ("ABCD-1234", 5));
        let e = device_code(json!({ "error": "unauthorized_client", "error_description": "Device flow is disabled" })).unwrap_err();
        assert_eq!(e.to_string(), "GitHub refused the sign-in request: Device flow is disabled");
        let e = device_code(json!({ "error": "unauthorized_client" })).unwrap_err();
        assert_eq!(e.to_string(), "GitHub refused the sign-in request: unauthorized_client");
        assert_eq!(device_code(json!({ "user_code": "x" })).unwrap_err().friendly().0, "bad_response");

        assert!(matches!(poll_answer(&json!({ "error": "authorization_pending" })), Ok(Poll::Pending)));
        assert!(matches!(poll_answer(&json!({ "error": "slow_down", "interval": 10 })), Ok(Poll::SlowDown)));
        let done = poll_answer(&json!({ "access_token": "ghu_x", "expires_in": 28800, "refresh_token": "ghr_y", "refresh_token_expires_in": 15897600, "token_type": "bearer", "scope": "" }));
        let Ok(Poll::Done(t)) = done else { panic!("signed in") };
        assert_eq!((t.access_token.as_str(), t.refresh_token.as_deref()), ("ghu_x", Some("ghr_y")));
        let left = t.expires_at.unwrap() - chrono::Utc::now().timestamp();
        assert!((28790..=28800).contains(&left), "{left}");
        let Ok(Poll::Done(t)) = poll_answer(&json!({ "access_token": "ghu_z" })) else { panic!("signed in") };
        assert_eq!((t.refresh_token, t.expires_at), (None, None), "an app that opted out of expiry");
        let said = |v: Value| poll_answer(&v).err().unwrap().to_string();
        assert_eq!(said(json!({ "error": "expired_token" })), "The code expired. Start sign-in again.");
        assert_eq!(said(json!({ "error": "access_denied" })), "Sign-in was cancelled on GitHub.");
        assert_eq!(said(json!({ "error": "incorrect_device_code" })), "GitHub sign-in didn't finish. Start again.");
        assert_eq!(said(json!({ "token_type": "bearer" })), "GitHub didn't return a token.");
    }

    #[test]
    fn tokens_are_renewed_before_they_run_out() {
        let now = 1_000_000;
        let t = |at: Option<i64>| Tokens { access_token: "a".into(), refresh_token: Some("r".into()), expires_at: at };
        assert!(t(None).fresh(now), "an old OAuth token doesn't expire");
        assert!(t(Some(now + 3600)).fresh(now));
        assert!(!t(Some(now + 300)).fresh(now), "five minutes left: renew first");
        assert!(!t(Some(now - 1)).fresh(now));
    }

    #[test]
    fn a_saved_sign_in_reads_in_either_form() {
        let dir = std::env::temp_dir().join(format!("wandika-gh-tokens-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        let secrets = Secrets::new(dir.clone());
        assert_eq!(Tokens::load(&secrets, "github"), None);
        secrets.set("github", "gho_old").unwrap();
        assert_eq!(Tokens::load(&secrets, "github"), Some(Tokens { access_token: "gho_old".into(), refresh_token: None, expires_at: None }));
        let saved = Tokens { access_token: "ghu_a".into(), refresh_token: Some("ghr_b".into()), expires_at: Some(5) };
        secrets.set_json("github", &saved).unwrap();
        assert_eq!(Tokens::load(&secrets, "github"), Some(saved));
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn renewing_trades_the_refresh_token_for_new_tokens() {
        let s = serve(vec![
            reply(200, r#"{"access_token":"ghu_new","expires_in":28800,"refresh_token":"ghr_new","refresh_token_expires_in":15897600,"token_type":"bearer"}"#),
            reply(200, r#"{"error":"bad_refresh_token","error_description":"The refresh token passed is incorrect or expired."}"#),
        ]);
        let http = reqwest::Client::new();
        let t = block_on(renew(&http, &s.url, "Iv23client", "ghr_old")).unwrap();
        assert_eq!((t.access_token.as_str(), t.refresh_token.as_deref()), ("ghu_new", Some("ghr_new")));
        let req = &s.requests()[0];
        assert_eq!(req.method, "POST");
        assert_eq!(req.body, "client_id=Iv23client&grant_type=refresh_token&refresh_token=ghr_old", "no client secret");
        let e = block_on(renew(&http, &s.url, "Iv23client", "ghr_gone")).unwrap_err();
        assert_eq!(e.friendly().0, "github_auth", "a refused renewal means signing in again");
        assert_eq!(renew_answer(&json!({ "token_type": "bearer" }), 0).unwrap_err().to_string(), "GitHub didn't return a token.");
    }
}
