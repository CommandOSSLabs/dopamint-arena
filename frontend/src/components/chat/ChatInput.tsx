import { Button } from "../ui/button";
import { Input } from "../ui/input";

export interface ChatInputProps {
  value: string;
  onChange: (value: string) => void;
  onSend: () => void;
  loading?: boolean;
}

export function ChatInput({ value, onChange, onSend, loading }: ChatInputProps) {
  return (
    <div className="flex gap-2 p-2 border-t">
      <Input
        value={value}
        onChange={(e) => onChange(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter") onSend();
        }}
        placeholder="Type a message..."
        disabled={loading}
      />
      <Button onClick={onSend} disabled={loading || !value.trim()}>
        Send
      </Button>
    </div>
  );
}
