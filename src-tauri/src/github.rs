//! GitHub: device-flow sign-in and the Git Data API that sync is built on.

use crate::config;
use crate::error::{msg, Error, Result};
use reqwest::{Method, RequestBuilder, Response};
use serde::de::DeserializeOwned;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::collections::VecDeque;
use std::sync::Mutex;
use std::time::{Duration, Instant};

const API: &str = "https://api.github.com";

// GitHub's secondary limits allow 80 content-creating requests a minute and 500 an hour, and warn
// that carrying on while limited can get an integration banned. Wandika stays under both with a
// margin, and after a limit response it sends nothing until GitHub says it may.
// https://docs.github.com/en/rest/using-the-rest-api/rate-limits-for-the-rest-api
const WRITES_PER_MINUTE: usize = 70;
const WRITES_PER_HOUR: usize = 450;
static WRITES: Mutex<VecDeque<Instant>> = Mutex::new(VecDeque::new());
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

/// Waits for a free slot for one content-creating request; fails when this hour's budget is spent.
async fn pace() -> Result<()> {
    loop {
        guard()?;
        let wait = {
            let mut q = WRITES.lock().unwrap();
            let now = Instant::now();
            while q.front().is_some_and(|t| now.duration_since(*t) > Duration::from_secs(3600)) {
                q.pop_front();
            }
            if q.len() >= WRITES_PER_HOUR {
                return Err(limited());
            }
            let in_minute: Vec<&Instant> = q.iter().filter(|t| now.duration_since(**t) < Duration::from_secs(60)).collect();
            if in_minute.len() >= WRITES_PER_MINUTE {
                Some(Duration::from_secs(60).saturating_sub(now.duration_since(*in_minute[0])) + Duration::from_millis(50))
            } else {
                q.push_back(now);
                None
            }
        };
        match wait {
            Some(d) => tokio::time::sleep(d).await,
            None => return Ok(()),
        }
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

pub enum Poll {
    Pending,
    SlowDown,
    Done(String),
}

pub async fn start_device_flow(http: &reqwest::Client) -> Result<DeviceCode> {
    let client_id = config::github_client_id()?;
    let v: Value = http
        .post("https://github.com/login/device/code")
        .header("Accept", "application/json")
        .form(&[("client_id", client_id), ("scope", "repo read:user")])
        .send()
        .await?
        .json()
        .await?;
    if let Some(err) = v.get("error").and_then(Value::as_str) {
        let detail = v["error_description"].as_str().unwrap_or(err);
        return Err(msg(format!("GitHub refused the sign-in request: {detail}")));
    }
    Ok(serde_json::from_value(v)?)
}

pub async fn poll_device_flow(http: &reqwest::Client, device_code: &str) -> Result<Poll> {
    let client_id = config::github_client_id()?;
    let v: Value = http
        .post("https://github.com/login/oauth/access_token")
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
    match v.get("error").and_then(Value::as_str) {
        Some("authorization_pending") => Ok(Poll::Pending),
        Some("slow_down") => Ok(Poll::SlowDown),
        Some("expired_token") => Err(msg("The code expired. Start sign-in again.")),
        Some("access_denied") => Err(msg("Sign-in was cancelled on GitHub.")),
        Some(_) => Err(msg("GitHub sign-in didn't finish. Start again.")),
        None => v["access_token"]
            .as_str()
            .map(|t| Poll::Done(t.to_string()))
            .ok_or_else(|| msg("GitHub didn't return a token.")),
    }
}

#[derive(Clone)]
pub struct GitHub {
    http: reqwest::Client,
    token: String,
}

impl GitHub {
    pub fn new(http: reqwest::Client, token: String) -> Self {
        Self { http, token }
    }

    /// For git over HTTPS, which signs in with the same token.
    pub fn token(&self) -> &str {
        &self.token
    }

    fn req(&self, method: Method, path: &str) -> RequestBuilder {
        self.http
            .request(method, format!("{API}{path}"))
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
            return Err(msg("Your GitHub sign-in expired or was revoked. Sign out in Settings and sign in again."));
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

    pub async fn repos(&self) -> Result<Vec<Repo>> {
        let mut all = Vec::new();
        for page in 1..=10 {
            let batch: Vec<Repo> = Self::json(self.req(
                Method::GET,
                &format!("/user/repos?per_page=100&sort=pushed&page={page}"),
            ))
            .await?;
            let done = batch.len() < 100;
            all.extend(batch);
            if done {
                break;
            }
        }
        Ok(all)
    }

    pub async fn create_repo(&self, name: &str) -> Result<Repo> {
        pace().await?;
        Self::json(self.req(Method::POST, "/user/repos").json(&json!({
            "name": name,
            "private": true,
            // Empty, so the first sync starts it with the Welcome note.
            "auto_init": false,
            "description": "Notes kept with Wandika",
        })))
        .await
    }

    pub async fn repo(&self, owner: &str, repo: &str) -> Result<Repo> {
        Self::json(self.req(Method::GET, &format!("/repos/{owner}/{repo}"))).await
    }
}
