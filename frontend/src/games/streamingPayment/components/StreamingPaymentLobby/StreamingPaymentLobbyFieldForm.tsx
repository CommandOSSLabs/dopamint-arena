import type { ReactNode } from "react";

interface StreamingPaymentLobbyFieldFormProps {
  label: string;
  children: ReactNode;
}

export function StreamingPaymentLobbyFieldForm({
  label,
  children,
}: StreamingPaymentLobbyFieldFormProps) {
  return (
    <label className="flex flex-col gap-1">
      <span className="text-[0.625rem] uppercase tracking-wide text-muted-foreground">
        {label}
      </span>

      {children}
    </label>
  );
}
