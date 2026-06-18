import React, { useState, useEffect } from "react";

interface GameCardScaleProps {
  children: React.ReactNode;
  className?: string;
  targetWidth?: number;
  targetHeight?: number;
}

export const GameCardScale: React.FC<GameCardScaleProps> = ({
  children,
  className = "",
  targetWidth = 500,
  targetHeight = 750,
}) => {
  const [scale, setScale] = useState(1);

  useEffect(() => {
    const handleResize = () => {
      const parentW = window.innerWidth;
      const parentH = window.innerHeight;

      // Calculate scale factors to fit within the viewport (with a larger safety margin to prevent edge touching)
      const scaleW = (parentW - 40) / targetWidth;
      const scaleH = (parentH - 48) / targetHeight;
      
      // We scale down only, never scaling up beyond 1 to maintain crispness on larger screens
      const factor = Math.min(scaleW, scaleH, 1);
      setScale(factor);
    };

    window.addEventListener("resize", handleResize);
    handleResize();

    // Trigger secondary recalculation to settle initial layout
    const timer = setTimeout(handleResize, 50);

    return () => {
      window.removeEventListener("resize", handleResize);
      clearTimeout(timer);
    };
  }, [targetWidth, targetHeight]);

  return (
    <div 
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
