/**
 * VoxCPM TTS client — tokenizer-free multilingual speech (OpenBMB/VoxCPM, Apache-2.0).
 *
 * Thin HTTP client for the VoxCPM FastAPI server hosted by orggenome-compiler
 * (serving/voxcpm/). Scaffold only — the upstream endpoint returns 501 until
 * the model is wired.
 *
 * This sits alongside the OAuth-based connectors as an internal service
 * client; unlike gdrive / github / gmail, there is no token exchange — the
 * endpoint is a loopback-bound internal service reached via its VPC address.
 */

export interface VoxCpmClientConfig {
  readonly baseUrl: string;
  readonly timeoutMs?: number;
  readonly fetchImpl?: typeof globalThis.fetch;
}

export interface SynthesizeRequest {
  readonly text: string;
  readonly voiceId?: string;
  readonly language?: string;
  readonly sampleRate?: number;
}

const DEFAULT_TIMEOUT_MS = 60_000;

export class VoxCpmClient {
  private readonly baseUrl: string;
  private readonly timeoutMs: number;
  private readonly fetchImpl: typeof globalThis.fetch;

  constructor(cfg: VoxCpmClientConfig) {
    if (!cfg.baseUrl) throw new Error('VoxCpmClient: baseUrl is required');
    this.baseUrl = cfg.baseUrl.replace(/\/$/, '');
    this.timeoutMs = cfg.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.fetchImpl = cfg.fetchImpl ?? globalThis.fetch;
  }

  /**
   * Synthesize speech. Returns WAV bytes at the requested sample rate.
   *
   * Consumers must route through packages/helm-client before calling this,
   * per pilot invariant "MUST route every autonomous action through
   * packages/helm-client; no out-of-band tool calls."
   */
  async synthesize(request: SynthesizeRequest): Promise<Uint8Array> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const response = await this.fetchImpl(`${this.baseUrl}/tts`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          text: request.text,
          voiceId: request.voiceId,
          language: request.language ?? 'en',
          sampleRate: request.sampleRate ?? 48000,
        }),
        signal: controller.signal,
      });
      if (!response.ok) {
        const body = await response.text().catch(() => '');
        throw new Error(`VoxCPM TTS HTTP ${response.status}: ${body.slice(0, 200)}`);
      }
      const buffer = await response.arrayBuffer();
      return new Uint8Array(buffer);
    } finally {
      clearTimeout(timer);
    }
  }
}
