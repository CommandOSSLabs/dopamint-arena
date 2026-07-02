interface AgentAllowanceLobbyNumberInputProps {
  value: string;
  onChange: (v: string) => void;
  suffix: string;
  disabled?: boolean;
}

/** Whole-MTPS input — digits only; decimals are rejected at the keystroke level. */
export default function AgentAllowanceLobbyNumberInput({
  value,
  onChange,
  suffix,
  disabled,
}: AgentAllowanceLobbyNumberInputProps) {
  return (
    <div className="flex items-center rounded-lg border border-border bg-background focus-within:border-primary">
      <input
        type="text"
        inputMode="numeric"
        pattern="[0-9]*"
        value={value}
        onChange={(e) => {
          const next = e.target.value;
          if (next === "" || /^\d+$/.test(next)) onChange(next);
        }}
        disabled={disabled}
        className="w-full min-w-0 bg-transparent px-2 py-1.5 text-sm text-foreground outline-none"
      />
      <span className="px-2 text-[11px] text-muted-foreground">{suffix}</span>
    </div>
  );
}
