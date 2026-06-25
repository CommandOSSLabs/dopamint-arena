import {
  createContext,
  useContext,
  useEffect,
  useState,
  useRef,
  ReactNode,
} from "react";

interface ScaleContextType {
  width: number;
  height: number;
  isPortrait: boolean;
}

const ScaleContext = createContext<ScaleContextType>({
  width: 500,
  height: 800,
  isPortrait: true,
});

export function useGameScale() {
  return useContext(ScaleContext);
}

export function ScaledWrapper({ children }: { children: ReactNode }) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [scale, setScale] = useState(1);
  const [dimensions, setDimensions] = useState({
    width: 500,
    height: 800,
    isPortrait: true,
  });

  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;

    const parent = el.parentElement;
    if (!parent) return;

    const handleResize = () => {
      const w = parent.clientWidth || window.innerWidth;
      const h = parent.clientHeight || window.innerHeight;
      if (w === 0 || h === 0) return;

      const isPortrait = w < h;
      const dWidth = isPortrait ? 500 : 1024;
      const dHeight = isPortrait ? 800 : 640;

      const scaleW = w / dWidth;
      const scaleH = h / dHeight;
      const s = Math.min(scaleW, scaleH, 2);

      setDimensions({ width: dWidth, height: dHeight, isPortrait });
      setScale(s);
    };

    const observer = new ResizeObserver(handleResize);
    observer.observe(parent);
    handleResize();

    return () => observer.disconnect();
  }, []);

  return (
    <ScaleContext.Provider value={dimensions}>
      <div
        ref={containerRef}
        style={{
          width: "100%",
          height: "100%",
          overflow: "hidden",
          position: "relative",
          backgroundColor: "transparent",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
        }}
      >
        <div
          style={{
            width: `${dimensions.width}px`,
            height: `${dimensions.height}px`,
            transform: `scale(${scale})`,
            transformOrigin: "center center",
            flex: "none",
            position: "relative",
          }}
        >
          {children}
        </div>
      </div>
    </ScaleContext.Provider>
  );
}
