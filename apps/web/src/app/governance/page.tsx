'use client';

import { useEffect, useMemo, useState } from 'react';
import { apiFetch, isAuthenticated } from '../../lib/api';

interface Receipt {
  id: string;
  decisionId: string;
  taskRunId: string | null;
  verdict: string;
  reasonCode: string | null;
  policyVersion: string;
  decisionHash: string | null;
  action: string;
  resource: string;
  principal: string;
  receivedAt: string;
  verifiedAt: string | null;
  parentEvidencePackId?: string | null;
}

interface ProofGraph {
  taskId: string;
  nodes: Receipt[];
  edges: Array<{ from: string; to: string }>;
}

interface Status {
  helmConfigured: boolean;
  live: { ok: boolean; latencyMs: number; version?: string; error?: string } | null;
  latestSnapshot: { checkedAt: string; gatewayOk: boolean; latencyMs: number } | null;
}

export default function GovernancePage() {
  const [status, setStatus] = useState<Status | null>(null);
  const [receipts, setReceipts] = useState<Receipt[]>([]);
  const [selected, setSelected] = useState<Receipt | null>(null);
  const [signedBlob, setSignedBlob] = useState<unknown>(null);
  const [graph, setGraph] = useState<ProofGraph | null>(null);

  useEffect(() => {
    if (typeof window !== 'undefined' && !isAuthenticated()) {
      window.location.href = '/login';
      return;
    }
    void Promise.all([loadStatus(), loadReceipts()]);
  }, []);

  async function loadStatus() {
    const data = await apiFetch<Status>('/api/governance/status');
    if (data) setStatus(data);
  }

  async function loadReceipts() {
    const data = await apiFetch<{ receipts: Receipt[] }>(
      '/api/governance/receipts?limit=50',
    );
    if (data?.receipts) setReceipts(data.receipts);
  }

  async function openReceipt(r: Receipt) {
    setSelected(r);
    setSignedBlob(null);
    setGraph(null);
    const detail = await apiFetch<{ receipt: Receipt; signedBlob: unknown }>(
      `/api/governance/receipts/${encodeURIComponent(r.decisionId)}`,
    );
    if (detail) setSignedBlob(detail.signedBlob);
    if (r.taskRunId) {
      const g = await apiFetch<ProofGraph>(
        `/api/governance/proofgraph/${encodeURIComponent(r.taskRunId)}`,
      );
      if (g) setGraph(g);
    }
  }

  return (
    <main style={{ maxWidth: 1200, margin: '0 auto', padding: '32px 24px' }}>
      <header style={{ marginBottom: 24 }}>
        <h1 style={{ margin: 0, fontSize: 28 }}>Governance</h1>
        <p style={{ opacity: 0.7, fontSize: 14 }}>
          Every HELM-governed decision in this workspace. Click a receipt to inspect its
          signed blob + proof-graph DAG.
        </p>
      </header>

      {status && (
        <section
          style={{
            marginBottom: 24,
            padding: 12,
            background: status.live?.ok ? '#0f1f17' : '#1f0f0f',
            border: '1px solid ' + (status.live?.ok ? '#1f3a2a' : '#3a1f1f'),
            borderRadius: 8,
            fontSize: 13,
          }}
        >
          HELM sidecar:&nbsp;
          <strong style={{ color: status.live?.ok ? '#3ec28f' : '#e27a7a' }}>
            {status.helmConfigured
              ? status.live?.ok
                ? 'healthy'
                : 'unreachable'
              : 'not configured'}
          </strong>
          {status.live?.latencyMs !== undefined && ` · ${status.live.latencyMs}ms`}
          {status.live?.version && ` · v${status.live.version}`}
          {status.live?.error && ` · ${status.live.error}`}
        </section>
      )}

      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 16 }}>
        <section>
          <h2 style={{ fontSize: 18, marginBottom: 12 }}>Receipts ({receipts.length})</h2>
          {receipts.length === 0 ? (
            <p style={{ opacity: 0.6 }}>No receipts yet. Run a task to generate one.</p>
          ) : (
            <ul
              style={{
                listStyle: 'none',
                padding: 0,
                margin: 0,
                maxHeight: 600,
                overflowY: 'auto',
              }}
            >
              {receipts.map((r) => (
                <li
                  key={r.id}
                  onClick={() => openReceipt(r)}
                  role="button"
                  tabIndex={0}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' || e.key === ' ') openReceipt(r);
                  }}
                  aria-pressed={selected?.id === r.id}
                  style={{
                    padding: 10,
                    border:
                      selected?.id === r.id ? '1px solid #4a90e2' : '1px solid #2a2a2a',
                    borderRadius: 6,
                    marginBottom: 6,
                    cursor: 'pointer',
                    background: selected?.id === r.id ? '#15243a' : '#111',
                    fontSize: 12,
                  }}
                >
                  <div style={{ display: 'flex', justifyContent: 'space-between' }}>
                    <strong>{r.action}</strong>
                    <span style={{ color: verdictColor(r.verdict) }}>{r.verdict}</span>
                  </div>
                  <div style={{ opacity: 0.7, marginTop: 4 }}>
                    {r.resource} · {new Date(r.receivedAt).toLocaleString()}
                  </div>
                </li>
              ))}
            </ul>
          )}
        </section>

        <section>
          <h2 style={{ fontSize: 18, marginBottom: 12 }}>Detail</h2>
          {!selected ? (
            <p style={{ opacity: 0.6 }}>Select a receipt to inspect.</p>
          ) : (
            <div
              style={{
                padding: 14,
                background: '#111',
                border: '1px solid #2a2a2a',
                borderRadius: 8,
                fontSize: 13,
              }}
            >
              <div style={{ marginBottom: 10 }}>
                <div style={{ opacity: 0.6, fontSize: 11 }}>Decision</div>
                <code style={{ fontSize: 11, wordBreak: 'break-all' }}>
                  {selected.decisionId}
                </code>
              </div>
              <KeyVal label="Action" value={selected.action} />
              <KeyVal label="Resource" value={selected.resource} />
              <KeyVal label="Principal" value={selected.principal} />
              <KeyVal
                label="Verdict"
                value={selected.verdict}
                highlight={verdictColor(selected.verdict)}
              />
              <KeyVal label="Policy" value={selected.policyVersion} />
              {selected.decisionHash && (
                <KeyVal label="Hash" value={selected.decisionHash} mono />
              )}
              <KeyVal
                label="Received"
                value={new Date(selected.receivedAt).toLocaleString()}
              />
              {selected.verifiedAt && (
                <KeyVal
                  label="Verified"
                  value={new Date(selected.verifiedAt).toLocaleString()}
                />
              )}

              {signedBlob ? (
                <details style={{ marginTop: 16 }}>
                  <summary style={{ cursor: 'pointer', fontSize: 12 }}>Signed blob</summary>
                  <pre
                    style={{
                      marginTop: 8,
                      padding: 10,
                      background: '#000',
                      border: '1px solid #222',
                      borderRadius: 4,
                      fontSize: 10,
                      overflow: 'auto',
                      maxHeight: 240,
                    }}
                  >
                    {JSON.stringify(signedBlob, null, 2)}
                  </pre>
                </details>
              ) : null}

              {graph ? <DagTree graph={graph} /> : null}
            </div>
          )}
        </section>
      </div>
    </main>
  );
}

function KeyVal({
  label,
  value,
  highlight,
  mono,
}: {
  label: string;
  value: string;
  highlight?: string;
  mono?: boolean;
}) {
  return (
    <div
      style={{
        marginBottom: 6,
        display: 'flex',
        justifyContent: 'space-between',
        gap: 8,
      }}
    >
      <span style={{ opacity: 0.6, fontSize: 11 }}>{label}</span>
      <span
        style={{
          color: highlight ?? 'inherit',
          fontFamily: mono ? 'monospace' : 'inherit',
          fontSize: mono ? 11 : 13,
          wordBreak: 'break-all',
          textAlign: 'right',
        }}
      >
        {value}
      </span>
    </div>
  );
}

function verdictColor(verdict: string): string {
  const v = verdict.toUpperCase();
  if (v === 'ALLOW') return '#3ec28f';
  if (v === 'DENY') return '#e27a7a';
  if (v === 'ESCALATE' || v === 'ESCALATE') return '#e2a84a';
  return '#888';
}

/**
 * DagTree — renders the proof-graph as an indented tree. Roots are nodes
 * with no parent in the set; children are those whose parentEvidencePackId
 * points to a node in the set. No dagre/xyflow dep — lightweight, works
 * well up to ~50 nodes.
 */
function DagTree({ graph }: { graph: ProofGraph }) {
  const childrenByParent = useMemo(() => {
    const map = new Map<string, Receipt[]>();
    for (const edge of graph.edges) {
      const child = graph.nodes.find((n) => n.id === edge.to);
      if (!child) continue;
      const list = map.get(edge.from) ?? [];
      list.push(child);
      map.set(edge.from, list);
    }
    return map;
  }, [graph]);

  const parentIds = new Set(graph.edges.map((e) => e.to));
  const roots = graph.nodes.filter((n) => !parentIds.has(n.id));

  return (
    <div style={{ marginTop: 16 }}>
      <div style={{ fontSize: 12, opacity: 0.6, marginBottom: 8 }}>
        Proof graph — {graph.nodes.length} nodes
      </div>
      <ul style={{ listStyle: 'none', padding: 0, margin: 0, fontSize: 12 }}>
        {roots.map((root) => (
          <DagNode
            key={root.id}
            node={root}
            depth={0}
            childrenByParent={childrenByParent}
          />
        ))}
      </ul>
    </div>
  );
}

function DagNode({
  node,
  depth,
  childrenByParent,
}: {
  node: Receipt;
  depth: number;
  childrenByParent: Map<string, Receipt[]>;
}) {
  const children = childrenByParent.get(node.id) ?? [];
  return (
    <li style={{ marginLeft: depth * 16, marginBottom: 4 }}>
      <div
        style={{
          padding: 6,
          background: '#0a0a0a',
          border: '1px solid #222',
          borderRadius: 4,
          display: 'inline-block',
        }}
      >
        <span style={{ color: verdictColor(node.verdict) }}>●</span>&nbsp;
        <strong>{node.action}</strong> · {node.resource}
      </div>
      {children.length > 0 && (
        <ul style={{ listStyle: 'none', padding: 0, margin: 4 }}>
          {children.map((c) => (
            <DagNode
              key={c.id}
              node={c}
              depth={depth + 1}
              childrenByParent={childrenByParent}
            />
          ))}
        </ul>
      )}
    </li>
  );
}
