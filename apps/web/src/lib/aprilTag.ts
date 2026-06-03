/**
 * tag36h11 AprilTag generator (client-side).
 *
 * Generates the canonical 8x8 black/white bit pattern for a given tag ID
 * (0..586) and renders it as a square <svg>. Mirrors the algorithm in the
 * official AprilTag reference implementation (AprilRobotics/apriltag, public
 * domain): a Hamming(36,11) generator matrix turns the 11-bit ID into a
 * 36-bit codeword, four rotations are tried, and the smallest 36-bit value
 * is the canonical codeword for that ID.
 *
 * Used for the future robot-vision pipeline (the warehouse robot will read
 * the tag with a camera). The handheld scanner still uses the existing QR
 * code (which encodes the Mongo _id).
 *
 * Reference: apriltag/tag36h11.c in https://github.com/AprilRobotics/apriltag
 */

const TAG_ID_MIN = 0;
const TAG_ID_MAX = 586;

// Each row is a 36-bit mask. Bit i (0..35) of row r means: data bit r affects
// parity bit i. The matrix below is the canonical Hamming(36,11) generator
// copied from the AprilTag reference C code.
const GENERATOR_MATRIX: readonly number[] = [
  0x1E1F4F88, // row 0
  0x0E0A8B12, // row 1
  0x1C7B0DA8, // row 2
  0x0C3A0E50, // row 3
  0x0A1A0A6C, // row 4
  0x0B0E0A38, // row 5
  0x0DB6E8B0, // row 6
  0x07CE1240, // row 7
  0x08061011, // row 8
  0x03E0E038, // row 9
  0x00000001, // row 10
];

// 36-bit codeword: 11 data + 25 parity (Hamming(36,11))
const INNER_GRID = 6;
const TOTAL_GRID = INNER_GRID + 2; // 8 with a 1-cell black border

export interface AprilTagRenderOptions {
  /** Foreground (cell) color. Default: black. */
  fg?: string;
  /** Background (cell) color. Default: white. */
  bg?: string;
  /** Extra CSS class to attach to the <svg>. */
  className?: string;
  /** <svg> title for accessibility. Default: `AprilTag #<id>`. */
  title?: string;
}

export class AprilTagError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AprilTagError";
  }
}

function assertValidId(id: number): void {
  if (!Number.isInteger(id) || id < TAG_ID_MIN || id > TAG_ID_MAX) {
    throw new AprilTagError(
      `AprilTag id must be an integer in [${TAG_ID_MIN}, ${TAG_ID_MAX}], got ${String(id)}.`,
    );
  }
}

/** Encode an 11-bit ID into its canonical 36-bit minimum codeword. */
function codewordForId(id: number): number {
  let codeword = 0;
  for (let row = 0; row < GENERATOR_MATRIX.length; row++) {
    if ((id & (1 << row)) !== 0) {
      codeword ^= GENERATOR_MATRIX[row]!;
    }
  }
  return minRotationCodeword(codeword);
}

/** Try all 4 rotations of the 6x6 codeword grid; return the smallest 36-bit value. */
function minRotationCodeword(codeword: number): number {
  const grid = codewordToGrid(codeword);
  let min = gridToCodeword(grid);
  for (let r = 1; r < 4; r++) {
    rotateGrid(grid);
    const candidate = gridToCodeword(grid);
    if (candidate < min) {
      min = candidate;
    }
  }
  return min;
}

function codewordToGrid(codeword: number): number[][] {
  const grid: number[][] = [];
  for (let r = 0; r < INNER_GRID; r++) {
    const row: number[] = [];
    for (let c = 0; c < INNER_GRID; c++) {
      const idx = r * INNER_GRID + c;
      row.push((codeword >> idx) & 1);
    }
    grid.push(row);
  }
  return grid;
}

function rotateGrid(grid: number[][]): void {
  // 90° clockwise: new[r][c] = old[INNER_GRID - 1 - c][r]
  const rotated: number[][] = [];
  for (let r = 0; r < INNER_GRID; r++) {
    const row: number[] = [];
    for (let c = 0; c < INNER_GRID; c++) {
      row.push(grid[INNER_GRID - 1 - c]![r]!);
    }
    rotated.push(row);
  }
  for (let r = 0; r < INNER_GRID; r++) {
    for (let c = 0; c < INNER_GRID; c++) {
      grid[r]![c] = rotated[r]![c]!;
    }
  }
}

function gridToCodeword(grid: number[][]): number {
  let codeword = 0;
  for (let r = 0; r < INNER_GRID; r++) {
    for (let c = 0; c < INNER_GRID; c++) {
      if (grid[r]![c]) {
        codeword |= 1 << (r * INNER_GRID + c);
      }
    }
  }
  return codeword;
}

/**
 * Return the 8x8 boolean grid (true = black cell) for a given tag ID, with a
 * 1-cell black border around the 6x6 inner codeword.
 */
export function getAprilTagGrid(id: number): boolean[][] {
  assertValidId(id);
  const codeword = codewordForId(id);
  const grid: boolean[][] = [];
  for (let r = 0; r < TOTAL_GRID; r++) {
    const row: boolean[] = [];
    for (let c = 0; c < TOTAL_GRID; c++) {
      const isBorder =
        r === 0 || c === 0 || r === TOTAL_GRID - 1 || c === TOTAL_GRID - 1;
      if (isBorder) {
        row.push(true);
      } else {
        const inner = codeword & (1 << ((r - 1) * INNER_GRID + (c - 1)));
        row.push(inner !== 0);
      }
    }
    grid.push(row);
  }
  return grid;
}

/**
 * Build a self-contained <svg> string for the given tag ID. The svg has no
 * external CSS, no JS, and no remote references — safe to inject into a
 * print-popup window via innerHTML.
 */
export function aprilTagToSvgString(
  id: number,
  sizePx: number,
  options: AprilTagRenderOptions = {},
): string {
  const grid = getAprilTagGrid(id);
  const fg = options.fg ?? "#000000";
  const bg = options.bg ?? "#ffffff";
  const title = options.title ?? `AprilTag #${String(id)}`;
  const className = options.className ?? "";
  const cell = sizePx / TOTAL_GRID;

  const cells: string[] = [];
  for (let r = 0; r < TOTAL_GRID; r++) {
    for (let c = 0; c < TOTAL_GRID; c++) {
      if (grid[r]![c]) {
        const x = c * cell;
        const y = r * cell;
        cells.push(
          `<rect x="${x.toFixed(3)}" y="${y.toFixed(3)}" width="${cell.toFixed(3)}" height="${cell.toFixed(3)}" fill="${fg}" />`,
        );
      }
    }
  }

  return (
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${sizePx} ${sizePx}" ` +
    `width="${sizePx}" height="${sizePx}" shape-rendering="crispEdges" ` +
    `role="img" aria-label="${title}" class="${className}">` +
    `<title>${title}</title>` +
    `<rect x="0" y="0" width="${sizePx}" height="${sizePx}" fill="${bg}" />` +
    cells.join("") +
    `</svg>`
  );
}
