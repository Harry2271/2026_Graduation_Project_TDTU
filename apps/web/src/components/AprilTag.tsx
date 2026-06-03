"use client";

import { useMemo } from "react";

import { getAprilTagGrid } from "@/lib/aprilTag";

interface AprilTagProps {
  id: number;
  sizePx: number;
  className?: string;
  title?: string;
}

export default function AprilTag({ id, sizePx, className, title }: AprilTagProps) {
  const { grid, cell } = useMemo(() => {
    const g = getAprilTagGrid(id);
    return { grid: g, cell: sizePx / g.length };
  }, [id, sizePx]);

  const cells = [];
  for (let r = 0; r < grid.length; r++) {
    for (let c = 0; c < grid[r]!.length; c++) {
      if (!grid[r]![c]) continue;
      cells.push(
        <rect
          key={`${r}-${c}`}
          x={c * cell}
          y={r * cell}
          width={cell}
          height={cell}
          fill="#000000"
        />,
      );
    }
  }

  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      viewBox={`0 0 ${sizePx} ${sizePx}`}
      width={sizePx}
      height={sizePx}
      shapeRendering="crispEdges"
      role="img"
      aria-label={title ?? `AprilTag #${String(id)}`}
      className={className}
    >
      <title>{title ?? `AprilTag #${String(id)}`}</title>
      <rect x={0} y={0} width={sizePx} height={sizePx} fill="#ffffff" />
      {cells}
    </svg>
  );
}
