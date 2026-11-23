/**
 * Shared Gemini model filtering helpers for backend & frontend.
 * Restricts TEXT_MODEL / TRANSCRIBE_MODEL to the 5 active priority models
 * verified against Gemini models.list(), and TTS_MODEL to valid active TTS models.
 */

export const DEFAULT_TEXT_MODEL = 'gemini-3.5-flash';
export const DEFAULT_TRANSCRIBE_MODEL = 'gemini-3.5-flash';

export const ACTIVE_PRIORITY_MODELS = [
  'gemini-3.5-flash',
  'gemini-3.5-flash-lite',
  'gemini-3.1-flash-lite',
  'gemini-3.6-flash',
  'gemini-3.1-pro-preview',
] as const;

export function normalizeGeminiModelId(raw: string): string {
  return raw.replace(/^models\//, '').trim();
}

export function isDisallowedModel(rawId: string): boolean {
  const id = normalizeGeminiModelId(rawId).toLowerCase();
  if (!id) return true;
  if (/^gemini-(?:1(?:\.\d+)?|2(?:\.\d+)?)(?:-|$)/.test(id)) return true;
  if (/^gemini-pro(?:-|$)/.test(id)) return true;
  if (
    /(?:image|nano-banana|gemma|deep-research|antigravity|embedding|imagen|veo|lyria|aqa|bisect|robotics|deprecated|retired|legacy|hydrogen|3\.8|gemini-4-)/.test(
      id,
    )
  ) {
    return true;
  }
  return false;
}

export function isRetiredModel(rawId: string): boolean {
  return isDisallowedModel(rawId);
}

export function isAllowedTextOrTranscribeModel(rawId: string, verifiedCatalog: string[] = []): boolean {
  const clean = normalizeGeminiModelId(rawId).toLowerCase();
  if (!clean || isDisallowedModel(clean)) return false;
  const inPriorityList = (ACTIVE_PRIORITY_MODELS as readonly string[]).some(
    (m) => m.toLowerCase() === clean,
  );
  if (!inPriorityList) return false;
  if (verifiedCatalog.length > 0) {
    const normalizedCatalog = new Set(
      verifiedCatalog.map((m) => normalizeGeminiModelId(m).toLowerCase()),
    );
    return normalizedCatalog.has(clean);
  }
  return true;
}

export function isAllowedTtsModel(rawId: string, verifiedCatalog: string[] = []): boolean {
  const clean = normalizeGeminiModelId(rawId).toLowerCase();
  if (!clean || isDisallowedModel(clean)) return false;
  if (!clean.includes('tts')) return false;
  if (verifiedCatalog.length > 0) {
    const normalizedCatalog = new Set(
      verifiedCatalog.map((m) => normalizeGeminiModelId(m).toLowerCase()),
    );
    return normalizedCatalog.has(clean);
  }
  return true;
}

export function filterTtsModels(catalog: string[], currentModel?: string, extraModels: string[] = []): string[] {
  const seen = new Set<string>();
  const out: string[] = [];

  const maybeAdd = (raw: string | undefined) => {
    if (!raw) return;
    const id = normalizeGeminiModelId(raw);
    if (!id || !isAllowedTtsModel(id, catalog)) return;
    if (seen.has(id)) return;
    seen.add(id);
    out.push(id);
  };

  for (const m of catalog) maybeAdd(m);
  if (catalog.length === 0) {
    maybeAdd(currentModel);
    for (const m of extraModels) maybeAdd(m);
  } else if (currentModel) {
    maybeAdd(currentModel);
  }
  return out;
}

export function filterTextModels(catalog: string[], currentModel?: string): string[] {
  const seen = new Set<string>();
  const out: string[] = [];

  const maybeAdd = (raw: string | undefined) => {
    if (!raw) return;
    const id = normalizeGeminiModelId(raw);
    if (!id || !isAllowedTextOrTranscribeModel(id, catalog)) return;
    if (seen.has(id)) return;
    seen.add(id);
    out.push(id);
  };

  for (const m of ACTIVE_PRIORITY_MODELS) maybeAdd(m);
  if (currentModel && catalog.length === 0) {
    maybeAdd(currentModel);
  }
  return out;
}

export function filterTranscribeModels(catalog: string[], currentModel?: string): string[] {
  return filterTextModels(catalog, currentModel);
}
