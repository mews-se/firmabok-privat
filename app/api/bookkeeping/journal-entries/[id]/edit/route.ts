import { NextResponse } from 'next/server'
import { withRouteContext } from '@/lib/api/with-route-context'
import { validateBody } from '@/lib/api/validate'
import { EditPostedEntrySchema } from '@/lib/api/schemas'
import { getErrorMessage } from '@/lib/errors/get-error-message'
import { backfillStandardBASAccounts } from '@/lib/bookkeeping/account-backfill'

/**
 * POST /api/bookkeeping/journal-entries/[id]/edit
 *
 * Direct edit of a POSTED verifikat: header and/or full line replacement
 * without a rättelseverifikation or rättelse log. The edit_posted_entry RPC
 * enforces the envelope (posted status, open/unlocked period, company lock
 * date, same-period date, balance to the öre, ≥2 lines, writer role); the
 * generic audit_log trigger still records every row change. Storno and
 * inline rättelse remain the traceable alternatives.
 */
export const POST = withRouteContext<{ params: Promise<{ id: string }> }>(
  'bookkeeping.journal_entry.edit',
  async (request, { supabase, companyId, user, log }, { params }) => {
    const { id } = await params

    const validation = await validateBody(request, EditPostedEntrySchema)
    if (!validation.success) return validation.response

    const { description, entry_date, lines } = validation.data

    // Seed standard BAS accounts the replacement lines reference but the
    // company chart lacks (same courtesy as the engine/storno flow); unknown
    // numbers stay missing and fail the RPC's chart check with a clear error.
    if (lines && lines.length > 0) {
      const accountNumbers = [...new Set(lines.map((l) => l.account_number))]
      await backfillStandardBASAccounts(supabase, companyId, user.id, accountNumbers)
    }

    const { data, error } = await supabase.rpc('edit_posted_entry', {
      p_company_id: companyId,
      p_entry_id: id,
      p_description: description ?? null,
      p_entry_date: entry_date ?? null,
      p_lines: lines
        ? lines.map((l) => ({
            account_number: l.account_number,
            debit_amount: l.debit_amount,
            credit_amount: l.credit_amount,
            line_description: l.line_description ?? null,
            dimensions: l.dimensions ?? {},
          }))
        : null,
      p_user_id: user.id,
    })

    if (error) {
      // Rule violations are plain RAISE EXCEPTION (P0001) with user-facing
      // Swedish messages: surface verbatim as 409. Tenant guard raises 42501.
      if (error.code === 'P0001') {
        return NextResponse.json({ error: getErrorMessage(error) }, { status: 409 })
      }
      if (error.code === '42501') {
        return NextResponse.json({ error: getErrorMessage(error) }, { status: 403 })
      }
      // Defensive: the RPC pre-checks line-level document links, but if the
      // RESTRICT FK still fires (racing attachment), surface the same guidance.
      if (error.code === '23503') {
        return NextResponse.json(
          { error: 'En rad har ett underlag kopplat på radnivå — radera underlaget först eller använd rättelseflödet.' },
          { status: 409 },
        )
      }
      log.error('edit_posted_entry failed', new Error(error.message), { entryId: id })
      return NextResponse.json({ error: 'Kunde inte redigera verifikationen' }, { status: 500 })
    }

    return NextResponse.json({ data })
  },
  { requireWrite: true },
)
