export type AuthMode = "dev" | "firebase";

export const AUTH_MODE: AuthMode = import.meta.env.VITE_AUTH_MODE === "firebase" ? "firebase" : "dev";
export const DEV_TOKEN = import.meta.env.VITE_DEV_TOKEN ?? "";
export const API_BASE = (import.meta.env.VITE_API_BASE || "/api/v2").replace(/\/$/, "");

export const FIREBASE_CONFIG = {
  apiKey: import.meta.env.VITE_FIREBASE_API_KEY ?? "",
  authDomain: import.meta.env.VITE_FIREBASE_AUTH_DOMAIN ?? "",
  projectId: import.meta.env.VITE_FIREBASE_PROJECT_ID ?? "",
};
