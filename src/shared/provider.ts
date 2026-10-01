import { costFromResponse } from './cost.js';
import { PROVIDERS } from './defaults.js';
import { JevError } from './errors.js';
import { parseJevResponse } from './parse.js';
import type { JevResponse, ProviderId, Questions } from './types.js';

export interface JevCallOptions {
  apiKey: string;
  model?: string;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
  signal?: AbortSignal;
}

export interface JevCallResult {
  response: JevResponse;
  model: string;
  provider: ProviderId;
  costUsd?: number;
  latencyMs: number;
}

export interface TestConnectionResult {
  ok: boolean;
  message: string;
  model?: string;
  latencyMs: number;
}

/** One interface; two implementations. Key and endpoint are swappable. */
export interface JevProvider {
  readonly id: ProviderId;
  readonly label: string;
  readonly defaultModel: string;
  callJev(state: unknown, questions: Questions, options: JevCallOptions): Promise<JevCallResult>;
  testConnection(
    apiKey: string,
    model?: string,
    fetchImpl?: typeof fetch,
  ): Promise<TestConnectionResult>;
}

export function parseRetryAfterMs(headerValue: string | null): number | undefined {
  if (!headerValue) return undefined;
  const seconds = Number(headerValue);
  if (Number.isFinite(seconds)) return Math.max(0, seconds * 1000);
  const date = Date.parse(headerValue);
  if (Number.isFinite(date)) return Math.max(0, date - Date.now());
  return undefined;
}

function statusToError(status: number, retryAfterMs: number | undefined, body: string): JevError {
  const detail = body ? `: ${body.slice(0, 300)}` : '';
  if (status === 401 || status === 403) {
    return new JevError('auth', `Provider rejected the key (${status})${detail}`, { status });
  }
  if (status === 429) {
    return new JevError('rate_limit', `Rate limited (429)${detail}`, { status, retryAfterMs });
  }
  if (status === 529) {
    return new JevError('overloaded', `Provider overloaded (529)${detail}`, { status, retryAfterMs });
  }
  if (status === 422) {
    return new JevError('invalid_request', `Request failed validation (422)${detail}`, { status });
  }
  if (status >= 500) {
    return new JevError('server', `Provider error (${status})${detail}`, { status, retryAfterMs });
  }
  return new JevError('unknown', `Unexpected response (${status})${detail}`, { status });
}

interface ProviderConfig {
  id: ProviderId;
  label: string;
  endpoint: string;
  defaultModel: string;
}

/** Shared HTTP implementation of the System One request/response shape. */
class HttpJevProvider implements JevProvider {
  constructor(private readonly cfg: ProviderConfig) {}

  get id(): ProviderId {
    return this.cfg.id;
  }
  get label(): string {
    return this.cfg.label;
  }
  get defaultModel(): string {
    return this.cfg.defaultModel;
  }

  async callJev(state: unknown, questions: Questions, options: JevCallOptions): Promise<JevCallResult> {
    if (!options.apiKey) {
      throw new JevError('no_key', 'No API key configured for this provider.');
    }
    const model = options.model || this.cfg.defaultModel;
    const body = { state, model, questions };

    const controller = new AbortController();
    const timeoutMs = options.timeoutMs ?? 20_000;
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    const onExternalAbort = () => controller.abort();
    options.signal?.addEventListener('abort', onExternalAbort, { once: true });

    const doFetch = options.fetchImpl ?? fetch;
    const start = Date.now();
    let res: Response;
    try {
      res = await doFetch(this.cfg.endpoint, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${options.apiKey}`,
        },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
    } catch (error) {
      if (controller.signal.aborted && !options.signal?.aborted) {
        throw new JevError('timeout', 'Request timed out.', { cause: error });
      }
      if (options.signal?.aborted) {
        throw new JevError('aborted', 'Request was aborted.', { cause: error });
      }
      throw new JevError('network', 'Network request failed.', { cause: error });
    } finally {
      clearTimeout(timer);
      options.signal?.removeEventListener('abort', onExternalAbort);
    }

    const latencyMs = Date.now() - start;
    const text = await res.text();
    if (!res.ok) {
      throw statusToError(res.status, parseRetryAfterMs(res.headers.get('retry-after')), text);
    }

    let json: unknown;
    try {
      json = JSON.parse(text);
    } catch (error) {
      throw new JevError('schema', 'Response was not valid JSON.', { cause: error });
    }
    const response = parseJevResponse(json);
    const costUsd = costFromResponse(response);
    return {
      response,
      model: response.model || model,
      provider: this.id,
      ...(costUsd !== undefined ? { costUsd } : {}),
      latencyMs,
    };
  }

  async testConnection(
    apiKey: string,
    model?: string,
    fetchImpl?: typeof fetch,
  ): Promise<TestConnectionResult> {
    const start = Date.now();
    try {
      const result = await this.callJev(
        'The support agent issued a full refund to the customer.',
        {
          is_about_refund: {
            type: 'noul',
            instructions: 'Is this text about a refund?',
          },
        },
        { apiKey, ...(model ? { model } : {}), ...(fetchImpl ? { fetchImpl } : {}), timeoutMs: 15_000 },
      );
      return {
        ok: true,
        message: `Connected. Model ${result.model} answered is_about_refund=${
          result.response.answers['is_about_refund']?.type === 'noul'
            ? (result.response.answers['is_about_refund'] as { noul: number }).noul
            : 'n/a'
        }.`,
        model: result.model,
        latencyMs: Date.now() - start,
      };
    } catch (error) {
      const jev = error instanceof JevError ? error : new JevError('unknown', String(error));
      return { ok: false, message: jev.friendly, latencyMs: Date.now() - start };
    }
  }
}

export class TypeSafeProvider extends HttpJevProvider {
  constructor() {
    super({
      id: 'typesafe',
      label: PROVIDERS.typesafe.label,
      endpoint: PROVIDERS.typesafe.endpoint,
      defaultModel: PROVIDERS.typesafe.defaultModel,
    });
  }
}

export class VercelGatewayProvider extends HttpJevProvider {
  constructor() {
    super({
      id: 'vercel-gateway',
      label: PROVIDERS['vercel-gateway'].label,
      endpoint: PROVIDERS['vercel-gateway'].endpoint,
      defaultModel: PROVIDERS['vercel-gateway'].defaultModel,
    });
  }
}

export function createProvider(id: ProviderId): JevProvider {
  return id === 'vercel-gateway' ? new VercelGatewayProvider() : new TypeSafeProvider();
}
