import { randomUUID } from 'node:crypto';
import { test, expect, type APIRequestContext } from '@playwright/test';

/**
 * End-to-end auth flow:
 *   1. Request magic link code (dev mode returns code in response)
 *   2. Verify code → get session token
 *   3. Use token to hit a protected endpoint
 *   4. Delete session → token no longer works
 */

// Each test gets a unique email so they don't collide
function uniqueEmail(): string {
  const rand = Math.random().toString(36).slice(2, 10);
  return `e2e-${rand}@pilot.test`;
}

function uniqueClientIp(): string {
  return `e2e-${randomUUID()}`;
}

async function magicAuth(
  request: APIRequestContext,
  email: string,
  clientIp = uniqueClientIp(),
): Promise<string> {
  const headers = { 'x-forwarded-for': clientIp };
  const requestResp = await request.post('/api/auth/email/request', {
    headers,
    data: { email },
  });
  expect(requestResp.status()).toBe(200);
  const requestBody = await requestResp.json();
  expect(requestBody).toHaveProperty('code');

  const verifyResp = await request.post('/api/auth/email/verify', {
    headers,
    data: { email, code: requestBody.code },
  });
  expect(verifyResp.status()).toBe(200);
  const verifyBody = await verifyResp.json();
  expect(verifyBody).toHaveProperty('token');
  expect(verifyBody).toHaveProperty('user');
  expect(verifyBody).toHaveProperty('workspace');
  return verifyBody.token;
}

test.describe('Magic Link Authentication', () => {
  test('full auth cycle: request → verify → authenticated → logout', async ({ request }) => {
    const email = uniqueEmail();

    // Step 1: Request + verify
    const token = await magicAuth(request, email);
    expect(token).toBeTruthy();

    // Step 2: Token works on protected endpoint (tasks list)
    const tasksResp = await request.get('/api/tasks', {
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(tasksResp.status()).toBeLessThan(500);
    // 400 (missing workspaceId) is fine — it proves auth passed
    expect([200, 400]).toContain(tasksResp.status());

    // Step 3: Unauthenticated request is blocked
    const unauthResp = await request.get('/api/tasks', {
      headers: { Authorization: `Bearer invalid-${randomUUID()}` },
    });
    expect(unauthResp.status()).toBe(401);

    // Step 4: Logout
    const logoutResp = await request.delete('/api/auth/session', {
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(logoutResp.status()).toBe(200);

    // Step 5: Token no longer works
    const afterLogoutResp = await request.get('/api/tasks', {
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(afterLogoutResp.status()).toBe(401);
  });

  test('invalid email returns 400', async ({ request }) => {
    const response = await request.post('/api/auth/email/request', {
      headers: { 'x-forwarded-for': uniqueClientIp() },
      data: { email: 'not-an-email' },
    });
    expect(response.status()).toBe(400);
  });

  test('wrong verification code returns 401', async ({ request }) => {
    const email = uniqueEmail();
    const headers = { 'x-forwarded-for': uniqueClientIp() };
    await request.post('/api/auth/email/request', { headers, data: { email } });
    const response = await request.post('/api/auth/email/verify', {
      headers,
      data: { email, code: '999999' },
    });
    expect(response.status()).toBe(401);
  });

  test('missing fields on verify returns 400', async ({ request }) => {
    const response = await request.post('/api/auth/email/verify', {
      headers: { 'x-forwarded-for': uniqueClientIp() },
      data: { email: 'only@email.com' }, // no code
    });
    expect(response.status()).toBe(400);
  });

  test('auth endpoints are rate limited', async ({ request }) => {
    // /api/auth/* has max 5 req/min
    const email = `rate-limit-${randomUUID()}@pilot.test`;
    const results: number[] = [];
    const headers = { 'x-forwarded-for': uniqueClientIp() };
    for (let i = 0; i < 8; i++) {
      const resp = await request.post('/api/auth/email/request', { headers, data: { email } });
      results.push(resp.status());
    }
    // At least one request should hit 429
    expect(results).toContain(429);
  });
});
