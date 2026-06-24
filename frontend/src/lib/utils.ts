import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";

/** Merge conditional class lists, with later Tailwind utilities winning conflicts. */
export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

/** Format a metric readout: en-US grouped integer, em-dash when the value is absent. */
export function formatCount(n: number | undefined | null): string {
  return n == null ? "—" : Math.round(n).toLocaleString("en-US");
}
