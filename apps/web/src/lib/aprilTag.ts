/**
 * tag36h11 AprilTag generator (client-side).
 *
 * Provides canonical tag36h11 assets from the official AprilRobotics image
 * repository. Keeping the generator as an official PNG avoids reimplementing
 * the family codeword and bit-coordinate mapping in browser JavaScript.
 *
 * Used for the future robot-vision pipeline (the warehouse robot will read
 * the tag with a camera). The handheld scanner still uses the existing QR
 * code (which encodes the Mongo _id).
 *
 * Reference: apriltag/tag36h11.c in https://github.com/AprilRobotics/apriltag
 */

const TAG_ID_MIN = 0
const TAG_ID_MAX = 586

const TAG_IMAGE_BASE = 'https://raw.githubusercontent.com/AprilRobotics/apriltag-imgs/master/tag36h11'

export interface AprilTagRenderOptions {
  /** Background color behind the official tag image. Default: white. */
  bg?: string
  /** Extra CSS class to attach to the <svg>. */
  className?: string
  /** <svg> title for accessibility. Default: `AprilTag #<id>`. */
  title?: string
}

export class AprilTagError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'AprilTagError'
  }
}

function assertValidId(id: number): void {
  if (!Number.isInteger(id) || id < TAG_ID_MIN || id > TAG_ID_MAX) {
    throw new AprilTagError(
      `AprilTag id must be an integer in [${TAG_ID_MIN}, ${TAG_ID_MAX}], got ${String(id)}.`
    )
  }
}

export function getAprilTagImageUrl(id: number): string {
  assertValidId(id)
  return `${TAG_IMAGE_BASE}/tag36_11_${String(id).padStart(5, '0')}.png`
}

/**
 * Build a self-contained <svg> string for the given tag ID. The svg has no
 * external CSS, no JS, and no remote references — safe to inject into a
 * print-popup window via innerHTML.
 */
export function aprilTagToSvgString(
  id: number,
  sizePx: number,
  options: AprilTagRenderOptions = {}
): string {
  const bg = options.bg ?? '#ffffff'
  const title = options.title ?? `AprilTag #${String(id)}`
  const className = options.className ?? ''
  const imageUrl = getAprilTagImageUrl(id)
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${sizePx} ${sizePx}" width="${sizePx}" height="${sizePx}" role="img" aria-label="${title}" class="${className}"><title>${title}</title><rect width="100%" height="100%" fill="${bg}"/><image href="${imageUrl}" width="100%" height="100%" preserveAspectRatio="none"/></svg>`
}
