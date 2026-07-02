import type { ReactNode } from "react";

interface AgentAllowanceLobbyFieldProps {
  label: string;
  children: ReactNode;
}

export default function AgentAllowanceLobbyField({
  label,
  children,
}: AgentAllowanceLobbyFieldProps) {
  return (
    <label className="flex flex-col gap-1">
      <span className="wal-eyebrow text-[11px] uppercase tracking-wide text-muted-foreground">
        {label}
      </span>
      {children}
    </label>
  );
}
