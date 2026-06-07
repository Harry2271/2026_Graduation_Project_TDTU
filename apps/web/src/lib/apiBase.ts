/**
 * Centralized API base URL for the frontend.
 * Used by both RTK Query baseApi and any direct fetch calls (e.g., map images).
 */
export const API_BASE_URL =
  process.env.NEXT_PUBLIC_API_BASE_URL ?? 'http://localhost:5000';

export const MAPS_URL = `${API_BASE_URL}/api/robot/map-image`;