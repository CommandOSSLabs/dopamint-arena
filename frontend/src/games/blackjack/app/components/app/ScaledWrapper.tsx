import { useEffect, useState, useRef, ReactNode } from "react";

export function ScaledWrapper({ children }: { children: ReactNode }) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [scale, setScale] = useState(1);
  const [size, setSize] = useState({ w: 400, h: 650 });

  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;

    const parent = el.parentElement;
    if (!parent) return;

    // Use ResizeObserver to watch parent container's size (e.g. Arena draggable window)
    const observer = new ResizeObserver((entries) => {
      const entry = entries[0];
      if (!entry) return;

      // Read dimensions of the parent container
      const w =
        entry.contentRect.width || parent.clientWidth || window.innerWidth;
      const h =
        entry.contentRect.height || parent.clientHeight || window.innerHeight;

      const MIN_W = 400; // Below this virtual size, we scale down
      const MIN_H = 650;
      const MAX_W = 1000; // Above this, we scale up
      const MAX_H = 800;

      let s = 1;
      if (w < MIN_W || h < MIN_H) {
        const scaleW = w / MIN_W;
        const scaleH = h / MIN_H;
        s = Math.min(scaleW, scaleH);
      } else if (w > MAX_W && h > MAX_H) {
        const scaleW = w / MAX_W;
        const scaleH = h / MAX_H;
        s = Math.min(scaleW, scaleH, 2); // Scale up to 2x max
      }

      setScale(s);
      setSize({ w, h });
    });

    observer.observe(parent);

    return () => observer.disconnect();
  }, []);

  // Compute virtual internal size at 1x scale
  const innerW = size.w / scale;
  const innerH = size.h / scale;

  return (
    <div
      ref={containerRef}
      style={{
        width: "100%",
        height: "100%",
        overflow: "hidden",
        position: "relative",
        backgroundColor: "#09090b",
      }}
    >
      <div
        style={{
          width: `${innerW}px`,
          height: `${innerH}px`,
          transform: `scale(${scale})`,
          transformOrigin: "top left",
          position: "absolute",
          top: 0,
          left: 0,
        }}
      >
        {children}
      </div>
    </div>
  );
}
