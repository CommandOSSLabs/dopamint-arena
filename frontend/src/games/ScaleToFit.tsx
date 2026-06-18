import { useLayoutEffect, useRef, useState, type ReactNode } from "react";

/**
 * Renders `children` at a fixed design size, then uniformly shrinks them with a CSS transform so
 * they fit the parent box — the "zoom the whole game UI down into the small platform window"
 * effect, preserving the original aspect ratio and layout (no reflow). Never scales above 1×.
 */
export function ScaleToFit({
  designWidth,
  designHeight,
  children,
}: {
  designWidth: number;
  designHeight: number;
  children: ReactNode;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [scale, setScale] = useState(1);

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const measure = () => {
      const { width, height } = el.getBoundingClientRect();
      if (width === 0 || height === 0) return;
      setScale(Math.min(1, width / designWidth, height / designHeight));
    };
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, [designWidth, designHeight]);

  return (
    <div
      ref={ref}
      className="flex h-full w-full items-center justify-center overflow-hidden"
    >
      <div
        style={{
          width: designWidth,
          height: designHeight,
          flex: "none",
          transform: `scale(${scale})`,
          transformOrigin: "center",
        }}
      >
        {children}
      </div>
    </div>
  );
}
