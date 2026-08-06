import { create } from 'zustand';

import { api } from '@/lib/api';
import { disconnectSocket, setAuthToken } from '@/lib/socket';
import { storageDeleteItem, storageGetItem, storageSetItem } from '@/lib/storage';
import type { AuthUser } from '@/types/auth';

const TOKEN_KEY = 'auth_token';

function decodeJwtPayload(token: string): AuthUser | null {
  try {
    const payload = token.split('.')[1];
    const decoded = JSON.parse(atob(payload.replace(/-/g, '+').replace(/_/g, '/')));
    return { sub: decoded.sub, email: decoded.email };
  } catch {
    return null;
  }
}

type AuthStore = {
  token: string | null;
  user: AuthUser | null;
  isAuthenticated: boolean;
  isLoading: boolean;
  isRestoring: boolean;
  error: string | null;
  login: (email: string, password: string) => Promise<void>;
  register: (email: string, password: string) => Promise<void>;
  logout: () => Promise<void>;
  restoreSession: () => Promise<void>;
  clearError: () => void;
  getToken: () => string | null;
};

export const useAuthStore = create<AuthStore>((set, get) => ({
  token: null,
  user: null,
  isAuthenticated: false,
  isLoading: false,
  isRestoring: true,
  error: null,

  login: async (email, password) => {
    set({ isLoading: true, error: null });
    try {
      const { token } = await api.login(email, password);
      const user = decodeJwtPayload(token);
      if (!user) throw new Error('Token không hợp lệ');
      await storageSetItem(TOKEN_KEY, token);
      setAuthToken(token);
      set({ token, user, isAuthenticated: true, isLoading: false });
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Đăng nhập thất bại.';
      set({ error: message, isLoading: false });
      throw error;
    }
  },

  register: async (email, password) => {
    set({ isLoading: true, error: null });
    try {
      await api.register(email, password);
      set({ isLoading: false });
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Đăng ký thất bại.';
      set({ error: message, isLoading: false });
      throw error;
    }
  },

  logout: async () => {
    disconnectSocket();
    setAuthToken(null);
    await storageDeleteItem(TOKEN_KEY);
    set({ token: null, user: null, isAuthenticated: false, error: null });
  },

  restoreSession: async () => {
    try {
      const token = await storageGetItem(TOKEN_KEY);
      if (!token) {
        set({ isRestoring: false });
        return;
      }
      const user = decodeJwtPayload(token);
      if (!user) {
        await storageDeleteItem(TOKEN_KEY);
        set({ isRestoring: false });
        return;
      }
      setAuthToken(token);
      set({ token, user, isAuthenticated: true, isRestoring: false });
    } catch {
      set({ isRestoring: false });
    }
  },

  clearError: () => set({ error: null }),

  getToken: () => get().token,
}));
