-- Frihetspaketet: this fork is a single-operator installation where the
-- operator carries the BFL responsibility personally. Four standing
-- restrictions become sanctioned write paths, following the carve-out
-- pattern of 20260723210000 (transaction-local GUC + SECURITY DEFINER RPC):
--
--   1. delete_voucher replaces delete_last_voucher: any voucher can be
--      deleted regardless of position in its series. The sequence counter
--      is only decremented when the deleted voucher held the highest
--      number, so a mid-series delete leaves a gap. Gap explanations are
--      optional from here on (year-end readiness no longer blocks on them;
--      app-side change).
--   2. edit_posted_entry: direct edit of a posted entry (description,
--      entry_date within the period, full line replacement) without the
--      rättelse ceremony. Storno and inline rättelse remain available as
--      the traceable alternatives.
--   3. delete_document: documents can be deleted even when linked to a
--      posted entry.
--   4. The 7-year retention blocks are dropped. retention_expires_at and
--      its calculator stay as information; retention is the operator's own
--      responsibility now.
--
-- Unchanged invariants: debet=kredit (edit_posted_entry re-verifies the
-- post-state balance straight from the table), fiscal period locks and the
-- company lock date, audit_log immutability, invoice delivery evidence,
-- sandbox rules.
--
-- New GUCs: gnubok.allow_direct_edit, gnubok.allow_document_delete.

-- =============================================================================
-- 1. Entry-immutability carve-out: direct edit
-- =============================================================================
-- Current body verbatim (last replaced by 20260723210000) plus ONE branch:
-- while the transaction-local GUC set by edit_posted_entry() is active,
-- permit an UPDATE of a POSTED entry iff ONLY description/entry_date change.
-- Voucher number, period, linkage and every future column stay immutable by
-- construction.

CREATE OR REPLACE FUNCTION public.enforce_journal_entry_immutability()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'public'
AS $function$
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF current_setting('gnubok.allow_delete', true) = 'true' THEN
      RETURN OLD;
    END IF;
    RAISE EXCEPTION 'Cannot delete journal entries (id: %, status: %). Use cancelled status instead.',
      OLD.id, OLD.status;
  END IF;

  IF OLD.status = 'draft' AND NEW.status IN ('draft', 'posted', 'cancelled') THEN
    RETURN NEW;
  END IF;

  IF OLD.status = 'posted' AND NEW.status IN ('reversed', 'cancelled') THEN
    IF NEW.status = 'reversed' THEN
      IF NEW.description != OLD.description OR NEW.entry_date != OLD.entry_date
         OR NEW.fiscal_period_id != OLD.fiscal_period_id
         OR NEW.voucher_number != OLD.voucher_number
         OR NEW.commit_method IS DISTINCT FROM OLD.commit_method
         OR NEW.rubric_version IS DISTINCT FROM OLD.rubric_version
         OR NEW.source_voucher_series IS DISTINCT FROM OLD.source_voucher_series
         OR NEW.source_voucher_number IS DISTINCT FROM OLD.source_voucher_number THEN
        RAISE EXCEPTION 'Cannot modify fields of a posted entry during reversal (id: %)', OLD.id;
      END IF;
    END IF;
    RETURN NEW;
  END IF;

  -- Narrow un-reversal path: when delete_voucher removes a storno entry,
  -- it flips the original from 'reversed' back to 'posted'. No other fields
  -- may change, and the bypass flag must be set.
  IF OLD.status = 'reversed' AND NEW.status = 'posted'
     AND current_setting('gnubok.allow_delete', true) = 'true' THEN
    IF NEW.description != OLD.description OR NEW.entry_date != OLD.entry_date
       OR NEW.fiscal_period_id != OLD.fiscal_period_id
       OR NEW.voucher_number != OLD.voucher_number THEN
      RAISE EXCEPTION 'Cannot modify fields during un-reversal (id: %)', OLD.id;
    END IF;
    RETURN NEW;
  END IF;

  -- Notes-only annotation on a committed entry (posted/reversed/cancelled).
  -- `notes` is internal metadata, not verifikation content, so editing it does
  -- not violate immutability. Allowed ONLY when the status is unchanged and the
  -- sole difference between OLD and NEW is `notes` (updated_at is exempt because
  -- the journal_entries_updated_at trigger bumps it). The to_jsonb() diff covers
  -- every other column automatically, so any real bookkeeping change still raises.
  IF OLD.status = NEW.status
     AND OLD.status IN ('posted', 'reversed', 'cancelled')
     AND (to_jsonb(NEW) - 'notes' - 'updated_at')
       = (to_jsonb(OLD) - 'notes' - 'updated_at') THEN
    RETURN NEW;
  END IF;

  -- Source-type re-tag of a mis-typed opening balance. source_type is internal
  -- classification metadata, not verifikation content (see header), so moving a
  -- bank-account IB from manual/import to opening_balance does not alter the
  -- bokföringspost. Allowed ONLY when: the transaction-local bypass flag set by
  -- mark_entry_as_opening_balance() is present; status is unchanged 'posted'; the
  -- value moves manual/import -> opening_balance; and source_type is the SOLE
  -- changed column (whole-row to_jsonb diff, updated_at exempt as above). Any other
  -- field delta, status change, or missing flag still raises below.
  IF OLD.status = NEW.status
     AND OLD.status = 'posted'
     AND current_setting('gnubok.allow_source_type_retag', true) = 'true'
     AND OLD.source_type IN ('manual', 'import')
     AND NEW.source_type = 'opening_balance'
     AND (to_jsonb(NEW) - 'source_type' - 'updated_at')
       = (to_jsonb(OLD) - 'source_type' - 'updated_at') THEN
    RETURN NEW;
  END IF;

  -- Metadata rättelse of a posted verifikation (BFL 5 kap 9 §): while the
  -- transaction-local GUC set by correct_entry_metadata() is active, permit an
  -- UPDATE iff ONLY description and/or entry_date change. The RPC has already
  -- recorded who/when in journal_entry_rattelse_log, verified the period is
  -- open/unlocked and (for date moves) that the new date stays inside the same
  -- fiscal period. Any other field delta still raises below.
  IF OLD.status = NEW.status
     AND OLD.status = 'posted'
     AND current_setting('gnubok.allow_metadata_rattelse', true) = 'true'
     AND (to_jsonb(NEW) - 'description' - 'entry_date' - 'updated_at')
       = (to_jsonb(OLD) - 'description' - 'entry_date' - 'updated_at') THEN
    RETURN NEW;
  END IF;

  -- Direct edit of a posted verifikation (frihetspaketet): while the
  -- transaction-local GUC set by edit_posted_entry() is active, permit an
  -- UPDATE iff ONLY description and/or entry_date change. The RPC verifies
  -- the period is open/unlocked and the date stays inside the fiscal period.
  IF OLD.status = NEW.status
     AND OLD.status = 'posted'
     AND current_setting('gnubok.allow_direct_edit', true) = 'true'
     AND (to_jsonb(NEW) - 'description' - 'entry_date' - 'updated_at')
       = (to_jsonb(OLD) - 'description' - 'entry_date' - 'updated_at') THEN
    RETURN NEW;
  END IF;

  RAISE EXCEPTION 'Cannot modify a % journal entry (id: %). Committed entries are immutable per Bokforingslagen.',
    OLD.status, OLD.id;
END;
$function$;

ALTER FUNCTION public.enforce_journal_entry_immutability() SET search_path = public;

-- =============================================================================
-- 2. Line-immutability carve-out: direct edit line replacement
-- =============================================================================
-- Current body verbatim (last replaced by 20260723210000) plus ONE branch:
-- while the GUC set by edit_posted_entry() is active, permit DELETE of lines
-- on a POSTED entry (full replacement; the RPC re-verifies the entry balances
-- afterwards). Line INSERT has no immutability trigger; the balance invariant
-- is enforced by the RPC.

CREATE OR REPLACE FUNCTION public.enforce_journal_entry_line_immutability()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
DECLARE v_status text;
BEGIN
  IF current_setting('gnubok.allow_delete', true) = 'true' THEN
    IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
    RETURN NEW;
  END IF;

  SELECT status INTO v_status FROM public.journal_entries
  WHERE id = COALESCE(OLD.journal_entry_id, NEW.journal_entry_id);

  -- Dimension retag carve-out (dimensions plan PR6, founder-approved):
  -- while the transaction-local GUC set by retag_line_dimensions is active,
  -- permit UPDATE of a POSTED line iff ONLY the dimension columns change —
  -- dimensions (source of truth) and its derived mirrors cost_center/project.
  -- Account, amounts, description, currency fields, sort order and entry
  -- linkage remain absolutely immutable.
  IF TG_OP = 'UPDATE'
     AND v_status = 'posted'
     AND current_setting('gnubok.allow_dimension_retag', true) = 'true'
     AND (to_jsonb(NEW) - 'dimensions' - 'cost_center' - 'project')
       = (to_jsonb(OLD) - 'dimensions' - 'cost_center' - 'project') THEN
    RETURN NEW;
  END IF;

  -- Inline rättelse carve-out (BFL 5 kap 5 §, founder-approved 2026-07-23):
  -- while the transaction-local GUC set by correct_entry_lines_inline() is
  -- active, permit DELETE of a POSTED line (a struck line). The RPC has
  -- already snapshotted the row to journal_entry_rattelse_log and verifies
  -- post-state balance before committing.
  IF TG_OP = 'DELETE'
     AND v_status = 'posted'
     AND current_setting('gnubok.allow_line_rattelse', true) = 'true' THEN
    RETURN OLD;
  END IF;

  -- Direct edit carve-out (frihetspaketet): while the transaction-local GUC
  -- set by edit_posted_entry() is active, permit DELETE of a POSTED line
  -- (full line replacement). The RPC verifies post-state balance before
  -- committing.
  IF TG_OP = 'DELETE'
     AND v_status = 'posted'
     AND current_setting('gnubok.allow_direct_edit', true) = 'true' THEN
    RETURN OLD;
  END IF;

  IF v_status = 'draft' THEN
    IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
    RETURN NEW;
  END IF;

  IF v_status = 'cancelled' THEN
    IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
    RAISE EXCEPTION 'Cannot % lines of a cancelled journal entry.', TG_OP;
  END IF;

  RAISE EXCEPTION 'Cannot % lines of a % journal entry.', TG_OP, v_status;
END; $function$;

ALTER FUNCTION public.enforce_journal_entry_line_immutability() SET search_path = public;

-- =============================================================================
-- 3. Document deletion: carve-out + retention block removed
-- =============================================================================
-- Current body from 20260330130000, minus the 7-year retention branch, plus
-- a GUC early-out for delete_document(). Deletes outside the RPC are still
-- refused when the document is linked to a posted/reversed entry, so no code
-- path deletes räkenskapsinformation by accident.

CREATE OR REPLACE FUNCTION public.block_document_deletion()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  v_entry_status text;
BEGIN
  IF current_setting('gnubok.allow_document_delete', true) = 'true' THEN
    RETURN OLD;
  END IF;

  IF OLD.journal_entry_id IS NOT NULL THEN
    SELECT je.status INTO v_entry_status
    FROM public.journal_entries je
    WHERE je.id = OLD.journal_entry_id;

    IF v_entry_status IN ('posted', 'reversed') THEN
      INSERT INTO public.audit_log (user_id, company_id, action, table_name, record_id, description)
      VALUES (OLD.user_id, OLD.company_id, 'DOCUMENT_DELETE_BLOCKED', 'document_attachments', OLD.id,
        'Attempted deletion of document linked to ' || v_entry_status || ' journal entry ' || OLD.journal_entry_id);

      RAISE EXCEPTION 'Cannot delete document linked to a % journal entry (Bokföringslagen)',
        v_entry_status;
    END IF;
  END IF;

  RETURN OLD;
END;
$$;

-- The transaction-side guard gets the same early-out so delete_document()
-- can detach a transaction from the document it is about to remove.
-- Current body verbatim from 20260506120000 (FOR SHARE race fix and the
-- BFL_DOCUMENT_IMMUTABILITY error prefix) plus the GUC branch.
CREATE OR REPLACE FUNCTION public.enforce_transactions_document_immutability()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
DECLARE
  old_doc_je_id uuid;
BEGIN
  IF current_setting('gnubok.allow_document_delete', true) = 'true' THEN
    RETURN NEW;
  END IF;

  IF NEW.document_id IS NOT DISTINCT FROM OLD.document_id THEN
    RETURN NEW;
  END IF;

  IF OLD.document_id IS NULL THEN
    RETURN NEW;
  END IF;

  -- FOR SHARE: a concurrent UPDATE that wants to set journal_entry_id on the
  -- same row will block until our transaction commits. Either we observe the
  -- categorize propagation already-committed (and raise), or we hold the
  -- share lock and the propagation observes our committed detach (which is
  -- fine because at that point document.journal_entry_id was still null when
  -- our transaction began).
  SELECT journal_entry_id
    INTO old_doc_je_id
    FROM public.document_attachments
   WHERE id = OLD.document_id
   FOR SHARE;

  IF old_doc_je_id IS NOT NULL THEN
    RAISE EXCEPTION
      'BFL_DOCUMENT_IMMUTABILITY: cannot detach or swap document % from transaction %: document is linked to journal entry % (BFL 5 kap 6 §).',
      OLD.document_id, OLD.id, old_doc_je_id;
  END IF;

  RETURN NEW;
END;
$$;

ALTER FUNCTION public.enforce_transactions_document_immutability() SET search_path = public;

-- =============================================================================
-- 4. Retention lock removed
-- =============================================================================
-- retention_expires_at and its zz_set_bfl_retention_expiry calculator stay
-- as information; only the enforcement goes.

DROP TRIGGER IF EXISTS enforce_retention_journal_entries ON public.journal_entries;
DROP FUNCTION IF EXISTS public.enforce_retention_journal_entries();

-- =============================================================================
-- 5. delete_voucher — any position in the series
-- =============================================================================
-- Replaces delete_last_voucher. Differences: no last-in-series requirement
-- (the sequence counter is only decremented when the deleted voucher held
-- the highest active number, so mid-series deletes leave a gap); cancelled
-- entries can also be deleted; p_user_id + JWT tenant guard so service-role
-- callers (MCP executors) can act for an authenticated user. Entries
-- referenced by a storno/correction still refuse: delete the referencing
-- entry first.

CREATE OR REPLACE FUNCTION public.delete_voucher(
  p_company_id uuid,
  p_entry_id   uuid,
  p_user_id    uuid DEFAULT NULL
)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_jwt_role         text := coalesce(nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'role', '');
  v_actor            uuid := COALESCE(p_user_id, auth.uid());
  v_entry            record;
  v_period           record;
  v_max_voucher      integer;
  v_ref_count        integer;
  v_caller_role      text;
  v_snapshot         jsonb;
  v_lines_snapshot   jsonb;
  v_is_period_ib     boolean := false;
  v_gap_created      boolean := false;
BEGIN
  IF v_jwt_role IN ('anon', 'authenticated') THEN
    IF NOT public.caller_is_company_member(p_company_id) THEN
      RAISE EXCEPTION 'unauthorized: caller is not a member of company %', p_company_id
        USING ERRCODE = '42501';
    END IF;
    -- A JWT caller can never act as someone else: p_user_id is only for
    -- service-role paths, which authenticate the user application-side.
    v_actor := auth.uid();
  END IF;

  SELECT cm.role INTO v_caller_role
  FROM company_members cm
  WHERE cm.company_id = p_company_id
    AND cm.user_id = v_actor;

  IF v_caller_role IS NULL OR v_caller_role NOT IN ('owner', 'admin') THEN
    RAISE EXCEPTION 'Only company owners and admins can delete vouchers';
  END IF;

  SELECT * INTO v_entry
  FROM journal_entries
  WHERE id = p_entry_id
    AND company_id = p_company_id
  FOR UPDATE;

  IF v_entry IS NULL THEN
    RAISE EXCEPTION 'Journal entry not found';
  END IF;

  IF v_entry.status NOT IN ('posted', 'draft', 'cancelled') THEN
    RAISE EXCEPTION 'Cannot delete a % entry — delete its storno first', v_entry.status;
  END IF;

  SELECT jsonb_agg(to_jsonb(l)) INTO v_lines_snapshot
  FROM journal_entry_lines l
  WHERE l.journal_entry_id = p_entry_id;

  v_snapshot := to_jsonb(v_entry) || jsonb_build_object('lines', COALESCE(v_lines_snapshot, '[]'::jsonb));

  IF v_entry.status = 'draft' THEN
    PERFORM set_config('gnubok.allow_delete', 'true', true);

    UPDATE document_attachments
    SET journal_entry_id = NULL
    WHERE journal_entry_id = p_entry_id;

    DELETE FROM journal_entries WHERE id = p_entry_id;

    INSERT INTO audit_log (user_id, company_id, action, table_name, record_id, actor_id, old_state, description)
    VALUES (
      v_entry.user_id,
      p_company_id,
      'DELETE',
      'journal_entries',
      p_entry_id,
      v_actor,
      v_snapshot,
      'Deleted draft journal entry (delete_voucher RPC, caller: ' || v_actor || ')'
    );

    RETURN jsonb_build_object(
      'deleted', true,
      'voucher_series', v_entry.voucher_series,
      'voucher_number', v_entry.voucher_number,
      'was_draft', true
    );
  END IF;

  SELECT * INTO v_period
  FROM fiscal_periods
  WHERE id = v_entry.fiscal_period_id
  FOR UPDATE;

  IF v_period.is_closed THEN
    RAISE EXCEPTION 'Cannot delete voucher in a closed fiscal period';
  END IF;

  IF v_period.locked_at IS NOT NULL THEN
    RAISE EXCEPTION 'Cannot delete voucher in a locked fiscal period';
  END IF;

  PERFORM 1 FROM voucher_sequences
  WHERE company_id = p_company_id
    AND fiscal_period_id = v_entry.fiscal_period_id
    AND voucher_series = v_entry.voucher_series
  FOR UPDATE;

  SELECT MAX(voucher_number) INTO v_max_voucher
  FROM journal_entries
  WHERE company_id = p_company_id
    AND fiscal_period_id = v_entry.fiscal_period_id
    AND voucher_series = v_entry.voucher_series
    AND status NOT IN ('cancelled', 'draft');

  SELECT COUNT(*) INTO v_ref_count
  FROM journal_entries
  WHERE company_id = p_company_id
    AND status != 'cancelled'
    AND (reverses_id = p_entry_id OR correction_of_id = p_entry_id);

  IF v_ref_count > 0 THEN
    RAISE EXCEPTION 'Cannot delete: other entries reference this voucher (% references). Delete the referencing storno/correction first.',
      v_ref_count;
  END IF;

  IF v_entry.reverses_id IS NOT NULL THEN
    PERFORM set_config('gnubok.allow_delete', 'true', true);
    UPDATE journal_entries
    SET status = 'posted', reversed_by_id = NULL
    WHERE id = v_entry.reverses_id
      AND company_id = p_company_id;
  END IF;

  v_is_period_ib := (v_period.opening_balance_entry_id = p_entry_id);
  IF v_is_period_ib THEN
    UPDATE fiscal_periods
    SET opening_balances_set = false
    WHERE id = v_entry.fiscal_period_id;

    UPDATE fiscal_periods
    SET opening_balance_entry_id = NULL
    WHERE id = v_entry.fiscal_period_id;
  END IF;

  UPDATE sie_imports
  SET opening_balance_entry_id = NULL
  WHERE opening_balance_entry_id = p_entry_id;

  PERFORM set_config('gnubok.allow_delete', 'true', true);

  UPDATE document_attachments
  SET journal_entry_id = NULL
  WHERE journal_entry_id = p_entry_id;

  DELETE FROM journal_entries WHERE id = p_entry_id;

  -- Reuse the number only when the deleted voucher was the newest active
  -- one; a mid-series delete leaves the counter alone and the gap stands.
  IF v_entry.status = 'posted' AND v_entry.voucher_number = v_max_voucher THEN
    UPDATE voucher_sequences
    SET last_number = GREATEST(last_number - 1, 0)
    WHERE company_id = p_company_id
      AND fiscal_period_id = v_entry.fiscal_period_id
      AND voucher_series = v_entry.voucher_series;
  ELSIF v_entry.status = 'posted' THEN
    v_gap_created := true;
  END IF;

  INSERT INTO audit_log (user_id, company_id, action, table_name, record_id, actor_id, old_state, description)
  VALUES (
    v_entry.user_id,
    p_company_id,
    'DELETE',
    'journal_entries',
    p_entry_id,
    v_actor,
    v_snapshot,
    'Deleted voucher ' || v_entry.voucher_series || v_entry.voucher_number ||
    CASE WHEN v_is_period_ib THEN ' (was period IB)' ELSE '' END ||
    ' (delete_voucher RPC, caller: ' || v_actor || ')'
  );

  RETURN jsonb_build_object(
    'deleted', true,
    'voucher_series', v_entry.voucher_series,
    'voucher_number', v_entry.voucher_number,
    'was_period_ib', v_is_period_ib,
    'gap_created', v_gap_created
  );
END;
$function$;

REVOKE ALL ON FUNCTION public.delete_voucher(uuid, uuid, uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.delete_voucher(uuid, uuid, uuid) TO authenticated, service_role;

DROP FUNCTION IF EXISTS public.delete_last_voucher(uuid, uuid);

-- =============================================================================
-- 6. edit_posted_entry — direct edit without the rättelse ceremony
-- =============================================================================
-- Edits description/entry_date (within the fiscal period) and/or replaces
-- the full line set of a posted entry. No rättelse log, no badges: the
-- generic write_audit_log trigger still records every row change. The same
-- envelope as the inline-rättelse RPCs applies: posted entries only, open
-- unlocked periods, company lock date honored, structural entry types
-- excluded, SEK only, balance re-verified from the table post-write.
-- Cross-period date moves keep using the recordate flow (voucher numbering
-- is per period).

CREATE OR REPLACE FUNCTION public.edit_posted_entry(
  p_company_id  uuid,
  p_entry_id    uuid,
  p_description text DEFAULT NULL,
  p_entry_date  date DEFAULT NULL,
  p_lines       jsonb DEFAULT NULL,
  p_user_id     uuid DEFAULT NULL
)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_jwt_role      text := coalesce(nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'role', '');
  v_actor         uuid := COALESCE(p_user_id, auth.uid());
  v_caller_role   text;
  v_entry         record;
  v_is_closed     boolean;
  v_locked_at     timestamptz;
  v_p_start       date;
  v_p_end         date;
  v_lock_date     date;
  v_new_desc      text;
  v_new_date      date;
  v_line          jsonb;
  v_acc           text;
  v_debit         numeric;
  v_credit        numeric;
  v_new_count     int := 0;
  v_new_debit     numeric := 0;
  v_new_credit    numeric := 0;
  v_sort          int := 0;
  v_fin_debit     numeric;
  v_fin_credit    numeric;
  v_fin_count     int;
  v_meta_changed  boolean := false;
  v_lines_changed boolean := false;
BEGIN
  IF v_jwt_role IN ('anon', 'authenticated') THEN
    IF NOT public.caller_is_company_member(p_company_id) THEN
      RAISE EXCEPTION 'unauthorized: caller is not a member of company %', p_company_id
        USING ERRCODE = '42501';
    END IF;
    -- A JWT caller can never act as someone else: p_user_id is only for
    -- service-role paths, which authenticate the user application-side.
    v_actor := auth.uid();
  END IF;

  SELECT cm.role INTO v_caller_role
  FROM company_members cm
  WHERE cm.company_id = p_company_id AND cm.user_id = v_actor;

  IF v_caller_role IS NULL OR v_caller_role NOT IN ('owner', 'admin', 'member') THEN
    RAISE EXCEPTION 'Endast användare med skrivbehörighet kan redigera verifikat.';
  END IF;

  SELECT je.id, je.status, je.description, je.entry_date, je.source_type,
         je.fiscal_period_id, je.company_id AS entry_company_id
    INTO v_entry
    FROM public.journal_entries je
   WHERE je.id = p_entry_id
     FOR UPDATE OF je;

  IF NOT FOUND OR v_entry.entry_company_id <> p_company_id THEN
    RAISE EXCEPTION 'Verifikationen hittades inte.';
  END IF;

  IF v_entry.status <> 'posted' THEN
    RAISE EXCEPTION 'Endast bokförda verifikat kan redigeras direkt (utkast redigeras i formuläret).';
  END IF;

  -- Structural entry types keep their dedicated flows: a storno mirrors its
  -- original, an IB feeds opening_balance_entry_id, year-end vouchers feed
  -- dispositions/idempotency checks, a vat_settlement is looked up by date.
  IF v_entry.source_type IN ('storno', 'opening_balance', 'year_end', 'vat_settlement') THEN
    RAISE EXCEPTION 'Den här verifikationstypen kan inte redigeras direkt — använd dess egen funktion.';
  END IF;

  v_new_desc := COALESCE(NULLIF(btrim(p_description), ''), v_entry.description);
  v_new_date := COALESCE(p_entry_date, v_entry.entry_date);

  IF length(v_new_desc) > 500 THEN
    RAISE EXCEPTION 'Beskrivningen får vara högst 500 tecken.';
  END IF;

  SELECT fp.is_closed, fp.locked_at, fp.period_start, fp.period_end
    INTO v_is_closed, v_locked_at, v_p_start, v_p_end
    FROM public.fiscal_periods fp
   WHERE fp.id = v_entry.fiscal_period_id;

  IF v_is_closed OR v_locked_at IS NOT NULL THEN
    RAISE EXCEPTION 'Perioden är stängd eller låst.';
  END IF;

  -- Voucher numbering is per fiscal period: cross-period moves change period
  -- sums and numbering and stay on the recordate flow.
  IF v_new_date <> v_entry.entry_date
     AND (v_new_date < v_p_start OR v_new_date > v_p_end) THEN
    RAISE EXCEPTION 'Nytt datum måste ligga inom samma bokföringsperiod (% – %). Använd "Flytta till annat datum" för att byta period.', v_p_start, v_p_end;
  END IF;

  SELECT cs.bookkeeping_locked_through INTO v_lock_date
    FROM public.company_settings cs
   WHERE cs.company_id = p_company_id;

  IF v_lock_date IS NOT NULL
     AND (v_entry.entry_date <= v_lock_date OR v_new_date <= v_lock_date) THEN
    RAISE EXCEPTION 'Bokföringen är låst t.o.m. %.', v_lock_date;
  END IF;

  IF p_lines IS NOT NULL THEN
    IF jsonb_typeof(p_lines) <> 'array' THEN
      RAISE EXCEPTION 'Rader måste vara en lista.';
    END IF;

    IF jsonb_array_length(p_lines) < 2 THEN
      RAISE EXCEPTION 'Verifikationen måste ha minst två rader.';
    END IF;

    IF jsonb_array_length(p_lines) > 100 THEN
      RAISE EXCEPTION 'Högst 100 rader per verifikation.';
    END IF;

    -- Full replacement severs line-level underlag couplings
    -- (document_attachments.journal_entry_line_id is ON DELETE RESTRICT).
    IF EXISTS (
      SELECT 1 FROM public.document_attachments da
        JOIN public.journal_entry_lines jel ON jel.id = da.journal_entry_line_id
       WHERE jel.journal_entry_id = p_entry_id
    ) THEN
      RAISE EXCEPTION 'En rad har ett underlag kopplat på radnivå — radera underlaget först eller använd rättelseflödet.';
    END IF;

    -- Foreign-currency lines carry conversion data (amount_in_currency /
    -- exchange_rate) that replacement lines cannot reproduce.
    IF EXISTS (
      SELECT 1 FROM public.journal_entry_lines jel
       WHERE jel.journal_entry_id = p_entry_id
         AND jel.currency IS NOT NULL AND jel.currency <> 'SEK'
    ) THEN
      RAISE EXCEPTION 'Verifikat med rader i utländsk valuta kan inte redigeras direkt — använd rättelseverifikat (storno).';
    END IF;

    FOR v_line IN SELECT * FROM jsonb_array_elements(p_lines)
    LOOP
      v_acc    := btrim(COALESCE(v_line ->> 'account_number', ''));
      v_debit  := round(COALESCE((v_line ->> 'debit_amount')::numeric, 0), 2);
      v_credit := round(COALESCE((v_line ->> 'credit_amount')::numeric, 0), 2);

      IF v_acc !~ '^[0-9]{4}$' THEN
        RAISE EXCEPTION 'Ogiltigt kontonummer: "%".', v_acc;
      END IF;
      IF NOT EXISTS (
        SELECT 1 FROM public.chart_of_accounts coa
         WHERE coa.company_id = p_company_id AND coa.account_number = v_acc
      ) THEN
        RAISE EXCEPTION 'Kontot % finns inte i kontoplanen.', v_acc;
      END IF;
      IF v_debit < 0 OR v_credit < 0 THEN
        RAISE EXCEPTION 'Belopp kan inte vara negativa (konto %).', v_acc;
      END IF;
      IF v_debit > 0 AND v_credit > 0 THEN
        RAISE EXCEPTION 'En rad kan inte ha både debet och kredit (konto %).', v_acc;
      END IF;
      IF v_debit = 0 AND v_credit = 0 THEN
        RAISE EXCEPTION 'En rad måste ha ett belopp (konto %).', v_acc;
      END IF;

      v_new_count  := v_new_count + 1;
      v_new_debit  := v_new_debit + v_debit;
      v_new_credit := v_new_credit + v_credit;
    END LOOP;

    IF abs(v_new_debit - v_new_credit) >= 0.005 THEN
      RAISE EXCEPTION 'Verifikationen balanserar inte (debet %, kredit %).',
        round(v_new_debit, 2), round(v_new_credit, 2);
    END IF;

    IF v_new_debit < 0.005 THEN
      RAISE EXCEPTION 'Verifikationen kan inte vara noll — radera den i stället.';
    END IF;
  END IF;

  v_meta_changed  := (v_new_desc <> v_entry.description OR v_new_date <> v_entry.entry_date);
  v_lines_changed := (p_lines IS NOT NULL);

  IF NOT v_meta_changed AND NOT v_lines_changed THEN
    RETURN jsonb_build_object('changed', false);
  END IF;

  PERFORM set_config('gnubok.allow_direct_edit', 'true', true);

  IF v_meta_changed THEN
    UPDATE public.journal_entries
       SET description = v_new_desc,
           entry_date  = v_new_date
     WHERE id = p_entry_id;
  END IF;

  IF v_lines_changed THEN
    DELETE FROM public.journal_entry_lines
     WHERE journal_entry_id = p_entry_id;

    FOR v_line IN SELECT * FROM jsonb_array_elements(p_lines)
    LOOP
      v_sort := v_sort + 1;
      -- cost_center/project are GENERATED columns derived from dimensions:
      -- never inserted explicitly, they recompute from the bag.
      INSERT INTO public.journal_entry_lines
        (journal_entry_id, account_number, account_id, debit_amount, credit_amount,
         line_description, sort_order, dimensions, currency)
      VALUES
        (p_entry_id,
         btrim(v_line ->> 'account_number'),
         (SELECT coa.id FROM public.chart_of_accounts coa
           WHERE coa.company_id = p_company_id
             AND coa.account_number = btrim(v_line ->> 'account_number')
           ORDER BY (coa.is_active IS TRUE) DESC, coa.created_at
           LIMIT 1),
         round(COALESCE((v_line ->> 'debit_amount')::numeric, 0), 2),
         round(COALESCE((v_line ->> 'credit_amount')::numeric, 0), 2),
         NULLIF(btrim(COALESCE(v_line ->> 'line_description', '')), ''),
         v_sort,
         COALESCE(v_line -> 'dimensions', '{}'::jsonb),
         'SEK');
    END LOOP;
  END IF;

  PERFORM set_config('gnubok.allow_direct_edit', 'false', true);

  -- Authoritative post-state verification straight from the table: the entry
  -- must still balance to the öre and hold at least two lines, or everything
  -- rolls back.
  SELECT COALESCE(sum(jel.debit_amount), 0), COALESCE(sum(jel.credit_amount), 0), count(*)
    INTO v_fin_debit, v_fin_credit, v_fin_count
    FROM public.journal_entry_lines jel
   WHERE jel.journal_entry_id = p_entry_id;

  IF abs(v_fin_debit - v_fin_credit) >= 0.005 OR v_fin_count < 2 OR v_fin_debit < 0.005 THEN
    RAISE EXCEPTION 'Internt fel: verifikationen balanserar inte efter redigeringen — ändringen har återställts.';
  END IF;

  -- Close the check-then-write window on period locks: if a lock or close
  -- committed while this edit was running, abort and roll back rather than
  -- write into a period that is now locked.
  SELECT fp.is_closed, fp.locked_at INTO v_is_closed, v_locked_at
    FROM public.fiscal_periods fp
   WHERE fp.id = v_entry.fiscal_period_id;
  IF v_is_closed OR v_locked_at IS NOT NULL THEN
    RAISE EXCEPTION 'Perioden är stängd eller låst.';
  END IF;

  RETURN jsonb_build_object(
    'changed', true,
    'description', v_new_desc,
    'entry_date', v_new_date,
    'line_count', v_fin_count,
    'total_debit', round(v_fin_debit, 2),
    'total_credit', round(v_fin_credit, 2)
  );
END;
$function$;

REVOKE ALL ON FUNCTION public.edit_posted_entry(uuid, uuid, text, date, jsonb, uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.edit_posted_entry(uuid, uuid, text, date, jsonb, uuid) TO authenticated, service_role;

-- =============================================================================
-- 7. delete_document — documents can go even when linked
-- =============================================================================
-- The one write path for document deletion. Detaches any transaction first
-- (the FK is ON DELETE RESTRICT), then removes the row; the caller removes
-- the storage objects service-side. Delivery evidence for sent invoices
-- stays undeletable.

CREATE OR REPLACE FUNCTION public.delete_document(
  p_company_id  uuid,
  p_document_id uuid,
  p_user_id     uuid DEFAULT NULL
)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_jwt_role    text := coalesce(nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'role', '');
  v_actor       uuid := COALESCE(p_user_id, auth.uid());
  v_caller_role text;
  v_doc         record;
BEGIN
  IF v_jwt_role IN ('anon', 'authenticated') THEN
    IF NOT public.caller_is_company_member(p_company_id) THEN
      RAISE EXCEPTION 'unauthorized: caller is not a member of company %', p_company_id
        USING ERRCODE = '42501';
    END IF;
    -- A JWT caller can never act as someone else: p_user_id is only for
    -- service-role paths, which authenticate the user application-side.
    v_actor := auth.uid();
  END IF;

  SELECT cm.role INTO v_caller_role
  FROM company_members cm
  WHERE cm.company_id = p_company_id AND cm.user_id = v_actor;

  IF v_caller_role IS NULL OR v_caller_role NOT IN ('owner', 'admin', 'member') THEN
    RAISE EXCEPTION 'Endast användare med skrivbehörighet kan radera underlag.';
  END IF;

  SELECT * INTO v_doc
    FROM public.document_attachments
   WHERE id = p_document_id
     AND company_id = p_company_id
   FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Dokumentet hittades inte.';
  END IF;

  IF EXISTS (
    SELECT 1 FROM public.invoice_deliveries d
     WHERE d.document_attachment_id = p_document_id
  ) THEN
    RAISE EXCEPTION 'Dokumentet är leveransbevis för en skickad faktura och kan inte raderas.';
  END IF;

  PERFORM set_config('gnubok.allow_document_delete', 'true', true);

  UPDATE public.transactions
     SET document_id = NULL
   WHERE document_id = p_document_id;

  DELETE FROM public.document_attachments WHERE id = p_document_id;

  PERFORM set_config('gnubok.allow_document_delete', 'false', true);

  INSERT INTO public.audit_log (user_id, company_id, action, table_name, record_id, actor_id, old_state, description)
  VALUES (
    v_doc.user_id,
    p_company_id,
    'DELETE',
    'document_attachments',
    p_document_id,
    v_actor,
    to_jsonb(v_doc),
    'Deleted document ' || COALESCE(v_doc.file_name, '?') ||
    CASE WHEN v_doc.journal_entry_id IS NOT NULL THEN ' (was linked to journal entry ' || v_doc.journal_entry_id || ')' ELSE '' END ||
    ' (delete_document RPC, caller: ' || v_actor || ')'
  );

  RETURN jsonb_build_object(
    'deleted', true,
    'storage_path', v_doc.storage_path,
    'file_name', v_doc.file_name,
    'was_linked', v_doc.journal_entry_id IS NOT NULL
  );
END;
$function$;

REVOKE ALL ON FUNCTION public.delete_document(uuid, uuid, uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.delete_document(uuid, uuid, uuid) TO authenticated, service_role;

-- =============================================================================
-- 8. Pending-operation types for the MCP tools
-- =============================================================================
-- Re-created wholesale: every value from 20260807093856 plus delete_voucher,
-- edit_posted_entry and delete_document.

ALTER TABLE public.pending_operations
  DROP CONSTRAINT IF EXISTS pending_operations_operation_type_check;

ALTER TABLE public.pending_operations
  ADD CONSTRAINT pending_operations_operation_type_check
  CHECK (operation_type IN (
    'categorize_transaction',
    'create_customer',
    'create_invoice',
    'mark_invoice_paid',
    'send_invoice',
    'mark_invoice_sent',
    'match_transaction_invoice',
    'close_period',
    'lock_period',
    'unlock_period',
    'set_opening_balances',
    'run_year_end',
    'run_currency_revaluation',
    'import_sie',
    'explain_voucher_gap',
    'uncategorize_transaction',
    'approve_supplier_invoice',
    'credit_supplier_invoice',
    'credit_invoice',
    'convert_invoice',
    'create_transaction',
    'attach_document_to_transaction',
    'create_voucher',
    'correct_entry',
    'reverse_entry',
    'create_supplier',
    'create_supplier_invoice_from_inbox',
    'post_annual_depreciation',
    'link_invoice_voucher',
    'undo_sie_import',
    'match_batch_allocate',
    'bulk_book_transactions',
    'create_salary_run',
    'generate_agi',
    'link_transaction_journal_entry',
    'link_supplier_invoice_voucher',
    'submit_vat_declaration',
    'submit_agi',
    'create_article',
    'update_article',
    'bulk_book_inbox_items',
    'create_dimension_value',
    'retag_line_dimensions',
    'link_document_to_voucher',
    'update_payslip_line',
    'register_absence',
    'create_employee',
    'update_employee',
    'set_employee_opening_balances',
    'vacation_year_close',
    'create_account',
    'update_account',
    'set_voucher_note',
    'book_salary_run',
    'delete_absence',
    'update_company_settings',
    'update_customer',
    'update_invoice',
    'create_recurring_schedule',
    'update_recurring_schedule',
    'log_mileage_trip',
    'book_mileage_period',
    'delete_voucher',
    'edit_posted_entry',
    'delete_document'
  )) NOT VALID;

ALTER TABLE public.pending_operations
  VALIDATE CONSTRAINT pending_operations_operation_type_check;

NOTIFY pgrst, 'reload schema';
