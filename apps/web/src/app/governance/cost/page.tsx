'use client';

import { useEffect, useState } from 'react';
import { apiFetch, isAuthenticated } from '../../../lib/api';

// ─── Governance cost attribution dashboard (Phase 14 Track F) ───
//
// Surfaces helm-ai-kernel /economic/charges + /economic/allocations.
// Operators see USD spend per workspace per subagent over the last 7
// days alongside any per-workspace allocation envelopes.

interface Charge {
  id?: string;
  subagent?: string;
  category?: string;
  amountUsd?: number;
  occurredAt?: string;
}

interface ChargesResponse {
  workspaceId?: string;
  totalUsd?: number;
  charges?: Charge[];
  error?: string;
}

interface Allocation {
  bucket?: string;
  allocatedUsd?: number;
  consumedUsd?: number;
}

interface AllocationsResponse {
  workspaceId?: string;
  allocations?: Allocation[];
  error?: string;
}

export default function GovernanceCostPage() {
  const [charges, setCharges] = useState<ChargesResponse | null>(null);
  const [allocs, setAllocs] = useState<AllocationsResponse | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (typeof window !== 'undefined' && !isAuthenticated()) {
      window.location.href = '/login';
      return;
    }
    void load();
  }, []);

  async function load() {
    try {
      const [c, a] = await Promise.all([
        apiFetch<ChargesResponse>('/api/governance/charges').catch(
          (err: Error) => ({ error: err.message }) as ChargesResponse,
        ),
        apiFetch<AllocationsResponse>('/api/governance/allocations').catch(
          (err: Error) => ({ error: err.message }) as AllocationsResponse,
        ),
      ]);
      setCharges(c);
      setAllocs(a);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  const fmtUsd = (v?: number) => (v == null ? '—' : `$${v.toFixed(4)}`);

  return (
    <main style={{ padding: 24, maxWidth: 980, margin: '0 auto' }}>
      <h1 style={{ fontSize: 22, marginBottom: 4 }}>Cost attribution</h1>
      <p style={{ opacity: 0.7, marginBottom: 24 }}>
        Per-workspace + per-subagent spend, last 7 days. Sourced from HELM
        sidecar economic ledger.
      </p>

      {error ? (
        <div
          style={{
            padding: 12,
            marginBottom: 16,
            background: 'rgba(255,80,80,0.12)',
            borderRadius: 6,
          }}
        >
          {error}
        </div>
      ) : null}

      <section style={{ marginBottom: 32 }}>
        <h2 style={{ fontSize: 16, marginBottom: 12 }}>
          Charges{' '}
          {charges?.totalUsd != null ? (
            <span style={{ opacity: 0.6, fontWeight: 400 }}>
              · total {fmtUsd(charges.totalUsd)}
            </span>
          ) : null}
        </h2>
        {charges?.error ? (
          <p style={{ opacity: 0.6 }}>{charges.error}</p>
        ) : (charges?.charges ?? []).length === 0 ? (
          <p style={{ opacity: 0.6 }}>No charges recorded.</p>
        ) : (
          <ul style={{ listStyle: 'none', padding: 0, margin: 0 }}>
            {(charges?.charges ?? []).slice(0, 100).map((row, i) => (
              <li
                key={row.id ?? i}
                style={{
                  padding: '8px 12px',
                  borderBottom: '1px solid rgba(255,255,255,0.05)',
                  fontFamily: 'ui-monospace, SFMono-Regular, monospace',
                  fontSize: 13,
                  display: 'grid',
                  gridTemplateColumns: '180px 200px 100px 1fr',
                  gap: 12,
                }}
              >
                <span style={{ opacity: 0.7 }}>
                  {row.occurredAt
                    ? new Date(row.occurredAt).toISOString().slice(0, 19)
                    : '—'}
                </span>
                <span>{row.subagent ?? '(unknown)'}</span>
                <span style={{ opacity: 0.6 }}>{row.category ?? '—'}</span>
                <span>{fmtUsd(row.amountUsd)}</span>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section>
        <h2 style={{ fontSize: 16, marginBottom: 12 }}>Allocations</h2>
        {allocs?.error ? (
          <p style={{ opacity: 0.6 }}>{allocs.error}</p>
        ) : (allocs?.allocations ?? []).length === 0 ? (
          <p style={{ opacity: 0.6 }}>No allocations configured.</p>
        ) : (
          <ul style={{ listStyle: 'none', padding: 0, margin: 0 }}>
            {(allocs?.allocations ?? []).map((row, i) => (
              <li
                key={i}
                style={{
                  padding: '12px 16px',
                  border: '1px solid rgba(255,255,255,0.1)',
                  borderRadius: 8,
                  marginBottom: 8,
                  display: 'grid',
                  gridTemplateColumns: '1fr 200px',
                  gap: 12,
                }}
              >
                <span style={{ fontWeight: 600 }}>{row.bucket ?? '(default)'}</span>
                <span
                  style={{
                    fontFamily: 'ui-monospace, SFMono-Regular, monospace',
                    fontSize: 13,
                  }}
                >
                  {fmtUsd(row.consumedUsd)} / {fmtUsd(row.allocatedUsd)}
                </span>
              </li>
            ))}
          </ul>
        )}
      </section>
    </main>
  );
}
