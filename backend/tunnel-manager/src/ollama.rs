//! Thin proxy client for a local Ollama instance.
// TODO(chat-v2): remove this allow once a route actually consumes the client.
#![allow(dead_code)]

use std::time::Duration;

use anyhow::Context;
use serde::{Deserialize, Serialize};

const REQUEST_TIMEOUT: Duration = Duration::from_secs(60);
const TOPIC_PROMPT: &str =
    "Give me one short, fun conversation topic for two chat bots. Answer with the topic only, no extra text.";

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct OllamaMessage {
    pub role: String,
    pub content: String,
}

#[derive(Debug, Clone)]
pub struct OllamaOptions {
    pub num_predict: i64,
    pub num_ctx: i64,
    pub keep_alive: String,
    pub topic_predict: i64,
}

impl Default for OllamaOptions {
    fn default() -> Self {
        Self {
            num_predict: 64,
            num_ctx: 2048,
            keep_alive: "30m".into(),
            topic_predict: 24,
        }
    }
}

#[derive(Debug, Serialize)]
struct OllamaChatRequest<'a> {
    model: &'a str,
    messages: &'a [OllamaMessage],
    stream: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    options: Option<OllamaRequestOptions>,
    #[serde(skip_serializing_if = "Option::is_none")]
    keep_alive: Option<&'a str>,
}

#[derive(Debug, Serialize)]
struct OllamaRequestOptions {
    num_predict: i64,
    num_ctx: i64,
}

#[derive(Debug, Deserialize)]
struct OllamaChatResponse {
    message: OllamaMessage,
}

#[derive(Debug)]
pub struct OllamaClient {
    http: reqwest::Client,
    base_url: String,
    model: String,
    options: OllamaOptions,
}

impl OllamaClient {
    pub fn new(base_url: String, model: String) -> anyhow::Result<Self> {
        Self::new_with_options(base_url, model, OllamaOptions::default())
    }

    pub fn new_with_options(
        base_url: String,
        model: String,
        options: OllamaOptions,
    ) -> anyhow::Result<Self> {
        let url = base_url
            .parse::<reqwest::Url>()
            .context("invalid Ollama base URL")?;
        let base_url = url.as_str().trim_end_matches('/').to_string();
        let http = reqwest::Client::builder()
            .timeout(REQUEST_TIMEOUT)
            .build()
            .context("failed to build reqwest client")?;
        Ok(Self {
            http,
            base_url,
            model,
            options,
        })
    }

    fn build_request<'a>(
        &'a self,
        messages: &'a [OllamaMessage],
        num_predict: i64,
    ) -> OllamaChatRequest<'a> {
        OllamaChatRequest {
            model: &self.model,
            messages,
            stream: false,
            options: Some(OllamaRequestOptions {
                num_predict,
                num_ctx: self.options.num_ctx,
            }),
            keep_alive: Some(&self.options.keep_alive),
        }
    }

    /// Non-streaming chat completion. Returns the assistant's text.
    pub async fn chat(&self, messages: &[OllamaMessage]) -> anyhow::Result<String> {
        self.complete(messages, self.options.num_predict).await
    }

    /// Ask Ollama for a short random conversation topic.
    pub async fn topic(&self) -> anyhow::Result<String> {
        let prompt = OllamaMessage {
            role: "user".into(),
            content: TOPIC_PROMPT.into(),
        };
        let topic = self.complete(&[prompt], self.options.topic_predict).await?;
        Ok(topic.trim().to_string())
    }

    async fn complete(
        &self,
        messages: &[OllamaMessage],
        num_predict: i64,
    ) -> anyhow::Result<String> {
        let url = format!("{}/api/chat", self.base_url);
        let req = self.build_request(messages, num_predict);
        let resp: OllamaChatResponse = self
            .http
            .post(&url)
            .json(&req)
            .send()
            .await
            .context("ollama request failed")?
            .error_for_status()
            .context("ollama returned error")?
            .json()
            .await
            .context("ollama returned non-json")?;
        Ok(resp.message.content)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use wiremock::matchers::{body_json, method, path};
    use wiremock::{Mock, MockServer, ResponseTemplate};

    #[tokio::test]
    async fn chat_forwards_messages_and_extracts_reply() {
        let server = MockServer::start().await;
        let body = serde_json::json!({
            "message": { "role": "assistant", "content": "hello back" }
        });
        let expected_req = serde_json::json!({
            "model": "qwen2.5:1.5b",
            "messages": [{ "role": "user", "content": "hi" }],
            "stream": false,
            "options": { "num_predict": 64, "num_ctx": 2048 },
            "keep_alive": "30m",
        });
        Mock::given(method("POST"))
            .and(path("/api/chat"))
            .and(body_json(expected_req))
            .respond_with(ResponseTemplate::new(200).set_body_json(body))
            .mount(&server)
            .await;

        let client = OllamaClient::new(server.uri(), "qwen2.5:1.5b".into()).unwrap();
        let reply = client
            .chat(&[OllamaMessage {
                role: "user".into(),
                content: "hi".into(),
            }])
            .await
            .unwrap();
        assert_eq!(reply, "hello back");
    }

    #[tokio::test]
    async fn chat_forwards_messages_with_path_prefix() {
        // MockServer always serves from the root, but we can verify the client
        // builds the correct URL by giving it a path-prefixed base and matching
        // the full path.
        let server = MockServer::start().await;
        let body = serde_json::json!({
            "message": { "role": "assistant", "content": "ok" }
        });
        Mock::given(method("POST"))
            .and(path("/ollama/api/chat"))
            .respond_with(ResponseTemplate::new(200).set_body_json(body))
            .mount(&server)
            .await;

        let base = format!("{}/ollama/", server.uri());
        let client = OllamaClient::new(base, "qwen2.5:1.5b".into()).unwrap();
        let reply = client
            .chat(&[OllamaMessage {
                role: "user".into(),
                content: "hi".into(),
            }])
            .await
            .unwrap();
        assert_eq!(reply, "ok");
    }

    #[tokio::test]
    async fn chat_returns_error_on_non_2xx() {
        let server = MockServer::start().await;
        Mock::given(method("POST"))
            .and(path("/api/chat"))
            .respond_with(ResponseTemplate::new(500).set_body_string("boom"))
            .mount(&server)
            .await;

        let client = OllamaClient::new(server.uri(), "qwen2.5:1.5b".into()).unwrap();
        let err = client
            .chat(&[OllamaMessage {
                role: "user".into(),
                content: "hi".into(),
            }])
            .await
            .unwrap_err();
        assert!(err.to_string().contains("ollama returned error"));
    }

    #[tokio::test]
    async fn chat_returns_error_on_invalid_json() {
        let server = MockServer::start().await;
        Mock::given(method("POST"))
            .and(path("/api/chat"))
            .respond_with(ResponseTemplate::new(200).set_body_string("not json"))
            .mount(&server)
            .await;

        let client = OllamaClient::new(server.uri(), "qwen2.5:1.5b".into()).unwrap();
        let err = client
            .chat(&[OllamaMessage {
                role: "user".into(),
                content: "hi".into(),
            }])
            .await
            .unwrap_err();
        assert!(err.to_string().contains("non-json"));
    }

    #[tokio::test]
    async fn new_rejects_invalid_url() {
        let err = OllamaClient::new("not a url".into(), "qwen2.5:1.5b".into()).unwrap_err();
        assert!(err.to_string().contains("invalid Ollama base URL"));
    }
}
