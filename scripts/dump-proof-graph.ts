#!/usr/bin/env node
/**
 * dump-proof-graph — Phase 13 Track C2
 *
 * Emits the full HELM proof-graph DAG for a workspace (optionally filtered
 * by task id) in Graphviz DOT format. Pipe into `dot -Tpng` for the
 * governance demo asset used on the landing page.
 *
 * Usage:
 *   DATABASE_URL=... npx tsx scripts/dump-proof-graph.ts <workspaceId>
 *   DATABASE_URL=... npx tsx scripts/dump-proof-graph.ts <workspaceId> --task <taskId>
 *   DATABASE_URL=... npx tsx scripts/dump-proof-graph.ts <workspaceId> --format json
 */

import { createDb } from '@pilot/db/client';
import { sql } from 'drizzle-orm';

interface Node {
  id: string;
  decision_id: string;
  verdict: string;
  action: string;
  resource: string;
  principal: string;
  parent_evidence_pack_id: string | null;
}

function usage(): never {
  console.error('Usage: dump-proof-graph <workspaceId> [--task <taskId>] [--format dot|json]');
  process.exit(1);
}

async function main() {
  const args = process.argv.slice(2);
  const workspaceId = args[0];
  if (!workspaceId) usage();

  const taskIdx = args.indexOf('--task');
  const taskId = taskIdx >= 0 ? args[taskIdx + 1] : undefined;
  const fmtIdx = args.indexOf('--format');
  const format = (fmtIdx >= 0 ? args[fmtIdx + 1] : 'dot') ?? 'dot';

  const dbUrl = process.env['DATABASE_URL'];
  if (!dbUrl) {
    console.error('DATABASE_URL is required');
    process.exit(1);
  }

  const { db, close } = createDb(dbUrl);
  try {
    const result = taskId
      ? await db.execute(sql`
          WITH RECURSIVE chain AS (
            SELECT ep.*
            FROM evidence_packs ep
            JOIN task_runs tr ON tr.id = ep.task_run_id
            WHERE tr.task_id = ${taskId}
              AND ep.workspace_id = ${workspaceId}
            UNION
            SELECT ep.*
            FROM evidence_packs ep
            JOIN chain c ON c.parent_evidence_pack_id = ep.id
            WHERE ep.workspace_id = ${workspaceId}
            UNION
            SELECT ep.*
            FROM evidence_packs ep
            JOIN chain c ON ep.parent_evidence_pack_id = c.id
            WHERE ep.workspace_id = ${workspaceId}
          )
          SELECT DISTINCT id, decision_id, verdict, action, resource,
                          principal, parent_evidence_pack_id
          FROM chain
          ORDER BY received_at ASC
        `)
      : await db.execute(sql`
          SELECT id, decision_id, verdict, action, resource,
                 principal, parent_evidence_pack_id
          FROM evidence_packs
          WHERE workspace_id = ${workspaceId}
          ORDER BY received_at ASC
        `);

    const rows = (
      Array.isArray(result) ? result : ((result as { rows?: unknown[] }).rows ?? [])
    ) as Node[];

    if (format === 'json') {
      process.stdout.write(JSON.stringify(rows, null, 2) + '\n');
      return;
    }

    // Graphviz DOT
    process.stdout.write('digraph proofgraph {\n');
    process.stdout.write('  rankdir=LR;\n');
    process.stdout.write('  node [shape=box, style=rounded, fontname="Helvetica"];\n');
    for (const n of rows) {
      const fill = verdictFill(n.verdict);
      const label = `${n.action}\\n${n.resource}\\n${n.verdict}`;
      process.stdout.write(
        `  "${n.id}" [label="${label.replace(/"/g, '\\"')}", style="rounded,filled", fillcolor="${fill}"];\n`,
      );
    }
    for (const n of rows) {
      if (n.parent_evidence_pack_id) {
        process.stdout.write(`  "${n.parent_evidence_pack_id}" -> "${n.id}";\n`);
      }
    }
    process.stdout.write('}\n');
  } finally {
    await close();
  }
}

function verdictFill(verdict: string): string {
  const v = verdict.toUpperCase();
  if (v === 'ALLOW') return '#d5f5e3';
  if (v === 'DENY') return '#fadbd8';
  if (v === 'ESCALATE' || v === 'ESCALATE') return '#fdebd0';
  return '#e8e8e8';
}

main().catch((err) => {
  console.error('dump-proof-graph failed:', err);
  process.exit(1);
});
