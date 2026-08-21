# Architecture

This fork of Accounted is a single-tenant-in-practice double-entry bookkeeping
system for Swedish accounting law, slimmed for one enskild firma on a private
network. This document explains how the system is put together and why some
parts are deliberately rigid.

## Overview

- **Framework**: Next.js (App Router) with React and TypeScript in strict mode.
- **Database**: Supabase (PostgreSQL with Row Level Security), which also
  provides auth (email/password). The whole stack runs locally: see
  [docs/SELF-HOSTING.md](docs/SELF-HOSTING.md).
- **Deployment**: Docker, behind a reverse proxy that terminates HTTPS
  (secure cookies require it even on a LAN).
- **UI**: Tailwind CSS with shadcn/ui components. UI strings live in
  `messages/sv.json` and `messages/en.json`.

## The bookkeeping engine

All accounting writes flow through one engine: `lib/bookkeeping/engine.ts`.

The journal entry lifecycle is draft, then commit:

1. `createDraftEntry()` creates an uncommitted entry that can still change.
2. `commitEntry()` posts it. The voucher number is assigned atomically by the
   `commit_journal_entry` database RPC, which keeps numbering sequential per
   series. Swedish law requires an unbroken, explainable voucher sequence.
3. `createJournalEntry()` does both steps in one call.

One invariant holds for every entry: debits equal credits, and both sides
are greater than zero.

Once committed, an entry changes through three paths:

- **Direct edit** (`edit_posted_entry` RPC): changes description, moves the
  entry date within its fiscal period, or replaces the full line set. The
  generic audit log records the change; there is no rättelse ceremony.
- **Inline rättelse** (the `correct_entry_metadata` and
  `correct_entry_lines_inline` RPCs): changes text/date or
  strike-and-replaces lines inside the same voucher, logging who/when to the
  write-once `journal_entry_rattelse_log`. This is the traceable variant of
  the direct edit, per BFL 5 kap 5 §.
- **Storno** (`reverseEntry()`/`correctEntry()` in
  `lib/core/bookkeeping/storno-service.ts`): cancels and replaces under new
  voucher numbers. The only path once a period is locked or closed.

Deletion works for any voucher via the `delete_voucher` RPC. The sequence
number is reused only when the deleted voucher held the highest number in
its series; a mid-series delete leaves a gap. Gaps are allowed; an
explanation can optionally be stored (`voucher_gap_explanations`, the
mechanism BFNAR 2013:2 describes), and year-end does not block on
unexplained gaps.

## Enforcement lives in the database

The rules above are not conventions; they are enforced by PostgreSQL triggers:

- Committed journal entries cannot be edited or deleted, except through the
  narrow trigger branches behind the sanctioned RPCs (transaction-local GUCs
  such as `gnubok.allow_metadata_rattelse`, `gnubok.allow_direct_edit` and
  `gnubok.allow_delete`, set only inside the RPC transaction) and the storno
  status transition. Each RPC re-verifies its own envelope: open unlocked
  period, company lock date, and post-state balance.
- Writes to closed or locked accounting periods are rejected, as are writes
  behind a company-wide lock date. These have no GUC escape.
- Documents are deleted only through the `delete_document` RPC
  (`gnubok.allow_document_delete`), which also handles documents linked to
  posted entries; delivery evidence for sent invoices stays undeletable.
  There is no database retention lock: `retention_expires_at` is
  informational, and BFL's 7-year retention of accounting records is the
  operator's own responsibility.

Application code never works around these triggers; the carve-outs are part
of the triggers themselves. If a code path hits one, the code path is wrong,
not the trigger.

Two smaller invariants that show up everywhere in the codebase:

- Monetary amounts are rounded with `Math.round(x * 100) / 100`. String-based
  rounding such as `toFixed()` causes drift at the öre level and breaks entry
  balance.
- Account numbers are strings (`'1930'`, never `1930`). They are identifiers,
  not quantities.

## Multi-tenancy and security

The multi-tenant backbone from upstream is intact (removing it would mean
rewriting hundreds of RLS policies for no gain), even though the surfaces
that used it for sharing are gone: invitations, teams and the company
switcher have been removed, so an installation is one operator with one
company. Users belong to companies through `company_members`, and every
business table carries a `company_id`:

- **Row Level Security** in PostgreSQL restricts rows to companies the user
  belongs to.
- **Explicit filtering**: queries still filter by `company_id` in code, as
  defense in depth, because service-role code paths bypass RLS.
- **Route guards**: API routes wrap `withRouteContext`, which resolves the
  authenticated user and the active company in one place. Routes never
  hand-roll their own auth.

`NEXT_PUBLIC_SELF_HOSTED=true` (the default here) disables session
timeouts, analytics and the upstream paywall.

## The one extension: MCP

Upstream's extension system remains, but this fork enables a single
extension: `extensions/general/mcp-server/`. It exposes the bookkeeping
engine as MCP (Model Context Protocol) tools so an external AI agent, with
its own API key and its own model account, can operate the ledger. There is
no LLM call anywhere in this codebase.

- Authentication uses scoped API keys (`gnubok_sk_*`, stored as SHA-256
  hashes) created under `/settings/api`, or MCP OAuth.
- Posting operations are staged: the agent proposes, and a human approves on
  the `/pending` page before anything is committed to the journal.
- The Swedish accounting skills under `.claude/skills/swedish-*` are compiled
  into the `agent_atom_registry` seed and served to agents via the
  `gnubok_load_skill` tool.

Core code never imports from `@/extensions/`; extensions integrate through
the event bus (`lib/events/bus.ts`) and the generated static registry
(`npm run setup:extensions`).

The project is licensed AGPL-3.0-or-later; this fork carries no extension
exception. See [LICENSE](LICENSE).

## Repository map

| Path | Contents |
|---|---|
| `app/` | Next.js App Router pages and API routes |
| `lib/bookkeeping/` | Engine, entry generators, account mapping, BAS chart data |
| `lib/core/` | Periods, year-end, storno, tax codes, audit, documents |
| `lib/reports/` | Balance sheet, income statement, VAT, SIE, NE-bilaga |
| `lib/bokslut/enskild-firma/` | Egenavgifter, räntefördelning, fonder for the NE flow |
| `components/` | React components (shadcn/ui based) |
| `extensions/general/mcp-server/` | The MCP tool surface |
| `packages/accounted-mcp` | stdio→HTTP MCP bridge (npm) |
| `supabase/migrations/` | Database schema, RLS policies, enforcement triggers |
| `packs/` | Konteringspaket (booking templates) as validated YAML |
| `messages/` | Swedish and English UI strings |
| `docs/` | Self-hosting, Docker and white-label guides |

## Testing

- Unit and route tests run on Vitest with mocked Supabase clients
  (`npm test`).
- Database behavior (triggers, RPCs, RLS) is tested against a real PostgreSQL
  instance in `*.pg.test.ts` files (`npm run test:pg`), because mocking cannot
  prove trigger semantics.
