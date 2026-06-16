//app/src/app/player/page.tsx
export function toFixedWithoutRounding(
  number: number,
  decimals: number
): number {
  const factor = Math.pow(10, decimals);
  return Math.floor(number * factor) / factor;
}
