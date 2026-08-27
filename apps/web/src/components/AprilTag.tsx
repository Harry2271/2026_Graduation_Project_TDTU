"use client";

import { useMemo } from "react";

import { getAprilTagImageUrl } from "@/lib/aprilTag";

interface AprilTagProps {
  id: number;
  sizePx: number;
  className?: string;
  title?: string;
}

export default function AprilTag({ id, sizePx, className, title }: AprilTagProps) {
  const imageUrl = useMemo(() => getAprilTagImageUrl(id), [id]);

  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      viewBox={`0 0 ${sizePx} ${sizePx}`}
      width={sizePx}
      height={sizePx}
      role="img"
      aria-label={title ?? `AprilTag #${String(id)}`}
      className={className}
    >
      <title>{title ?? `AprilTag #${String(id)}`}</title>
      <rect x={0} y={0} width={sizePx} height={sizePx} fill="#ffffff" />
      <image href={imageUrl} x={0} y={0} width={sizePx} height={sizePx} preserveAspectRatio="none" />
    </svg>
  );
}
