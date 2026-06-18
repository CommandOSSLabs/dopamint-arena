import { useEffect, useState, ReactNode } from "react";

export function ScaledWrapper({ children }: { children: ReactNode }) {
  const [scale, setScale] = useState(1);
  const [size, setSize] = useState({ w: window.innerWidth, h: window.innerHeight });

  useEffect(() => {
    const update = () => {
      const w = window.innerWidth;
      const h = window.innerHeight;
      
      const MIN_W = 400; // Below this, scale down
      const MIN_H = 650; 
      const MAX_W = 1000; // Above this, scale up
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
    };

    update();
    window.addEventListener("resize", update);
    return () => window.removeEventListener("resize", update);
  }, []);

  const innerW = size.w / scale;
  const innerH = size.h / scale;

  return (
    <div style={{ width: "100vw", height: "100vh", overflow: "hidden", position: "relative", backgroundColor: "#09090b" }}>
      <div 
        style={{ 
          width: `${innerW}px`, 
          height: `${innerH}px`, 
          transform: `scale(${scale})`, 
          transformOrigin: "top left",
          position: "absolute",
          top: 0,
          left: 0
        }}
      >
        {children}
      </div>
    </div>
  );
}
