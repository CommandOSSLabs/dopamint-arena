//! In-memory store for the current bot-vs-bot transcript, plus SSE fan-out.

use serde::{Deserialize, Serialize};
use tokio::sync::broadcast;

const CAP: usize = 100;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ChatMessage {
    pub sender: String,
    pub text: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ChatTranscript {
    pub messages: Vec<ChatMessage>,
}

pub struct ChatTranscriptStore {
    tx: broadcast::Sender<String>,
    messages: std::sync::Mutex<Vec<ChatMessage>>,
}

impl ChatTranscriptStore {
    pub fn new() -> Self {
        let (tx, _) = broadcast::channel::<String>(16);
        Self {
            tx,
            messages: std::sync::Mutex::new(Vec::with_capacity(CAP)),
        }
    }

    pub fn subscribe(&self) -> broadcast::Receiver<String> {
        self.tx.subscribe()
    }

    pub async fn publish(&self, msg: ChatMessage) {
        let json = {
            let mut lock = self.messages.lock().expect("chat store mutex poisoned");
            lock.push(msg.clone());
            if lock.len() > CAP {
                lock.remove(0);
            }
            serde_json::to_string(&msg).unwrap_or_default()
        };
        let _ = self.tx.send(json);
    }

    #[allow(dead_code)] // TODO(chat-v2): used by GET /v1/chat/live/snapshot in a later task
    pub fn snapshot(&self) -> ChatTranscript {
        let lock = self.messages.lock().expect("chat store mutex poisoned");
        ChatTranscript {
            messages: lock.clone(),
        }
    }
}

impl Default for ChatTranscriptStore {
    fn default() -> Self {
        Self::new()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn publish_broadcasts_to_sse_subscribers() {
        let store = ChatTranscriptStore::new();
        let mut rx = store.subscribe();
        store
            .publish(ChatMessage {
                sender: "bot-a".into(),
                text: "hello".into(),
            })
            .await;
        let ev = rx.recv().await.unwrap();
        let parsed: ChatMessage = serde_json::from_str(&ev).unwrap();
        assert_eq!(parsed.sender, "bot-a");
        assert_eq!(parsed.text, "hello");
    }
}
