export class ZenmuxError extends Error {
  constructor(message, { status = null, body = null } = {}) {
    super(message);
    this.name = 'ZenmuxError';
    this.status = status;
    this.body = body;
  }
}

/**
 * Call the async-compatible upstream image generation endpoint.
 * The body and headers are passed through untouched (except hop-by-hop headers,
 * which are handled by the caller).
 */
export async function generateImage({
  baseUrl,
  body,
  headers,
  timeoutMs = 15 * 60 * 1000,
  fetchImpl = fetch,
  signal,
}) {
  const url = `${baseUrl}/images/generations`;
  const controller = new AbortController();

  const onAbort = () => controller.abort(signal?.reason);
  if (signal) {
    if (signal.aborted) controller.abort(signal.reason);
    else signal.addEventListener('abort', onAbort, { once: true });
  }

  const timer = setTimeout(() => controller.abort(new Error('upstream timeout')), timeoutMs);

  try {
    const res = await fetchImpl(url, {
      method: 'POST',
      headers,
      body,
      signal: controller.signal,
    });

    const text = await res.text();
    let json = null;
    if (text) {
      try {
        json = JSON.parse(text);
      } catch {
        json = { raw: text };
      }
    }

    if (!res.ok) {
      const message =
        json?.error?.message || json?.message || `upstream responded with HTTP ${res.status}`;
      throw new ZenmuxError(message, { status: res.status, body: json });
    }

    return json;
  } catch (err) {
    if (err instanceof ZenmuxError) throw err;
    if (controller.signal.aborted) {
      throw new ZenmuxError('upstream request aborted or timed out', { status: 504 });
    }
    throw err;
  } finally {
    clearTimeout(timer);
    if (signal) signal.removeEventListener('abort', onAbort);
  }
}
