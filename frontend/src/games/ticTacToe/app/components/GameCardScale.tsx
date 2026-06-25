import React, { useState, useEffect, useRef } from "react";

interface GameCardScaleProps {
  children: React.ReactNode;
  className?: string;
  targetWidth?: number;
  targetHeight?: number;
  isPortrait?: boolean;
}

export const GameCardScale: React.FC<GameCardScaleProps> = ({
  children,
  className = "",
  targetWidth = 500,
  targetHeight = 750,
  isPortrait = targetWidth < targetHeight,
}) => {
  const [scale, setScale] = useState(1);
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const parent = el.parentElement;
    if (!parent) return;

    const handleResize = () => {
      const parentW = parent.clientWidth || window.innerWidth;
      const parentH = parent.clientHeight || window.innerHeight;

      // Calculate scale factors to fit within the parent container (no margin safety on portrait/mobile)
      const margin = isPortrait ? 0 : 24;
      const scaleW = (parentW - margin) / targetWidth;
      const scaleH = (parentH - margin) / targetHeight;

      // Scale down to fit, or scale up to 2x maximum
      const factor = Math.min(scaleW, scaleH, 2);
      setScale(factor);
    };

    const observer = new ResizeObserver(() => {
      handleResize();
    });
    observer.observe(parent);
    handleResize();

    // Secondary recalculation to settle layout
    const timer = setTimeout(handleResize, 100);

    return () => {
      observer.disconnect();
      clearTimeout(timer);
    };
  }, [targetWidth, targetHeight]);

  return (
    <div
      ref={containerRef}
      className={`origin-center flex items-center justify-center overflow-hidden ${className}`}
      style={{
        transform: `scale(${scale})`,
        transformOrigin: "center center",
        transition: "transform 0.05s ease-out",
        width: `${targetWidth}px`,
        height: `${targetHeight}px`,
        flexShrink: 0,
      }}
    >
      {children}
    </div>
  );
};
