import { describe, it, expect, vi } from 'vitest'
import { createQueuedMockSupabase } from '@/tests/helpers'
import { attentionResource } from '../resources/attention'

type AttentionResponse = {
  generated_at: string
  summary: { total_items: number; critical: number; warning: number; info: number }
  categories: Array<{
    key: string
    severity: 'critical' | 'warning' | 'info'
    count: number
    samples: Array<Record<string, unknown>>
    next?: { description: string; tool?: string; args?: Record<string, unknown>; resource?: string }
  }>
}

const ctx = (supabase: ReturnType<typeof createQueuedMockSupabase>['supabase']) => ({
  supabase: supabase as never,
  companyId: 'company-1',
  userId: 'user-1',
  scopes: [],
})

/**
 * Enqueues 9 baseline empty results in the order the resource consumes them.
 * Tests can override individual slots before invoking by enqueueing in advance.
 */
function enqueueEmpty(enqueue: (r: { data?: unknown; error?: unknown; count?: number | null }) => void) {
  // 1. overdueRows
  enqueue({ data: [] })
  // 2. pendingSupplierHead
  enqueue({ count: 0 })
  // 3. pendingSupplierSamples
  enqueue({ data: [] })
  // 4. pendingOpsHead
  enqueue({ count: 0 })
  // 5. pendingOpsSamples
  enqueue({ data: [] })
  // 6. deadlineRows
  enqueue({ data: [] })
  // 7. bankConnRows
  enqueue({ data: [] })
  // 8. activePeriodRow
  enqueue({ data: null })
  // 9. companySettingsRow
  enqueue({ data: null })
}

describe('Accounted://attention', () => {
  it('returns empty summary for a brand-new company', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueueEmpty(enqueue)

    const result = (await attentionResource.read(ctx(supabase))) as AttentionResponse

    expect(result.generated_at).toMatch(/^\d{4}-\d{2}-\d{2}T/)
    expect(result.summary).toEqual({ total_items: 0, critical: 0, warning: 0, info: 0 })
    expect(result.categories).toEqual([])
  })

  it('flags overdue invoices as critical when any are > 30 days past due', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    const fortyDaysAgo = new Date(Date.now() - 40 * 86_400_000).toISOString().slice(0, 10)
    const tenDaysAgo = new Date(Date.now() - 10 * 86_400_000).toISOString().slice(0, 10)
    const overdue = [
      { id: 'i-1', invoice_number: 'F-2024001', customer_id: 'c-1', due_date: fortyDaysAgo, total: 1000, currency: 'SEK', status: 'overdue' },
      { id: 'i-2', invoice_number: 'F-2024002', customer_id: 'c-1', due_date: tenDaysAgo, total: 500, currency: 'SEK', status: 'sent' },
    ]

    enqueue({ data: overdue })       // overdueRows
    enqueue({ count: 0 })            // pendingSupplierHead
    enqueue({ data: [] })            // pendingSupplierSamples
    enqueue({ count: 0 })            // pendingOpsHead
    enqueue({ data: [] })            // pendingOpsSamples
    enqueue({ data: [] })            // deadlineRows
    enqueue({ data: [] })            // bankConnRows
    enqueue({ data: null })          // activePeriodRow
    enqueue({ data: null })          // companySettingsRow

    const result = (await attentionResource.read(ctx(supabase))) as AttentionResponse
    const cat = result.categories.find((c) => c.key === 'overdue_invoices')
    expect(cat?.severity).toBe('critical')
    expect(cat?.count).toBe(2)
  })

  it('marks pending operations as critical when any high-risk op is queued', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    const ops = [
      { id: 'op-1', operation_type: 'close_period', title: 'Stäng FY2025', risk_level: 'high', actor_label: 'agent', created_at: new Date().toISOString() },
      { id: 'op-2', operation_type: 'create_customer', title: 'Ny kund', risk_level: 'low', actor_label: 'agent', created_at: new Date().toISOString() },
    ]

    enqueue({ data: [] })            // overdueRows
    enqueue({ count: 0 })            // pendingSupplierHead
    enqueue({ data: [] })            // pendingSupplierSamples
    enqueue({ count: 2 })            // pendingOpsHead
    enqueue({ data: ops })           // pendingOpsSamples
    enqueue({ data: [] })            // deadlineRows
    enqueue({ data: [] })            // bankConnRows
    enqueue({ data: null })          // activePeriodRow
    enqueue({ data: null })          // companySettingsRow

    const result = (await attentionResource.read(ctx(supabase))) as AttentionResponse
    const cat = result.categories.find((c) => c.key === 'pending_operations')
    expect(cat?.severity).toBe('critical')
    expect(cat?.count).toBe(2)
    expect(result.summary.critical).toBe(1)
  })

  it('does not scan for voucher gaps: gaps are normal and never an attention item', async () => {
    // Frihetspaketet: gnubok_delete_voucher leaves mid-series gaps by design
    // and explanations are optional, so the gap card and its per-series RPC
    // sweep are gone. The baseline queue is exactly 9 queries; an extra
    // detect_voucher_gaps call would leave the queue short and throw.
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueueEmpty(enqueue)

    const result = (await attentionResource.read(ctx(supabase))) as AttentionResponse

    expect(result.categories.find((c) => c.key === 'voucher_gaps_unexplained')).toBeUndefined()
    const rpcCalls = (supabase.rpc as ReturnType<typeof vi.fn>).mock.calls
    expect(rpcCalls.map((args) => args[0])).not.toContain('detect_voucher_gaps')
  })

  it('flags expired bank consent as critical', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    const yesterday = new Date(Date.now() - 86_400_000).toISOString().slice(0, 10)
    const banks = [
      { id: 'bc-1', bank_name: 'SEB', status: 'active', consent_expires: yesterday },
    ]

    enqueue({ data: [] })            // overdueRows
    enqueue({ count: 0 })            // pendingSupplierHead
    enqueue({ data: [] })            // pendingSupplierSamples
    enqueue({ count: 0 })            // pendingOpsHead
    enqueue({ data: [] })            // pendingOpsSamples
    enqueue({ data: [] })            // deadlineRows
    enqueue({ data: banks })         // bankConnRows
    enqueue({ data: null })          // activePeriodRow
    enqueue({ data: null })          // companySettingsRow

    const result = (await attentionResource.read(ctx(supabase))) as AttentionResponse
    const cat = result.categories.find((c) => c.key === 'bank_consent_expiring')
    expect(cat?.severity).toBe('critical')
    expect(cat?.count).toBe(1)
  })

  it('classifies upcoming lock as info severity', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    const inSevenDays = new Date(Date.now() + 7 * 86_400_000).toISOString().slice(0, 10)

    enqueue({ data: [] })            // overdueRows
    enqueue({ count: 0 })            // pendingSupplierHead
    enqueue({ data: [] })            // pendingSupplierSamples
    enqueue({ count: 0 })            // pendingOpsHead
    enqueue({ data: [] })            // pendingOpsSamples
    enqueue({ data: [] })            // deadlineRows
    enqueue({ data: [] })            // bankConnRows
    enqueue({ data: { id: 'fp-1', name: 'FY2026', period_start: '2026-01-01', period_end: '2026-12-31', locked_at: null, is_closed: false } })
    enqueue({ data: { bookkeeping_locked_through: inSevenDays, auto_lock_period_days: null } })

    const result = (await attentionResource.read(ctx(supabase))) as AttentionResponse
    const cat = result.categories.find((c) => c.key === 'period_lock_approaching')
    expect(cat?.severity).toBe('info')
    expect(result.summary.info).toBe(1)
  })

  it('combines multiple categories into a coherent summary', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    const today = new Date().toISOString().slice(0, 10)

    enqueue({ data: [] })                                                  // overdueRows
    enqueue({ count: 1 })                                                  // pendingSupplierHead
    enqueue({ data: [{ id: 'si-1', supplier_invoice_number: 'L-1', supplier_id: 's-1', total: 1000, currency: 'SEK', due_date: today }] })
    enqueue({ count: 0 })                                                  // pendingOpsHead
    enqueue({ data: [] })                                                  // pendingOpsSamples
    enqueue({ data: [{ id: 'd-1', title: 'Moms Q1', due_date: today, deadline_type: 'tax', tax_deadline_type: 'vat', status: 'upcoming' }] })
    enqueue({ data: [] })                                                  // bankConnRows
    enqueue({ data: null })                                                // activePeriodRow
    enqueue({ data: null })                                                // companySettingsRow

    const result = (await attentionResource.read(ctx(supabase))) as AttentionResponse
    expect(result.categories).toHaveLength(2)
    expect(new Set(result.categories.map((c) => c.key))).toEqual(
      new Set(['pending_supplier_invoices', 'deadlines_upcoming'])
    )
    expect(result.summary.total_items).toBe(2)
  })
})
