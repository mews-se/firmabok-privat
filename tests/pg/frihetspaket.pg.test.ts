/**
 * Frihetspaketet (migration 20260809210000): direct edit of posted entries,
 * document deletion, retention lock removal.
 *
 * The carve-outs must stay narrow: everything here also pins that the
 * GUC-less paths still refuse, that period locks hold, and that the tenant
 * guard cannot be sidestepped via p_user_id.
 */
import { randomUUID } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { getPool, withUserContext } from '@/tests/pg/setup'
import {
  insertAuthUser,
  insertBalancedLines,
  insertCompanyMember,
  insertTransaction,
  seedCompany,
} from '@/tests/pg/fixtures'

async function insertPostedEntryWithLines(params: {
  userId: string
  companyId: string
  fiscalPeriodId: string
  voucherNumber: number
  sourceType?: string
}): Promise<string> {
  const id = randomUUID()
  await getPool().query(
    `INSERT INTO public.journal_entries
       (id, user_id, company_id, fiscal_period_id, voucher_number, voucher_series,
        entry_date, description, source_type, status)
     VALUES ($1, $2, $3, $4, $5, 'A', '2026-06-01', 'Originaltext', $6, 'draft')`,
    [
      id,
      params.userId,
      params.companyId,
      params.fiscalPeriodId,
      params.voucherNumber,
      params.sourceType ?? 'manual',
    ],
  )
  await insertBalancedLines(id)
  await getPool().query(
    `UPDATE public.journal_entries SET status = 'posted' WHERE id = $1`,
    [id],
  )
  return id
}

async function insertChartAccount(companyId: string, userId: string, accountNumber: string): Promise<void> {
  await getPool().query(
    `INSERT INTO public.chart_of_accounts
       (user_id, company_id, account_number, account_name, account_class, account_type, normal_balance)
     VALUES ($1, $2, $3, 'Testkonto ' || $3, left($3, 1)::int, 'expense', 'debit')
     ON CONFLICT DO NOTHING`,
    [userId, companyId, accountNumber],
  )
}

async function insertLinkedDocument(params: {
  userId: string
  companyId: string
  journalEntryId?: string | null
}): Promise<string> {
  const id = randomUUID()
  await getPool().query(
    `INSERT INTO public.document_attachments
       (id, user_id, company_id, storage_path, file_name, file_size_bytes,
        mime_type, sha256_hash, journal_entry_id)
     VALUES ($1, $2, $3, $4, 'underlag.pdf', 1024, 'application/pdf', $5, $6)`,
    [
      id,
      params.userId,
      params.companyId,
      `documents/${params.userId}/${id}.pdf`,
      'a'.repeat(64),
      params.journalEntryId ?? null,
    ],
  )
  return id
}

describe('frihetspaket.pg: edit_posted_entry', () => {
  it('still blocks a GUC-less direct UPDATE of a posted entry', async () => {
    const { userId, companyId, fiscalPeriodId } = await seedCompany()
    const entryId = await insertPostedEntryWithLines({
      userId, companyId, fiscalPeriodId, voucherNumber: 1,
    })

    await expect(
      getPool().query(
        `UPDATE public.journal_entries SET description = 'tampered' WHERE id = $1`,
        [entryId],
      ),
    ).rejects.toThrow(/Cannot modify a posted journal entry/i)
  })

  it('edits header and replaces the full line set in one call', async () => {
    const { userId, companyId, fiscalPeriodId } = await seedCompany()
    const entryId = await insertPostedEntryWithLines({
      userId, companyId, fiscalPeriodId, voucherNumber: 1,
    })
    await insertChartAccount(companyId, userId, '1930')
    await insertChartAccount(companyId, userId, '6110')

    await withUserContext(userId, async (client) => {
      const r = await client.query<{ edit_posted_entry: {
        changed: boolean
        line_count: number
        total_debit: number
        total_credit: number
      } }>(
        `SELECT public.edit_posted_entry($1::uuid, $2::uuid, $3, $4::date, $5::jsonb)`,
        [
          companyId,
          entryId,
          'Rättad text',
          '2026-06-15',
          JSON.stringify([
            { account_number: '6110', debit_amount: 250, credit_amount: 0 },
            { account_number: '1930', debit_amount: 0, credit_amount: 250 },
          ]),
        ],
      )
      const result = r.rows[0]!.edit_posted_entry
      expect(result.changed).toBe(true)
      expect(result.line_count).toBe(2)
      expect(Number(result.total_debit)).toBe(250)

      const after = await client.query<{ description: string; entry_date: string; status: string }>(
        `SELECT description, entry_date::text, status FROM public.journal_entries WHERE id = $1`,
        [entryId],
      )
      expect(after.rows[0]!.description).toBe('Rättad text')
      expect(after.rows[0]!.entry_date).toBe('2026-06-15')
      expect(after.rows[0]!.status).toBe('posted')

      const lines = await client.query<{ account_number: string }>(
        `SELECT account_number FROM public.journal_entry_lines
          WHERE journal_entry_id = $1 ORDER BY sort_order`,
        [entryId],
      )
      expect(lines.rows.map((l) => l.account_number)).toEqual(['6110', '1930'])
    })
  })

  it('rejects an unbalanced replacement line set', async () => {
    const { userId, companyId, fiscalPeriodId } = await seedCompany()
    const entryId = await insertPostedEntryWithLines({
      userId, companyId, fiscalPeriodId, voucherNumber: 1,
    })
    await insertChartAccount(companyId, userId, '1930')
    await insertChartAccount(companyId, userId, '6110')

    await withUserContext(userId, async (client) => {
      await expect(
        client.query(
          `SELECT public.edit_posted_entry($1::uuid, $2::uuid, NULL, NULL, $3::jsonb)`,
          [
            companyId,
            entryId,
            JSON.stringify([
              { account_number: '6110', debit_amount: 250, credit_amount: 0 },
              { account_number: '1930', debit_amount: 0, credit_amount: 100 },
            ]),
          ],
        ),
      ).rejects.toThrow(/balanserar inte/i)
    })
  })

  it('rejects a date outside the fiscal period', async () => {
    const { userId, companyId, fiscalPeriodId } = await seedCompany()
    const entryId = await insertPostedEntryWithLines({
      userId, companyId, fiscalPeriodId, voucherNumber: 1,
    })

    await withUserContext(userId, async (client) => {
      await expect(
        client.query(
          `SELECT public.edit_posted_entry($1::uuid, $2::uuid, NULL, '2035-01-01'::date, NULL)`,
          [companyId, entryId],
        ),
      ).rejects.toThrow(/inom samma bokföringsperiod/i)
    })
  })

  it('refuses in a locked period', async () => {
    const { userId, companyId, fiscalPeriodId } = await seedCompany()
    const entryId = await insertPostedEntryWithLines({
      userId, companyId, fiscalPeriodId, voucherNumber: 1,
    })
    await getPool().query(
      `UPDATE public.fiscal_periods SET locked_at = now() WHERE id = $1`,
      [fiscalPeriodId],
    )

    await withUserContext(userId, async (client) => {
      await expect(
        client.query(
          `SELECT public.edit_posted_entry($1::uuid, $2::uuid, 'Nytt', NULL, NULL)`,
          [companyId, entryId],
        ),
      ).rejects.toThrow(/stängd eller låst/i)
    })
  })

  it('ignores a spoofed p_user_id from a JWT caller', async () => {
    const { userId, companyId, fiscalPeriodId } = await seedCompany()
    const entryId = await insertPostedEntryWithLines({
      userId, companyId, fiscalPeriodId, voucherNumber: 1,
    })
    const outsider = await insertAuthUser()

    // The outsider passes the owner's id as p_user_id: the tenant guard must
    // evaluate the JWT identity, not the parameter.
    await withUserContext(outsider, async (client) => {
      await expect(
        client.query(
          `SELECT public.edit_posted_entry($1::uuid, $2::uuid, 'Kapat', NULL, NULL, $3::uuid)`,
          [companyId, entryId, userId],
        ),
      ).rejects.toThrow(/unauthorized/i)
    })
  })

  it('refuses structural entry types', async () => {
    const { userId, companyId, fiscalPeriodId } = await seedCompany()
    const entryId = await insertPostedEntryWithLines({
      userId, companyId, fiscalPeriodId, voucherNumber: 1, sourceType: 'year_end',
    })

    await withUserContext(userId, async (client) => {
      await expect(
        client.query(
          `SELECT public.edit_posted_entry($1::uuid, $2::uuid, 'Nytt', NULL, NULL)`,
          [companyId, entryId],
        ),
      ).rejects.toThrow(/kan inte redigeras direkt/i)
    })
  })
})

describe('frihetspaket.pg: delete_document', () => {
  it('deletes a voucher-linked document and detaches its transaction', async () => {
    const { userId, companyId, fiscalPeriodId } = await seedCompany()
    const entryId = await insertPostedEntryWithLines({
      userId, companyId, fiscalPeriodId, voucherNumber: 1,
    })
    const docId = await insertLinkedDocument({ userId, companyId, journalEntryId: entryId })
    const txId = await insertTransaction({ companyId, userId })
    await getPool().query(
      `UPDATE public.transactions SET document_id = $1 WHERE id = $2`,
      [docId, txId],
    )

    await withUserContext(userId, async (client) => {
      const r = await client.query<{ delete_document: {
        deleted: boolean
        was_linked: boolean
        storage_path: string
      } }>(
        `SELECT public.delete_document($1::uuid, $2::uuid)`,
        [companyId, docId],
      )
      expect(r.rows[0]!.delete_document.deleted).toBe(true)
      expect(r.rows[0]!.delete_document.was_linked).toBe(true)
      expect(r.rows[0]!.delete_document.storage_path).toContain(docId)

      const docAfter = await client.query(
        `SELECT 1 FROM public.document_attachments WHERE id = $1`,
        [docId],
      )
      expect(docAfter.rowCount).toBe(0)

      const txAfter = await client.query<{ document_id: string | null }>(
        `SELECT document_id FROM public.transactions WHERE id = $1`,
        [txId],
      )
      expect(txAfter.rows[0]!.document_id).toBeNull()

      // The generic write_audit_log trigger adds its own DELETE row; pin the
      // RPC's explicit provenance row specifically.
      const audit = await client.query(
        `SELECT 1 FROM public.audit_log
          WHERE table_name = 'document_attachments' AND record_id = $1
            AND action = 'DELETE' AND description LIKE '%delete_document RPC%'`,
        [docId],
      )
      expect(audit.rowCount).toBe(1)
    })
  })

  it('still blocks a GUC-less direct DELETE of a linked document', async () => {
    const { userId, companyId, fiscalPeriodId } = await seedCompany()
    const entryId = await insertPostedEntryWithLines({
      userId, companyId, fiscalPeriodId, voucherNumber: 1,
    })
    const docId = await insertLinkedDocument({ userId, companyId, journalEntryId: entryId })

    await expect(
      getPool().query(`DELETE FROM public.document_attachments WHERE id = $1`, [docId]),
    ).rejects.toThrow(/Bokföringslagen/i)
  })

  it('refuses for a non-member', async () => {
    const { userId, companyId, fiscalPeriodId } = await seedCompany()
    const entryId = await insertPostedEntryWithLines({
      userId, companyId, fiscalPeriodId, voucherNumber: 1,
    })
    const docId = await insertLinkedDocument({ userId, companyId, journalEntryId: entryId })
    const outsider = await insertAuthUser()

    await withUserContext(outsider, async (client) => {
      await expect(
        client.query(`SELECT public.delete_document($1::uuid, $2::uuid)`, [companyId, docId]),
      ).rejects.toThrow(/unauthorized/i)
    })
  })

  it('refuses for a viewer role', async () => {
    const { userId, companyId, fiscalPeriodId } = await seedCompany()
    const entryId = await insertPostedEntryWithLines({
      userId, companyId, fiscalPeriodId, voucherNumber: 1,
    })
    const docId = await insertLinkedDocument({ userId, companyId, journalEntryId: entryId })
    const viewer = await insertAuthUser()
    await insertCompanyMember({ companyId, userId: viewer, role: 'viewer' })

    await withUserContext(viewer, async (client) => {
      await expect(
        client.query(`SELECT public.delete_document($1::uuid, $2::uuid)`, [companyId, docId]),
      ).rejects.toThrow(/skrivbehörighet/i)
    })
  })
})

describe('frihetspaket.pg: retention lock removed', () => {
  it('has dropped the enforce_retention_journal_entries trigger', async () => {
    const r = await getPool().query(
      `SELECT 1 FROM pg_trigger
        WHERE tgname = 'enforce_retention_journal_entries'
          AND tgrelid = 'public.journal_entries'::regclass`,
    )
    expect(r.rowCount).toBe(0)
  })

  it('keeps the retention_expires_at calculator as information', async () => {
    const r = await getPool().query(
      `SELECT 1 FROM pg_trigger
        WHERE tgname = 'zz_set_bfl_retention_expiry'
          AND tgrelid = 'public.fiscal_periods'::regclass`,
    )
    expect(r.rowCount).toBe(1)
  })
})
