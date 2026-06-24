export interface ChatMessageProps {
  sender: string;
  text: string;
  isMe: boolean;
}

export function ChatMessage({ sender, text, isMe }: ChatMessageProps) {
  return (
    <div className={`flex ${isMe ? "justify-end" : "justify-start"} mb-2`}>
      <div
        className={`max-w-[80%] rounded-lg px-4 py-2 ${
          isMe ? "bg-primary text-primary-foreground" : "bg-muted"
        }`}
      >
        <div className="text-xs opacity-70">{sender}</div>
        <div className="text-sm">{text}</div>
      </div>
    </div>
  );
}
