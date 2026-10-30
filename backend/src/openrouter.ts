export const OPENROUTER_ENDPOINT = 'https://openrouter.ai/api/v1/chat/completions';
export const DEFAULT_AI_REQUEST_TIMEOUT_MS = 20_000;

export type OpenRouterUsage = {
  prompt_tokens?: number;
  completion_tokens?: number;
  total_tokens?: number;
};

export type OpenRouterTextRequest = {
  apiKey: string;
  model: string;
  systemInstruction: string;
  contents: string;
  timeoutMs: number;
  responseMimeType?: string;
  siteUrl?: string;
  appName?: string;
};

export type OpenRouterTextResponse = {
  text: string | null;
  usage?: OpenRouterUsage;
};

export type OpenRouterConfiguration = {
  provider: 'openrouter';
  apiKey: string;
  model: string;
  siteUrl?: string;
  appName?: string;
  timeoutMs: number;
};

export type AIEnvironment = Record<string, string | undefined>;

export class OpenRouterError extends Error {
  constructor(
    readonly category: string,
    readonly status?: number,
    message = category,
  ) {
    super(message);
    this.name = 'OpenRouterError';
  }
}

export function getOpenRouterConfiguration(
  env: AIEnvironment = process.env,
  overrides: Partial<Pick<OpenRouterConfiguration, 'apiKey' | 'model' | 'siteUrl' | 'appName' | 'timeoutMs'>> = {},
): OpenRouterConfiguration {
  const provider = env.AI_PROVIDER?.trim() || 'openrouter';
  if (provider !== 'openrouter') throw new OpenRouterError('unsupported_provider');

  const apiKey = overrides.apiKey === undefined ? env.OPENROUTER_API_KEY?.trim() || '' : overrides.apiKey.trim();
  const model = overrides.model === undefined ? env.OPENROUTER_MODEL?.trim() || '' : overrides.model.trim();
  if (!apiKey) throw new OpenRouterError('missing_api_key');
  if (!model) throw new OpenRouterError('missing_model');

  const timeoutValue = overrides.timeoutMs ?? Number(env.AI_REQUEST_TIMEOUT_MS || DEFAULT_AI_REQUEST_TIMEOUT_MS);
  const timeoutMs = Number.isInteger(timeoutValue) && timeoutValue > 0 ? timeoutValue : DEFAULT_AI_REQUEST_TIMEOUT_MS;
  const siteUrl = overrides.siteUrl ?? env.OPENROUTER_SITE_URL?.trim();
  const appName = overrides.appName ?? env.OPENROUTER_APP_NAME?.trim();
  return {
    provider: 'openrouter', apiKey, model, timeoutMs,
    ...(siteUrl ? { siteUrl } : {}),
    ...(appName ? { appName } : {}),
  };
}

export function isOpenRouterConfigured(env: AIEnvironment = process.env) {
  return (env.AI_PROVIDER?.trim() || 'openrouter') === 'openrouter'
    && Boolean(env.OPENROUTER_API_KEY?.trim())
    && Boolean(env.OPENROUTER_MODEL?.trim());
}

export function getConfiguredAIModel(env: AIEnvironment = process.env) {
  return env.OPENROUTER_MODEL?.trim() || 'unconfigured';
}

export async function requestOpenRouterText(request: OpenRouterTextRequest, fetcher: typeof fetch = fetch): Promise<OpenRouterTextResponse> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(new DOMException('Request timed out.', 'TimeoutError')), request.timeoutMs);
  const headers: Record<string, string> = {
    Authorization: `Bearer ${request.apiKey}`,
    'Content-Type': 'application/json',
  };
  if (request.siteUrl) headers['HTTP-Referer'] = request.siteUrl;
  if (request.appName) headers['X-OpenRouter-Title'] = request.appName;

  try {
    let response: Response;
    try {
      response = await fetcher(OPENROUTER_ENDPOINT, {
        method: 'POST', headers, signal: controller.signal,
        body: JSON.stringify({
          model: request.model,
          messages: [
            { role: 'system', content: request.systemInstruction },
            { role: 'user', content: request.contents },
          ],
          ...(request.responseMimeType === 'application/json' ? { response_format: { type: 'json_object' } } : {}),
        }),
      });
    } catch (error) {
      const timedOut = controller.signal.aborted;
      throw new OpenRouterError(timedOut ? 'timeout' : 'network_error', undefined, timedOut ? 'OpenRouter request timed out.' : 'OpenRouter network request failed.');
    }

    if (!response.ok) {
      const status = response.status;
      const category = status === 400 ? 'invalid_request'
        : status === 401 ? 'authentication_failure'
          : status === 402 ? 'payment_required'
            : status === 403 ? 'forbidden'
              : status === 408 ? 'timeout'
                : status === 429 ? 'rate_limited'
                  : status === 404 ? 'model_not_found'
                  : status >= 500 ? 'provider_server_error' : 'provider_error';
      throw new OpenRouterError(category, status);
    }

    let payload: unknown;
    try {
      payload = await response.json();
    } catch {
      if (controller.signal.aborted) throw new OpenRouterError('timeout');
      throw new OpenRouterError('invalid_json_response', response.status);
    }
    if (!payload || typeof payload !== 'object') throw new OpenRouterError('invalid_response', response.status);
    const choices = (payload as { choices?: unknown }).choices;
    if (!Array.isArray(choices) || choices.length === 0 || !choices[0] || typeof choices[0] !== 'object') {
      throw new OpenRouterError('missing_choices', response.status);
    }
    const message = (choices[0] as { message?: unknown }).message;
    const content = message && typeof message === 'object' ? (message as { content?: unknown }).content : undefined;
    if (typeof content !== 'string') throw new OpenRouterError('missing_content', response.status);
    const text = content.trim();
    if (!text) throw new OpenRouterError('empty_content', response.status);
    const rawUsage = (payload as { usage?: unknown }).usage;
    const usage = rawUsage && typeof rawUsage === 'object' ? rawUsage as OpenRouterUsage : undefined;
    return { text, ...(usage ? { usage } : {}) };
  } finally {
    clearTimeout(timeout);
  }
}
