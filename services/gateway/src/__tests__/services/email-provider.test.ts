import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createEmailProvider } from '../../services/email-provider.js';

describe('createEmailProvider', () => {
  it('returns noop provider by default', () => {
    const provider = createEmailProvider({});
    expect(provider.kind).toBe('noop');
  });

  it('returns noop on unknown provider with warning', () => {
    const provider = createEmailProvider({ provider: 'mailgun' });
    expect(provider.kind).toBe('noop');
  });

  it('throws if EMAIL_PROVIDER=resend without RESEND_API_KEY', () => {
    expect(() => createEmailProvider({ provider: 'resend' })).toThrow(/RESEND_API_KEY/);
  });

  it('throws if EMAIL_PROVIDER=smtp without SMTP_HOST', () => {
    expect(() => createEmailProvider({ provider: 'smtp' })).toThrow(/SMTP_HOST/);
  });

  it('returns resend provider when configured', () => {
    const provider = createEmailProvider({
      provider: 'resend',
      resendApiKey: 're_test_key',
    });
    expect(provider.kind).toBe('resend');
  });

  it('returns smtp provider when configured', () => {
    const provider = createEmailProvider({
      provider: 'smtp',
      smtp: { host: 'smtp.example.com', port: 587 },
    });
    expect(provider.kind).toBe('smtp');
  });
});

describe('NoopProvider', () => {
  it('sendMagicLink resolves without throwing', async () => {
    const provider = createEmailProvider({ provider: 'noop' });
    await expect(
      provider.sendMagicLink({
        to: 'user@example.com',
        code: '123456',
        linkUrl: 'https://app.example.com/login?code=123456',
      }),
    ).resolves.toBeUndefined();
  });

  it('redacts recipient, code, and link URL from noop logs', async () => {
    vi.resetModules();
    const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };
    vi.doMock('@pilot/shared/logger', () => ({
      createLogger: vi.fn(() => logger),
    }));

    const { createEmailProvider } = await import('../../services/email-provider.js');
    const provider = createEmailProvider({ provider: 'noop' });
    await provider.sendMagicLink({
      to: 'User@Example.com',
      code: '123456',
      linkUrl: 'https://app.example.com/login?email=User%40Example.com&code=123456',
    });

    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({
        toHash: expect.stringMatching(/^[0-9a-f]{64}$/),
        toStoredInLogs: false,
        codeStoredInLogs: false,
        linkUrlStoredInLogs: false,
      }),
      expect.any(String),
    );
    const serializedLogs = JSON.stringify(logger.warn.mock.calls);
    expect(serializedLogs).not.toContain('User@Example.com');
    expect(serializedLogs).not.toContain('user@example.com');
    expect(serializedLogs).not.toContain('123456');
    expect(serializedLogs).not.toContain('https://app.example.com/login');

    vi.doUnmock('@pilot/shared/logger');
  });
});

describe('ResendProvider', () => {
  beforeEach(() => {
    vi.resetModules();
  });

  it('calls Resend API with correct payload', async () => {
    const mockSend = vi.fn().mockResolvedValue({ error: null });
    vi.doMock('resend', () => ({
      Resend: vi.fn().mockImplementation(() => ({ emails: { send: mockSend } })),
    }));

    const { createEmailProvider } = await import('../../services/email-provider.js');
    const provider = createEmailProvider({
      provider: 'resend',
      resendApiKey: 're_test',
      from: 'test@pilot.dev',
    });

    await provider.sendMagicLink({
      to: 'user@example.com',
      code: '654321',
      linkUrl: 'https://app.example.com/login',
    });

    expect(mockSend).toHaveBeenCalledOnce();
    const payload = mockSend.mock.calls[0]![0] as Record<string, string>;
    expect(payload.to).toBe('user@example.com');
    expect(payload.from).toBe('test@pilot.dev');
    expect(payload.subject).toContain('654321');
    expect(payload.html).toContain('654321');
    expect(payload.text).toContain('https://app.example.com/login');

    vi.doUnmock('resend');
  });

  it('redacts recipient from successful Resend logs', async () => {
    const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };
    const mockSend = vi.fn().mockResolvedValue({ error: null });
    vi.doMock('@pilot/shared/logger', () => ({
      createLogger: vi.fn(() => logger),
    }));
    vi.doMock('resend', () => ({
      Resend: vi.fn().mockImplementation(() => ({ emails: { send: mockSend } })),
    }));

    const { createEmailProvider } = await import('../../services/email-provider.js');
    const provider = createEmailProvider({
      provider: 'resend',
      resendApiKey: 're_test',
    });

    await provider.sendMagicLink({
      to: 'User@Example.com',
      code: '654321',
      linkUrl: 'https://app.example.com/login?email=User%40Example.com&code=654321',
    });

    expect(logger.info).toHaveBeenCalledWith(
      expect.objectContaining({
        toHash: expect.stringMatching(/^[0-9a-f]{64}$/),
        toStoredInLogs: false,
        codeStoredInLogs: false,
        linkUrlStoredInLogs: false,
      }),
      'Magic link email sent via Resend',
    );
    const serializedLogs = JSON.stringify(logger.info.mock.calls);
    expect(serializedLogs).not.toContain('User@Example.com');
    expect(serializedLogs).not.toContain('user@example.com');
    expect(serializedLogs).not.toContain('654321');
    expect(serializedLogs).not.toContain('https://app.example.com/login');

    vi.doUnmock('@pilot/shared/logger');
    vi.doUnmock('resend');
  });

  it('throws when Resend returns an error', async () => {
    const mockSend = vi.fn().mockResolvedValue({ error: { message: 'rate limited' } });
    vi.doMock('resend', () => ({
      Resend: vi.fn().mockImplementation(() => ({ emails: { send: mockSend } })),
    }));

    const { createEmailProvider } = await import('../../services/email-provider.js');
    const provider = createEmailProvider({
      provider: 'resend',
      resendApiKey: 're_test',
    });

    await expect(
      provider.sendMagicLink({ to: 'x@y.com', code: '111111', linkUrl: 'http://x' }),
    ).rejects.toThrow(/rate limited/);

    vi.doUnmock('resend');
  });
});

describe('SmtpProvider', () => {
  beforeEach(() => {
    vi.resetModules();
  });

  it('calls nodemailer transporter with correct payload', async () => {
    const mockSendMail = vi.fn().mockResolvedValue({});
    vi.doMock('nodemailer', () => ({
      createTransport: vi.fn(() => ({ sendMail: mockSendMail })),
    }));

    const { createEmailProvider } = await import('../../services/email-provider.js');
    const provider = createEmailProvider({
      provider: 'smtp',
      smtp: { host: 'smtp.example.com', port: 587, user: 'u', pass: 'p' },
      from: 'test@pilot.dev',
    });

    await provider.sendMagicLink({
      to: 'user@example.com',
      code: '999999',
      linkUrl: 'https://app.example.com/login',
    });

    expect(mockSendMail).toHaveBeenCalledOnce();
    const opts = mockSendMail.mock.calls[0]![0] as Record<string, string>;
    expect(opts.to).toBe('user@example.com');
    expect(opts.subject).toContain('999999');

    vi.doUnmock('nodemailer');
  });
});
