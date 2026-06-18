import { cn } from "@/lib/utils";

/**
 * Segmented capacity bar — `on` of `total` segments lit. Adapted from nullframe's
 * Segbar (Memory/Battery cards), tinted via design-system tokens.
 */
export function Segbar({
  total,
  on,
  tone = "primary",
  className,
}: {
  total: number;
  on: number;
  tone?: "primary" | "success";
  className?: string;
}) {
  return (
    <div className={cn("flex h-1.5 gap-0.5", className)}>
      {Array.from({ length: total }, (_, i) => (
        <span
          key={i}
          className={cn(
            "flex-1 rounded-[1px] transition-colors",
            i < on
              ? tone === "success"
                ? "bg-success"
                : "bg-primary"
              : "bg-border",
          )}
        />
      ))}
    </div>
  );
}
