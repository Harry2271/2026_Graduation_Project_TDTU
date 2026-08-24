'use client'

const JWT_KEY = 'jwt_token'

export function getToken(): string | null {
  if (typeof window === 'undefined') return null
  return localStorage.getItem(JWT_KEY)
}

export function setToken(token: string): void {
  localStorage.setItem(JWT_KEY, token)
}

export function clearToken(): void {
  localStorage.removeItem(JWT_KEY)
}
