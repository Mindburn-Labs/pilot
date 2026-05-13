import { createLogger } from '@pilot/shared/logger';
import { createHash } from 'node:crypto';

const log = createLogger('email');

/**
 * Email provider abstraction — sends transactional emails.
 *
 * Primary drivers:
 *   - `resend` (managed, modern, recommended for SaaS)
 *   - `smtp` (nodemailer — for self-hosters / enterprise SMTP)
 *   - `noop` (dev fallback — does not send; logs redacted delivery metadata)
 *
 * Selection via `EMAIL_PROVIDER` env var. Defaults to `noop` for safety.
 */
export interface EmailProvider {
  readonly kind: 'resend' | 'smtp' | 'noop';
  /** Send a magic-link login email. */
  sendMagicLink(params: { to: string; code: string; linkUrl: string }): Promise<void>;
}

export interface EmailConfig {
  provider?: string;
  from?: string;
  resendApiKey?: string;
  smtp?: {
    host: string;
    port: number;
    user?: string;
    pass?: string;
    secure?: boolean;
  };
}

export function createEmailProvider(config: EmailConfig): EmailProvider {
  const kind = (config.provider ?? 'noop').toLowerCase();
  const from = config.from ?? 'Pilot <onboarding@pilot.dev>';

  if (kind === 'resend') {
    if (!config.resendApiKey) {
      throw new Error('RESEND_API_KEY is required when EMAIL_PROVIDER=resend');
    }
    return new ResendProvider(config.resendApiKey, from);
  }

  if (kind === 'smtp') {
    if (!config.smtp?.host) {
      throw new Error('SMTP_HOST is required when EMAIL_PROVIDER=smtp');
    }
    return new SmtpProvider(config.smtp, from);
  }

  if (kind !== 'noop') {
    log.warn({ kind }, 'Unknown EMAIL_PROVIDER — falling back to noop');
  }
  return new NoopProvider();
}

// ─── Resend ───

class ResendProvider implements EmailProvider {
  readonly kind = 'resend';
  private clientPromise: Promise<unknown> | null = null;

  constructor(
    private readonly apiKey: string,
    private readonly from: string,
  ) {}

  private async getClient() {
    if (!this.clientPromise) {
      this.clientPromise = import('resend').then((m) => new m.Resend(this.apiKey));
    }
    return this.clientPromise;
  }

  async sendMagicLink(params: { to: string; code: string; linkUrl: string }): Promise<void> {
    const client = (await this.getClient()) as {
      emails: {
        send: (args: Record<string, unknown>) => Promise<{ error: { message?: string } | null }>;
      };
    };
    const { subject, html, text } = buildMagicLinkContent(params.code, params.linkUrl);
    const result = await client.emails.send({
      from: this.from,
      to: params.to,
      subject,
      html,
      text,
    });
    if (result.error) {
      throw new Error(`Resend send failed: ${result.error.message ?? 'unknown'}`);
    }
    log.info(emailLogMetadata(params), 'Magic link email sent via Resend');
  }
}

// ─── SMTP (nodemailer) ───

class SmtpProvider implements EmailProvider {
  readonly kind = 'smtp';
  private transporterPromise: Promise<unknown> | null = null;

  constructor(
    private readonly config: NonNullable<EmailConfig['smtp']>,
    private readonly from: string,
  ) {}

  private async getTransporter() {
    if (!this.transporterPromise) {
      this.transporterPromise = import('nodemailer').then((m) =>
        m.createTransport({
          host: this.config.host,
          port: this.config.port,
          secure: this.config.secure ?? this.config.port === 465,
          auth:
            this.config.user && this.config.pass
              ? { user: this.config.user, pass: this.config.pass }
              : undefined,
        }),
      );
    }
    return this.transporterPromise;
  }

  async sendMagicLink(params: { to: string; code: string; linkUrl: string }): Promise<void> {
    const transporter = (await this.getTransporter()) as {
      sendMail: (opts: Record<string, unknown>) => Promise<unknown>;
    };
    const { subject, html, text } = buildMagicLinkContent(params.code, params.linkUrl);
    await transporter.sendMail({
      from: this.from,
      to: params.to,
      subject,
      html,
      text,
    });
    log.info(emailLogMetadata(params), 'Magic link email sent via SMTP');
  }
}

// ─── Noop (dev / fallback) ───

class NoopProvider implements EmailProvider {
  readonly kind = 'noop';

  async sendMagicLink(params: { to: string; code: string; linkUrl: string }): Promise<void> {
    log.warn(
      emailLogMetadata(params),
      'EMAIL_PROVIDER=noop — email not actually sent. Use the dev response code directly in development.',
    );
  }
}

function emailLogMetadata(params: { to: string; code: string; linkUrl: string }) {
  return {
    toHash: createHash('sha256').update(params.to.trim().toLowerCase()).digest('hex'),
    toStoredInLogs: false,
    codeStoredInLogs: false,
    linkUrlStoredInLogs: false,
  };
}

// ─── Content Builder ───

function buildMagicLinkContent(
  code: string,
  linkUrl: string,
): {
  subject: string;
  html: string;
  text: string;
} {
  const subject = `Your Pilot login code: ${code}`;
  const text = `Welcome to Pilot.

Your login code is: ${code}

Or click this link to sign in directly:
${linkUrl}

This code expires in 15 minutes. If you didn't request it, you can safely ignore this email.

— Pilot
`;
  const html = `<!DOCTYPE html>
<html>
<body style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; max-width: 600px; margin: 0 auto; padding: 24px; color: #1a1a1a;">
  <h1 style="font-size: 20px; margin-bottom: 8px;">Sign in to Pilot</h1>
  <p style="font-size: 14px; line-height: 1.5; color: #555;">Your login code:</p>
  <div style="font-size: 32px; font-weight: 700; letter-spacing: 4px; background: #f4f4f5; padding: 16px; text-align: center; border-radius: 8px; margin: 16px 0;">${code}</div>
  <p style="font-size: 14px; line-height: 1.5;">Or <a href="${linkUrl}" style="color: #2563eb;">click here to sign in</a>.</p>
  <p style="font-size: 12px; color: #888; margin-top: 24px;">This code expires in 15 minutes. If you didn't request it, you can ignore this email.</p>
</body>
</html>`;
  return { subject, html, text };
}
