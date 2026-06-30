//! Archives a tunnel's off-chain transcript to Walrus (proof-of-existence). The
//! on-chain settlement already anchors the 32-byte root; this stores the full blob so
//! the transcript behind that root is auditable. Walrus failure is non-fatal to settle
//! (the close already succeeded) — see the handler.

use anyhow::{anyhow, Context};
use axum::body::Bytes;

pub struct WalrusClient {
    http: reqwest::Client,
    publisher_url: String,
    aggregator_url: String,
}

impl WalrusClient {
    pub fn new(publisher_url: String, aggregator_url: String) -> Self {
        Self {
            http: reqwest::Client::new(),
            publisher_url,
            aggregator_url,
        }
    }

    /// Construct a no-op client for tests — all method calls will fail at the network layer,
    /// which is acceptable since tests using `in_memory_for_test` never call `upload_transcript`.
    #[cfg(any(test, feature = "test-util"))]
    pub fn noop() -> Self {
        Self::new(String::new(), String::new())
    }

    /// Upload `bytes`, returning `(blob_id, read_url)`. The publisher returns the id under
    /// `newlyCreated.blobObject.blobId` for a fresh blob or `alreadyCertified.blobId` for a
    /// dedup hit; the read URL is `{aggregator}/v1/blobs/<blobId>`.
    pub async fn upload_transcript(&self, bytes: Bytes) -> anyhow::Result<(String, String)> {
        let url = format!("{}/v1/blobs", self.publisher_url.trim_end_matches('/'));
        let resp: serde_json::Value = self
            .http
            .put(url)
            .body(bytes)
            .send()
            .await?
            .error_for_status()?
            .json()
            .await
            .context("walrus publisher returned non-JSON")?;
        let blob_id = resp
            .pointer("/newlyCreated/blobObject/blobId")
            .or_else(|| resp.pointer("/alreadyCertified/blobId"))
            .and_then(|v| v.as_str())
            .ok_or_else(|| anyhow!("no blobId in Walrus response: {resp}"))?
            .to_owned();
        let read_url = format!(
            "{}/v1/blobs/{}",
            self.aggregator_url.trim_end_matches('/'),
            blob_id
        );
        Ok((blob_id, read_url))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use wiremock::matchers::method;
    use wiremock::{Mock, MockServer, ResponseTemplate};

    // The client must extract the blobId from the publisher's nested JSON and build the
    // aggregator read URL — a Walrus response-shape change is an integration break, so
    // this pins the field path against a mocked publisher.
    #[tokio::test]
    async fn upload_extracts_blob_id_and_builds_read_url() {
        let server = MockServer::start().await;
        let body = serde_json::json!({ "newlyCreated": { "blobObject": { "blobId": "abc123" } } });
        Mock::given(method("PUT"))
            .respond_with(ResponseTemplate::new(200).set_body_json(body))
            .mount(&server)
            .await;
        let c = WalrusClient::new(server.uri(), "https://agg.example".into());
        let (id, url) = c
            .upload_transcript(Bytes::from_static(b"transcript"))
            .await
            .unwrap();
        assert_eq!(id, "abc123");
        assert_eq!(url, "https://agg.example/v1/blobs/abc123");
    }

    // A dedup hit returns the id under a different key; the client must still find it.
    #[tokio::test]
    async fn upload_handles_already_certified() {
        let server = MockServer::start().await;
        let body = serde_json::json!({ "alreadyCertified": { "blobId": "dedup99" } });
        Mock::given(method("PUT"))
            .respond_with(ResponseTemplate::new(200).set_body_json(body))
            .mount(&server)
            .await;
        let c = WalrusClient::new(server.uri(), "https://agg.example".into());
        let (id, _) = c.upload_transcript(Bytes::from_static(b"x")).await.unwrap();
        assert_eq!(id, "dedup99");
    }
}
