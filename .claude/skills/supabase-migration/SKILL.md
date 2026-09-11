---
name: supabase-migration
description: "Generate Supabase database migrations for the Accounted project with correct RLS policies, triggers, indexes, and Swedish accounting constraints. Use when creating new tables, adding columns, modifying constraints (e.g. source_type CHECK), or any DDL operation on the Supabase database. Covers the enforcement invariants (entry balance, period locks, audit log) and the GUC carve-out pattern for the immutability triggers."
---

# Supabase Migration Generator

## Migration Numbering

Early migrations used the sequential series `20240101000001`-`20240101000038`; the project has long since moved to real timestamps. **New migrations use a current UTC timestamp** `YYYYMMDDHHMMSS_description.sql` (e.g. `20260603120000_add_x.sql`). Never reuse or back-date a number.

## New Table: Complete Template

Accounted is multi-tenant: company-scoped business data is owned by `company_id` and secured with the `user_company_ids()` RLS helper (NOT `auth.uid() = user_id`). Every new company-scoped table requires ALL of these. Missing any is a bug.

```sql
-- 1. Table with UUID PK + company_id + user_id FKs
CREATE TABLE public.tablename (
  id         uuid DEFAULT gen_random_uuid() PRIMARY KEY,
  company_id uuid NOT NULL REFERENCES public.companies(id) ON DELETE CASCADE,
  user_id    uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  -- domain columns --
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- 2. RLS
ALTER TABLE public.tablename ENABLE ROW LEVEL SECURITY;

-- 3. All four CRUD policies: scope to the user's companies
CREATE POLICY "view own-company tablename"
  ON public.tablename FOR SELECT USING (company_id IN (SELECT user_company_ids()));
CREATE POLICY "insert own-company tablename"
  ON public.tablename FOR INSERT WITH CHECK (company_id IN (SELECT user_company_ids()));
CREATE POLICY "update own-company tablename"
  ON public.tablename FOR UPDATE USING (company_id IN (SELECT user_company_ids()));
CREATE POLICY "delete own-company tablename"
  ON public.tablename FOR DELETE USING (company_id IN (SELECT user_company_ids()));

-- 4. Indexes (minimum: company_id + any FK/filter columns)
CREATE INDEX idx_tablename_company_id ON public.tablename (company_id);

-- 5. updated_at trigger
CREATE TRIGGER set_updated_at_tablename
  BEFORE UPDATE ON public.tablename
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

-- 6. Audit trigger
CREATE TRIGGER audit_tablename
  AFTER INSERT OR UPDATE OR DELETE ON public.tablename
  FOR EACH ROW EXECUTE FUNCTION public.write_audit_log();

-- 7. Reload PostgREST schema cache (required after structural DDL)
NOTIFY pgrst, 'reload schema';
```

## Child Tables (No Direct user_id)

Tables owned via parent use subquery-based RLS:

```sql
CREATE POLICY "view own-company child" ON public.child_table
  FOR SELECT USING (
    EXISTS (
      SELECT 1 FROM public.parent_table pt
      WHERE pt.id = child_table.parent_id
        AND pt.company_id IN (SELECT user_company_ids())
    )
  );
-- Repeat for INSERT (WITH CHECK), UPDATE, DELETE
```

## Expanding source_type CHECK

When adding a new journal entry source type, expand the constraint:

```sql
ALTER TABLE public.journal_entries
  DROP CONSTRAINT IF EXISTS journal_entries_source_type_check;
ALTER TABLE public.journal_entries
  ADD CONSTRAINT journal_entries_source_type_check
  CHECK (source_type IN (
    'manual','bank_transaction','invoice_created','invoice_paid',
    'invoice_cash_payment','credit_note','salary_payment',
    'opening_balance','year_end','storno','correction','import','system',
    'supplier_invoice_registered','supplier_invoice_paid',
    'supplier_invoice_cash_payment','supplier_credit_note',
    'NEW_TYPE_HERE'
  ));
```

## Enforcement Triggers

Migration `20240101000017` introduced the enforcement triggers; later migrations republish the full function bodies with transaction-local GUC carve-outs (pattern: `20260723210000`, `20260809210000_frihetspaket`). To change one, republish it in a new migration; never edit the old files.

- `enforce_journal_entry_immutability`: blocks edits/deletes on posted/reversed entries outside the GUC carve-outs (`gnubok.allow_delete`, `gnubok.allow_metadata_rattelse`, `gnubok.allow_source_type_retag`, `gnubok.allow_direct_edit`)
- `enforce_journal_entry_line_immutability`: same for lines (`gnubok.allow_line_rattelse`, `gnubok.allow_dimension_retag`, `gnubok.allow_direct_edit`)
- `enforce_period_lock`: blocks writes to closed/locked periods; no carve-out
- `block_document_deletion`: blocks deletion of docs linked to committed entries outside the `delete_document` carve-out (`gnubok.allow_document_delete`); no retention branch
- `set_committed_at` / retention expiry calculator: auto-set timestamps; `retention_expires_at` is informational (`enforce_retention_journal_entries` is dropped)

## Apply

Use `mcp__plugin_supabase_supabase__apply_migration` with snake_case `name`. Never modify existing migration files.

## Common Mistakes

1. Missing `ENABLE ROW LEVEL SECURITY`: table publicly accessible
2. Missing DELETE policy: users can't remove own records
3. Missing `updated_at` trigger: column never updates
4. Missing audit trigger: no audit trail
5. Hardcoded UUIDs in data migrations: use subqueries
6. Forgetting `source_type` CHECK expansion for new entry generators
