import React from "react";

type ImageProps = React.ImgHTMLAttributes<HTMLImageElement> & {
  src: string;
  alt: string;
  width?: number | string;
  height?: number | string;
};

export default function Image({ width, height, style, ...props }: ImageProps) {
  return <img width={width} height={height} style={style} {...props} />;
}
