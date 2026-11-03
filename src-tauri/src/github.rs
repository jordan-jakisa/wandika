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
/// GitHub's best practice for many writes: one at a time, at least a second apart.
/// https://docs.github.com/en/rest/using-the-rest-api/best-practices-for-using-the-rest-api
const WRITE_GAP: Duration = Duration::from_secs(1);
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

/// How long the next write must wait, or None when it may go now (and is then counted).
fn slot(q: &mut VecDeque<Instant>, now: Instant) -> Result<Option<Duration>> {
    while q.front().is_some_and(|t| now.duration_since(*t) > Duration::from_secs(3600)) {
        q.pop_front();
    }
    if q.len() >= WRITES_PER_HOUR {
        return Err(limited());
    }
    if let Some(last) = q.back() {
        let since = now.duration_since(*last);
        if since < WRITE_GAP {
            return Ok(Some(WRITE_GAP - since));
        }
    }
    let in_minute: Vec<&Instant> = q.iter().filter(|t| now.duration_since(**t) < Duration::from_secs(60)).collect();
    if in_minute.len() >= WRITES_PER_MINUTE {
        return Ok(Some(Duration::from_secs(60).saturating_sub(now.duration_since(*in_minute[0])) + Duration::from_millis(50)));
    }
    q.push_back(now);
    Ok(None)
}

/// Waits for a free slot for one content-creating request; fails when this hour's budget is spent.
async fn pace() -> Result<()> {
    loop {
        guard()?;
        let wait = slot(&mut WRITES.lock().unwrap(), Instant::now())?;
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

#[cfg(test)]
mod tests {
    use super::*;
    use crate::test_http::{block_on, reply, serve};

    /// The write budget and the rate-limit stop are shared by the whole app, so these tests take
    /// turns and start from a clean slate.
    static SERIAL: Mutex<()> = Mutex::new(());

    fn turn() -> std::sync::MutexGuard<'static, ()> {
        let guard = SERIAL.lock().unwrap_or_else(|e| e.into_inner());
        *BLOCKED_UNTIL.lock().unwrap() = None;
        WRITES.lock().unwrap().clear();
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
    fn lists_repositories_a_page_at_a_time_up_to_ten_pages() {
        let _t = turn();
        let page = |n: usize, from: usize| Value::Array((from..from + n).map(|i| repo_json(&format!("r{i}"))).collect()).to_string();
        let s = serve(vec![reply(200, page(100, 0)), reply(200, page(3, 100))]);
        let repos = block_on(gh(&s.url).repos()).unwrap();
        assert_eq!(repos.len(), 103);
        assert_eq!(repos[102].full_name, "amina/r102");
        let targets: Vec<String> = s.requests().into_iter().map(|r| r.target).collect();
        assert_eq!(targets, ["/user/repos?per_page=100&sort=pushed&page=1", "/user/repos?per_page=100&sort=pushed&page=2"]);

        let s = serve((0..11).map(|i| reply(200, page(100, i * 100))).collect());
        assert_eq!(block_on(gh(&s.url).repos()).unwrap().len(), 1000);
        assert_eq!(s.requests().len(), 10, "never more than ten pages");

        let s = serve(vec![reply(200, "[]")]);
        assert!(block_on(gh(&s.url).repos()).unwrap().is_empty());
    }

    #[test]
    fn creates_a_private_empty_repository_and_counts_the_write() {
        let _t = turn();
        let s = serve(vec![reply(201, repo_json("notes").to_string())]);
        let repo = block_on(gh(&s.url).create_repo("notes")).unwrap();
        assert_eq!(repo.name, "notes");
        let req = &s.requests()[0];
        assert_eq!((req.method.as_str(), req.target.as_str()), ("POST", "/user/repos"));
        let body: Value = serde_json::from_str(&req.body).unwrap();
        assert_eq!(body, json!({ "name": "notes", "private": true, "auto_init": false, "description": "Notes kept with Wandika" }));
        assert_eq!(WRITES.lock().unwrap().len(), 1);
    }

    #[test]
    fn error_answers_become_github_errors_with_the_service_message() {
        let _t = turn();
        let s = serve(vec![
            reply(401, r#"{"message":"Bad credentials"}"#),
            reply(404, r#"{"message":"Not Found","documentation_url":"x"}"#),
            reply(422, r#"{"message":"Repository creation failed.","errors":[{"message":"name already exists on this account"}]}"#),
            reply(502, "<html>Bad gateway</html>"),
            reply(403, r#"{"message":"Resource not accessible by integration"}"#),
            reply(200, "not json"),
        ]);
        let g = gh(&s.url);
        let e = block_on(g.user()).unwrap_err();
        assert_eq!(e.to_string(), "Your GitHub sign-in expired or was revoked. Sign out in Settings and sign in again.");
        let e = block_on(g.repo("a", "gone")).unwrap_err();
        assert!(matches!(&e, Error::GitHub { status: 404, message } if message == "Not Found"));
        let e = block_on(g.create_repo("taken")).unwrap_err();
        assert_eq!(e.friendly().0, "github_name_taken");
        let e = block_on(g.user()).unwrap_err();
        assert!(matches!(&e, Error::GitHub { status: 502, message } if message == "<html>Bad gateway</html>"), "a body that isn't JSON is kept whole");
        let e = block_on(g.user()).unwrap_err();
        assert_eq!(e.friendly().0, "github_forbidden");
        assert!(blocked_for().is_none(), "a plain refusal is not a rate limit");
        let e = block_on(g.user()).unwrap_err();
        assert_eq!(e.friendly().0, "bad_response");
    }

    #[test]
    fn writes_go_one_a_second_and_stay_under_the_minute_and_hour_limits() {
        let start = Instant::now();
        let mut q = VecDeque::new();
        assert_eq!(slot(&mut q, start).unwrap(), None);
        let wait = slot(&mut q, start + Duration::from_millis(300)).unwrap().unwrap();
        assert_eq!(wait, Duration::from_millis(700), "a second after the last write");
        assert_eq!(q.len(), 1, "a write that waits isn't counted");
        assert_eq!(slot(&mut q, start + WRITE_GAP).unwrap(), None);
        // A second apart is at most 60 a minute, under the 70 a minute limit, which stays as a backstop.
        let mut busy: VecDeque<Instant> = (0..WRITES_PER_MINUTE).map(|i| start + Duration::from_millis(i as u64 * 100)).collect();
        let wait = slot(&mut busy, start + Duration::from_secs(10)).unwrap().unwrap();
        assert!(wait > Duration::from_secs(49) && wait <= Duration::from_secs(51), "the minute's budget is spent: {wait:?}");
        let mut full: VecDeque<Instant> = (0..WRITES_PER_HOUR).map(|i| start + Duration::from_secs(i as u64 * 7)).collect();
        assert!(slot(&mut full, start + Duration::from_secs(3500)).is_err(), "the hour's budget is spent");
        assert_eq!(slot(&mut full, start + Duration::from_secs(3_600 + 7 * 450)).unwrap(), None, "old writes age out");
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
        assert!(block_on(gh(&s.url).create_repo("x")).is_err());
        assert!(s.requests().is_empty());
        assert!(WRITES.lock().unwrap().is_empty(), "a refused write isn't counted");
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
    fn writes_are_paced_under_github_limits() {
        let _t = turn();
        block_on(pace()).unwrap();
        assert_eq!(WRITES.lock().unwrap().len(), 1);

        // This hour's budget is spent: refused at once.
        {
            let mut q = WRITES.lock().unwrap();
            q.clear();
            let now = Instant::now();
            q.extend((0..WRITES_PER_HOUR).map(|i| now - Duration::from_secs(3000) + Duration::from_millis(i as u64)));
        }
        assert_eq!(block_on(pace()).unwrap_err().friendly().0, "github_rate_limit");

        // Writes older than an hour no longer count.
        {
            let mut q = WRITES.lock().unwrap();
            q.clear();
            let now = Instant::now();
            q.extend((0..WRITES_PER_HOUR).map(|_| now - Duration::from_secs(3601)));
        }
        block_on(pace()).unwrap();
        assert_eq!(WRITES.lock().unwrap().len(), 1);

        // This minute is full: waits until the oldest is a minute old, then goes.
        {
            let mut q = WRITES.lock().unwrap();
            q.clear();
            let first = Instant::now() - Duration::from_millis(59_800);
            q.extend((0..WRITES_PER_MINUTE).map(|_| first));
        }
        let t = Instant::now();
        block_on(pace()).unwrap();
        let waited = t.elapsed();
        assert!(waited >= Duration::from_millis(200) && waited < Duration::from_secs(5), "{waited:?}");
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
        assert!(matches!(poll_answer(&json!({ "access_token": "gho_x", "scope": "repo" })), Ok(Poll::Done(t)) if t == "gho_x"));
        let said = |v: Value| poll_answer(&v).err().unwrap().to_string();
        assert_eq!(said(json!({ "error": "expired_token" })), "The code expired. Start sign-in again.");
        assert_eq!(said(json!({ "error": "access_denied" })), "Sign-in was cancelled on GitHub.");
        assert_eq!(said(json!({ "error": "incorrect_device_code" })), "GitHub sign-in didn't finish. Start again.");
        assert_eq!(said(json!({ "token_type": "bearer" })), "GitHub didn't return a token.");
    }
}
