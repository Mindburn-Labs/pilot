'use client';

import { useEffect, useState } from 'react';
import { apiFetch, isAuthenticated } from '../../../lib/api';

// ─── Governance budget + merkle dashboard (Phase 14 Track F) ───
//
// Surfaces helm-ai-kernel /budget/status + /merkle/root in one place. Founders
// can verify proof-graph integrity (merkle root) and see live HELM-side
// spend ceilings + alerts.

interface BudgetStatus {
  enforcer?: string;
  status?: 'active' | 'degraded' | 'unconfigured';
  dailyRemainingUsd?: number;
  dailyLimitUsd?: number;
  monthlyRemainingUsd?: number;
  monthlyLimitUsd?: number;
  alerts?: Array<{ level: 'info' | 'warn' | 'critical'; message: string }>;
}

interface MerkleRoot {
  root?: string;
  height?: number;
  generatedAt?: string;
}

export default function GovernanceBudgetPage() {
  const [budget, setBudget] = useState<BudgetStatus | null>(null);
  const [merkle, setMerkle] = useState<MerkleRoot | null>(null);
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
      const [b, m] = await Promise.all([
        apiFetch<BudgetStatus>('/api/governance/budget').catch(() => ({} as BudgetStatus)),
        apiFetch<MerkleRoot>('/api/governance/merkle').catch(() => ({} as MerkleRoot)),
      ]);
      setBudget(b);
      setMerkle(m);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  const fmtUsd = (v?: number) => (v == null ? '—' : `$${v.toFixed(2)}`);

  return (
    <main style={{ padding: 24, maxWidth: 980, margin: '0 auto' }}>
      <h1 style={{ fontSize: 22, marginBottom: 4 }}>Budget &amp; integrity</h1>
      <p style={{ opacity: 0.7, marginBottom: 24 }}>
        HELM sidecar spend ceilings + the current proof-graph merkle root.
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
        <h2 style={{ fontSize: 16, marginBottom: 12 }}>Budget</h2>
        <div
          style={{
            padding: 16,
            border: '1px solid rgba(255,255,255,0.1)',
            borderRadius: 8,
            display: 'grid',
            gridTemplateColumns: '1fr 1fr',
            gap: 16,
          }}
        >
          <Stat label="Status" value={budget?.status ?? 'unknown'} />
          <Stat label="Enforcer" value={budget?.enforcer ?? '—'} />
          <Stat
            label="Daily"
            value={`${fmtUsd(budget?.dailyRemainingUsd)} / ${fmtUsd(budget?.dailyLimitUsd)}`}
          />
          <Stat
            label="Monthly"
            value={`${fmtUsd(budget?.monthlyRemainingUsd)} / ${fmtUsd(budget?.monthlyLimitUsd)}`}
          />
        </div>
        {budget?.alerts && budget.alerts.length > 0 ? (
          <ul style={{ listStyle: 'none', padding: 0, marginTop: 12 }}>
            {budget.alerts.map((a, i) => (
              <li
                key={i}
                style={{
                  padding: 8,
                  marginBottom: 4,
                  fontSize: 13,
                  background:
                    a.level === 'critical'
                      ? 'rgba(255,80,80,0.12)'
                      : a.level === 'warn'
                      ? 'rgba(255,180,80,0.12)'
                      : 'rgba(120,180,200,0.12)',
                  borderRadius: 4,
                }}
              >
                <strong style={{ marginRight: 8 }}>{a.level.toUpperCase()}</strong>
                {a.message}
              </li>
            ))}
          </ul>
        ) : null}
      </section>

      <section>
        <h2 style={{ fontSize: 16, marginBottom: 12 }}>Proof-graph integrity</h2>
        <div
          style={{
            padding: 16,
            border: '1px solid rgba(255,255,255,0.1)',
            borderRadius: 8,
            fontFamily: 'ui-monospace, SFMono-Regular, monospace',
            fontSize: 13,
          }}
        >
          {merkle?.root ? (
            <>
              <div>root: {merkle.root}</div>
              <div style={{ opacity: 0.7, marginTop: 4 }}>
                height {merkle.height ?? '—'} ·{' '}
                generated{' '}
                {merkle.generatedAt ? new Date(merkle.generatedAt).toISOString() : '—'}
              </div>
            </>
          ) : (
            <span style={{ opacity: 0.6 }}>No merkle snapshot available.</span>
          )}
        </div>
      </section>
    </main>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <div style={{ opacity: 0.6, fontSize: 12, marginBottom: 4 }}>{label}</div>
      <div style={{ fontFamily: 'ui-monospace, SFMono-Regular, monospace', fontSize: 14 }}>
        {value}
      </div>
    </div>
  );
}
