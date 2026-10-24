/**
 * Tests for POST /api/bookkeeping/journal-entries/[id]/edit
 * (direct edit of a posted verifikat via the edit_posted_entry RPC).
 *
 * Covers: 401, validation 400 (empty body / bad account / too few lines),
 * rule-violation 409 passthrough (Swedish RPC messages verbatim), tenant
 * guard 403, unexpected RPC failure 500, the happy path (incl. BAS account
 * backfill before the RPC) and the header-only path (no backfill).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { NextResponse } from 'next/server'
import {
  createQueuedMockSupabase,
  createMockRequest,
  createMockRouteParams,
  parseJsonResponse,
} from '@/tests/helpers'

const { supabase, reset } = createQueuedMockSupabase()

const rpcMock = vi.fn()
;(supabase as { rpc?: unknown }).rpc = rpcMock

const backfillMock = vi.fn().mockResolvedValue([])
vi.mock('@/lib/bookkeeping/account-backfill', () => ({
  backfillStandardBASAccounts: (...args: unknown[]) => backfillMock(...args),
}))

const requireAuthMock = vi.fn()
vi.mock('@/lib/auth/require-auth', () => ({
  requireAuth: (...args: unknown[]) => requireAuthMock(...args),
}))

vi.mock('@/lib/company/context', () => ({
  getActiveCompanyId: vi.fn().mockResolvedValue('company-1'),
  requireCompanyId: vi.fn().mockResolvedValue('company-1'),
}))

vi.mock('@/lib/auth/require-write', () => ({
  requireWritePermission: vi.fn().mockResolvedValue({ ok: true }),
}))

vi.mock('@/lib/init', () => ({ ensureInitialized: vi.fn() }))

import { POST } from '../route'

const params = () => createMockRouteParams({ id: 'entry-1' })

function makeRequest(body: unknown) {
  return createMockRequest('/api/bookkeeping/journal-entries/entry-1/edit', {
    method: 'POST',
    body,
  })
}

const balancedLines = [
  { account_number: '1930', credit_amount: 500 },
  { account_number: '6110', debit_amount: 500 },
]

describe('POST /api/bookkeeping/journal-entries/[id]/edit', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    reset()
    backfillMock.mockResolvedValue([])
    requireAuthMock.mockResolvedValue({ user: { id: 'user-1' }, supabase })
  })

  it('returns 401 when not authenticated', async () => {
    requireAuthMock.mockResolvedValue({
      error: NextResponse.json({ error: 'Unauthorized' }, { status: 401 }),
    })

    const response = await POST(makeRequest({ description: 'x' }), params())
    expect(response.status).toBe(401)
    expect(rpcMock).not.toHaveBeenCalled()
  })

  it.each([
    ['empty body', {}],
    ['bad account number', { lines: [{ account_number: '19', debit_amount: 100 }, { account_number: '6110', credit_amount: 100 }] }],
    ['single line', { lines: [{ account_number: '1930', debit_amount: 100 }] }],
    ['negative amount', { lines: [{ account_number: '1930', debit_amount: -5 }, { account_number: '6110', credit_amount: 5 }] }],
  ])('rejects invalid body (%s) with 400', async (_label, body) => {
    const response = await POST(makeRequest(body), params())
    expect(response.status).toBe(400)
    expect(rpcMock).not.toHaveBeenCalled()
  })

  it('passes rule violations through as 409 with the Swedish message', async () => {
    rpcMock.mockResolvedValue({
      data: null,
      error: { code: 'P0001', message: 'Perioden är stängd eller låst.' },
    })

    const response = await POST(makeRequest({ description: 'Nytt namn' }), params())
    const { status, body } = await parseJsonResponse<{ error: string }>(response)
    expect(status).toBe(409)
    expect(body.error).toContain('stängd eller låst')
  })

  it('maps the tenant guard to 403', async () => {
    rpcMock.mockResolvedValue({
      data: null,
      error: { code: '42501', message: 'unauthorized: caller is not a member of company company-1' },
    })

    const response = await POST(makeRequest({ description: 'Nytt namn' }), params())
    expect(response.status).toBe(403)
  })

  it('returns 500 on unexpected RPC failure', async () => {
    rpcMock.mockResolvedValue({
      data: null,
      error: { code: 'XX000', message: 'boom' },
    })

    const response = await POST(makeRequest({ description: 'Nytt namn' }), params())
    expect(response.status).toBe(500)
  })

  it('backfills BAS accounts and calls the RPC with full payload', async () => {
    rpcMock.mockResolvedValue({
      data: { changed: true, line_count: 2, total_debit: 500, total_credit: 500 },
      error: null,
    })

    const response = await POST(
      makeRequest({ description: 'Rättad text', entry_date: '2026-03-15', lines: balancedLines }),
      params(),
    )
    const { status, body } = await parseJsonResponse<{ data: { changed: boolean } }>(response)

    expect(status).toBe(200)
    expect(body.data.changed).toBe(true)
    expect(backfillMock).toHaveBeenCalledWith(expect.anything(), 'company-1', 'user-1', ['1930', '6110'])
    expect(rpcMock).toHaveBeenCalledWith('edit_posted_entry', {
      p_company_id: 'company-1',
      p_entry_id: 'entry-1',
      p_description: 'Rättad text',
      p_entry_date: '2026-03-15',
      p_lines: [
        { account_number: '1930', debit_amount: 0, credit_amount: 500, line_description: null, dimensions: {} },
        { account_number: '6110', debit_amount: 500, credit_amount: 0, line_description: null, dimensions: {} },
      ],
      p_user_id: 'user-1',
    })
  })

  it('edits the header only without touching the backfill', async () => {
    rpcMock.mockResolvedValue({ data: { changed: true }, error: null })

    const response = await POST(makeRequest({ description: 'Bara texten' }), params())
    expect(response.status).toBe(200)
    expect(backfillMock).not.toHaveBeenCalled()
    expect(rpcMock).toHaveBeenCalledWith('edit_posted_entry', {
      p_company_id: 'company-1',
      p_entry_id: 'entry-1',
      p_description: 'Bara texten',
      p_entry_date: null,
      p_lines: null,
      p_user_id: 'user-1',
    })
  })
})
