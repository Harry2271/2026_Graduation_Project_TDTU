import { Platform } from 'react-native';
import * as SecureStore from 'expo-secure-store';

const isNative = Platform.OS === 'ios' || Platform.OS === 'android';

async function isSecureStoreAvailable(): Promise<boolean> {
  if (!isNative) return false;
  try {
    return await SecureStore.isAvailableAsync();
  } catch {
    return false;
  }
}

const MEMORY_STORE = new Map<string, string>();

let secureStoreAvailable: boolean | null = null;

async function ensureChecked() {
  if (secureStoreAvailable === null) {
    secureStoreAvailable = await isSecureStoreAvailable();
  }
  return secureStoreAvailable;
}

export async function storageSetItem(key: string, value: string): Promise<void> {
  if (await ensureChecked()) {
    await SecureStore.setItemAsync(key, value);
  } else {
    MEMORY_STORE.set(key, value);
  }
}

export async function storageGetItem(key: string): Promise<string | null> {
  if (await ensureChecked()) {
    return await SecureStore.getItemAsync(key);
  }
  return MEMORY_STORE.get(key) ?? null;
}

export async function storageDeleteItem(key: string): Promise<void> {
  if (await ensureChecked()) {
    await SecureStore.deleteItemAsync(key);
  } else {
    MEMORY_STORE.delete(key);
  }
}
