let inMemoryAuthToken: string | null = null;

export function setAuthToken(token: string | null): void {
  inMemoryAuthToken = token;
}

export function getAuthToken(): string | null {
  return inMemoryAuthToken;
}

export async function apiRequest<T>(path: string, options: RequestInit = {}): Promise<T> {
  const headers = new Headers(options.headers || {});
  if (!headers.has('Content-Type') && options.body) {
    headers.set('Content-Type', 'application/json');
  }
  if (inMemoryAuthToken) {
    headers.set('Authorization', `Bearer ${inMemoryAuthToken}`);
  }

  const res = await fetch(path, { ...options, headers });
  const text = await res.text();
  let data: unknown = {};
  if (text) {
    try {
      data = JSON.parse(text);
    } catch {
      data = { error: text };
    }
  }

  if (!res.ok) {
    const errMsg =
      typeof data === 'object' && data !== null && 'error' in data
        ? String((data as { error: unknown }).error)
        : `Request failed (HTTP ${res.status})`;
    throw new Error(errMsg);
  }

  return data as T;
}

export function buildDownloadUrl(projectId: string, relativePath: string): string {
  const params = new URLSearchParams({ path: relativePath });
  if (inMemoryAuthToken) {
    params.set('downloadToken', inMemoryAuthToken);
  }
  return `/api/projects/${encodeURIComponent(projectId)}/download?${params.toString()}`;
}

export function formatMoney(amount: number | null | undefined, currency = 'USD'): string {
  if (amount === null || amount === undefined || !Number.isFinite(amount)) return '—';
  const sym = currency === 'EUR' ? '€' : currency === 'GBP' ? '£' : '$';
  return `${sym}${amount.toLocaleString(undefined, { minimumFractionDigits: 0, maximumFractionDigits: 2 })}`;
}

export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 1024) return `${bytes || 0} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
}

export function formatShortDate(iso: string | null | undefined): string {
  if (!iso) return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleString(undefined, {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

export function isSafeHttpUrl(url: string | null | undefined): boolean {
  if (!url) return false;
  try {
    const u = new URL(url);
    return u.protocol === 'https:' || u.protocol === 'http:';
  } catch {
    return false;
  }
}
