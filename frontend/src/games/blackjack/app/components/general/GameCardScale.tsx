import React, { useState, useEffect, useRef } from "react";

interface GameCardScaleProps {
  children: React.ReactNode;
  className?: string;
  targetWidth?: number;
  targetHeight?: number;
}

export const GameCardScale: React.FC<GameCardScaleProps> = ({
  children,
  className = "",
  targetWidth = 450,
  targetHeight = 500,
}) => {
  const containerRef = useRef<HTMLDivElement>(null);
  const [scale, setScale] = useState(1);

  useEffect(() => {
    const handleResize = () => {
      const parentW = window.innerWidth;
      const parentH = window.innerHeight;

      // Calculate scale factor to fit within the viewport
      const scaleW = (parentW - 24) / targetWidth; // subtract margin
      const scaleH = (parentH - 24) / targetHeight; // subtract margin

      // Scale down to fit small screens, and allow scaling up to 2x to utilize large monitors
      const factor = Math.min(scaleW, scaleH, 2);
      setScale(factor);
    };

    window.addEventListener("resize", handleResize);
    handleResize();

    // Secondary delay call to ensure layout stability
    const timer = setTimeout(handleResize, 50);

    return () => {
      window.removeEventListener("resize", handleResize);
      clearTimeout(timer);
    };
  }, [targetWidth, targetHeight]);

  return (
    <div
      ref={containerRef}
      className={`origin-center flex items-center justify-center w-full max-w-md ${className}`}
      style={{
        transform: `scale(${scale})`,
        transformOrigin: "center center",
        transition: "transform 0.05s ease-out",
      }}
    >
      {children}
    </div>
  );
};
