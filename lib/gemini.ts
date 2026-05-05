import { GoogleGenerativeAI } from "@google/generative-ai";

export const DEFAULT_GEMINI_MODEL = "gemini-2.5-flash";

export function getGeminiModelId(): string {
  const fromEnv = process.env.GEMINI_MODEL?.trim();
  return fromEnv || DEFAULT_GEMINI_MODEL;
}

export function getGeminiApiKey(): string | undefined {
  const raw =
    process.env.GEMINI_API_KEY ?? process.env.GOOGLE_GENERATIVE_AI_API_KEY;
  return raw?.trim() || undefined;
}

export function getGeminiClient(): GoogleGenerativeAI | null {
  const key = getGeminiApiKey();
  if (!key) return null;
  return new GoogleGenerativeAI(key);
}

export function isGeminiConfigured(): boolean {
  return Boolean(getGeminiApiKey());
}
