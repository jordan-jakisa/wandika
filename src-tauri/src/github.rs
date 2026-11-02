//! GitHub: device-flow sign-in and the Git Data API that sync is built on.

use crate::config;
use crate::error::{msg, Error, Result};
use base64::Engine;
use reqwest::{Method, RequestBuilder, Response};
use serde::de::DeserializeOwned;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha1::{Digest, Sha1};

const API: &str = "https://api.github.com";

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

#[derive(Debug, Deserialize, Clone)]
pub struct TreeEntry {
    pub path: String,
    pub mode: String,
    #[serde(rename = "type")]
    pub kind: String,
    pub sha: String,
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

/// Git's object ID for a blob, so local files can be compared with the remote tree without downloading.
pub fn blob_sha(bytes: &[u8]) -> String {
    let mut h = Sha1::new();
    h.update(format!("blob {}\0", bytes.len()).as_bytes());
    h.update(bytes);
    hex::encode(h.finalize())
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
        Some(other) => Err(msg(format!("GitHub sign-in failed: {other}"))),
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
        let body = res.text().await.unwrap_or_default();
        let message = serde_json::from_str::<Value>(&body)
            .ok()
            .and_then(|v| v["message"].as_str().map(str::to_string))
            .unwrap_or(body);
        Err(Error::GitHub { status, message })
    }

    async fn json<T: DeserializeOwned>(rb: RequestBuilder) -> Result<T> {
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
        Self::json(self.req(Method::POST, "/user/repos").json(&json!({
            "name": name,
            "private": true,
            "auto_init": true,
            "description": "Notes kept with Wandika",
        })))
        .await
    }

    pub async fn repo(&self, owner: &str, repo: &str) -> Result<Repo> {
        Self::json(self.req(Method::GET, &format!("/repos/{owner}/{repo}"))).await
    }

    /// Head commit of a branch. `None` when the repository has no commits yet.
    pub async fn head(&self, owner: &str, repo: &str, branch: &str) -> Result<Option<String>> {
        let res = self
            .req(Method::GET, &format!("/repos/{owner}/{repo}/git/ref/heads/{branch}"))
            .send()
            .await?;
        if res.status().as_u16() == 409 {
            return Ok(None);
        }
        let v: Value = Self::check(res).await?.json().await?;
        Ok(v["object"]["sha"].as_str().map(str::to_string))
    }

    pub async fn commit_tree(&self, owner: &str, repo: &str, commit: &str) -> Result<String> {
        let v: Value =
            Self::json(self.req(Method::GET, &format!("/repos/{owner}/{repo}/git/commits/{commit}")))
                .await?;
        v["tree"]["sha"]
            .as_str()
            .map(str::to_string)
            .ok_or_else(|| msg("GitHub returned a commit without a tree."))
    }

    pub async fn tree(&self, owner: &str, repo: &str, tree: &str) -> Result<Vec<TreeEntry>> {
        #[derive(Deserialize)]
        struct T {
            tree: Vec<TreeEntry>,
            truncated: bool,
        }
        let t: T = Self::json(self.req(
            Method::GET,
            &format!("/repos/{owner}/{repo}/git/trees/{tree}?recursive=1"),
        ))
        .await?;
        if t.truncated {
            return Err(msg(
                "This repository has too many files for Wandika to sync (over 100,000).",
            ));
        }
        Ok(t.tree)
    }

    pub async fn blob(&self, owner: &str, repo: &str, sha: &str) -> Result<Vec<u8>> {
        let res = self
            .req(Method::GET, &format!("/repos/{owner}/{repo}/git/blobs/{sha}"))
            .header("Accept", "application/vnd.github.raw+json")
            .send()
            .await?;
        Ok(Self::check(res).await?.bytes().await?.to_vec())
    }

    pub async fn create_blob(&self, owner: &str, repo: &str, bytes: &[u8]) -> Result<String> {
        let content = base64::engine::general_purpose::STANDARD.encode(bytes);
        let v: Value = Self::json(
            self.req(Method::POST, &format!("/repos/{owner}/{repo}/git/blobs"))
                .json(&json!({ "content": content, "encoding": "base64" })),
        )
        .await?;
        v["sha"].as_str().map(str::to_string).ok_or_else(|| msg("GitHub didn't accept a file."))
    }

    pub async fn create_tree(
        &self,
        owner: &str,
        repo: &str,
        base_tree: &str,
        entries: Vec<Value>,
    ) -> Result<String> {
        let v: Value = Self::json(
            self.req(Method::POST, &format!("/repos/{owner}/{repo}/git/trees"))
                .json(&json!({ "base_tree": base_tree, "tree": entries })),
        )
        .await?;
        v["sha"].as_str().map(str::to_string).ok_or_else(|| msg("GitHub didn't accept the changes."))
    }

    pub async fn create_commit(
        &self,
        owner: &str,
        repo: &str,
        message: &str,
        tree: &str,
        parent: &str,
    ) -> Result<String> {
        let v: Value = Self::json(
            self.req(Method::POST, &format!("/repos/{owner}/{repo}/git/commits"))
                .json(&json!({ "message": message, "tree": tree, "parents": [parent] })),
        )
        .await?;
        v["sha"].as_str().map(str::to_string).ok_or_else(|| msg("GitHub didn't accept the commit."))
    }

    /// Fast-forward only. Returns false when the branch moved since we read it, so the caller retries.
    pub async fn update_ref(&self, owner: &str, repo: &str, branch: &str, sha: &str) -> Result<bool> {
        let res = self
            .req(Method::PATCH, &format!("/repos/{owner}/{repo}/git/refs/heads/{branch}"))
            .json(&json!({ "sha": sha, "force": false }))
            .send()
            .await?;
        if res.status().as_u16() == 422 {
            return Ok(false);
        }
        Self::check(res).await?;
        Ok(true)
    }

    pub async fn tarball(&self, owner: &str, repo: &str, sha: &str) -> Result<Vec<u8>> {
        let res = self.req(Method::GET, &format!("/repos/{owner}/{repo}/tarball/{sha}")).send().await?;
        Ok(Self::check(res).await?.bytes().await?.to_vec())
    }

    /// First commit for an empty repository (the Git Data API refuses to work on one).
    pub async fn put_file(
        &self,
        owner: &str,
        repo: &str,
        branch: &str,
        path: &str,
        content: &[u8],
        message: &str,
    ) -> Result<()> {
        let body = json!({
            "message": message,
            "content": base64::engine::general_purpose::STANDARD.encode(content),
            "branch": branch,
        });
        let res = self
            .req(Method::PUT, &format!("/repos/{owner}/{repo}/contents/{path}"))
            .json(&body)
            .send()
            .await?;
        Self::check(res).await?;
        Ok(())
    }
}
