import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createQueuedMockSupabase, makeDocumentAttachment } from '@/tests/helpers'
import { TOOL_SCOPE_MAP } from '@/lib/auth/api-keys'
import { MCP_TOOL_CAPABILITY_MAP } from '@/lib/entitlements/keys'

const mocks = vi.hoisted(() => ({
  createPendingDocumentUpload: vi.fn(),
  completePendingDocumentUpload: vi.fn(),
}))

vi.mock('@/lib/core/documents/document-service', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/core/documents/document-service')>()
  return {
    ...actual,
    createPendingDocumentUpload: mocks.createPendingDocumentUpload,
    completePendingDocumentUpload: mocks.completePendingDocumentUpload,
  }
})

import { tools } from '../server'

const companyId = '11111111-1111-4111-8111-111111111111'
const userId = '22222222-2222-4222-8222-222222222222'
const uploadId = '33333333-3333-4333-8333-333333333333'

function findTool(name: string) {
  const tool = tools.find((candidate) => candidate.name === name)
  if (!tool) throw new Error(`Tool not found: ${name}`)
  return tool
}

function makeQueryBuilder(result: { data: unknown; error: unknown }) {
  const builder: Record<string, unknown> = {}
  for (const method of ['select', 'eq', 'limit', 'insert']) {
    builder[method] = vi.fn().mockReturnValue(builder)
  }
  builder.maybeSingle = vi.fn().mockResolvedValue(result)
  builder.single = vi.fn().mockResolvedValue(result)
  return builder
}

describe('MCP model-free document upload tools', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.createPendingDocumentUpload.mockResolvedValue({
      uploadId,
      signedUrl: 'https://storage.example/upload?token=signed',
      expiresAt: '2026-08-03T12:00:00.000Z',
    })
    mocks.completePendingDocumentUpload.mockResolvedValue({
      document: makeDocumentAttachment({
        id: uploadId,
        user_id: userId,
        company_id: companyId,
        file_name: 'invoice.pdf',
        mime_type: 'application/pdf',
      }),
      buffer: new TextEncoder().encode('%PDF-1.4\n%%EOF\n').buffer,
    })
  })

  it('returns an unauthenticated PUT URL without accepting file bytes', async () => {
    const tool = findTool('gnubok_create_document_upload')
    const result = await tool.execute(
      { file_name: 'invoice.pdf' },
      companyId,
      userId,
      {} as never,
    )

    expect(mocks.createPendingDocumentUpload).toHaveBeenCalledWith(
      companyId,
      userId,
      expect.stringMatching(/^[0-9a-f-]{36}$/),
      'invoice.pdf',
    )
    expect(result).toEqual({
      upload_id: uploadId,
      upload_url: 'https://storage.example/upload?token=signed',
      expires_at: '2026-08-03T12:00:00.000Z',
    })
    const schema = tool.inputSchema as { properties: Record<string, unknown> }
    expect(schema.properties).not.toHaveProperty('file_content_base64')
  })

  it('completes the reserved upload and uses the upload UUID for both records', async () => {
    const inboxInsert = makeQueryBuilder({ data: { id: uploadId, status: 'received' }, error: null })
    const invoiceLookups = [
      makeQueryBuilder({ data: null, error: null }),
      makeQueryBuilder({ data: null, error: null }),
      inboxInsert,
    ]
    const from = vi.fn((table: string) => {
      if (table === 'invoice_inbox_items') return invoiceLookups.shift()
      throw new Error(`Unexpected table: ${table}`)
    })

    const result = await findTool('gnubok_complete_document_upload').execute(
      { upload_id: uploadId, file_name: 'invoice.pdf', mime_type: 'application/pdf' },
      companyId,
      userId,
      { from } as never,
    )

    expect(mocks.completePendingDocumentUpload).toHaveBeenCalledWith(
      expect.anything(),
      companyId,
      userId,
      uploadId,
      'invoice.pdf',
      'application/pdf',
    )
    expect(inboxInsert.insert).toHaveBeenCalledWith(
      expect.objectContaining({ id: uploadId, document_id: uploadId }),
    )
    expect(result).toMatchObject({
      document_id: uploadId,
      inbox_item_id: uploadId,
      status: 'received',
    })
  })

  it('returns an already completed inbox item without downloading again', async () => {
    const existing = makeQueryBuilder({
      data: {
        id: uploadId,
        document_id: uploadId,
        status: 'received',
        extracted_data: { invoice: { number: 'INV-1' } },
        matched_supplier_id: null,
      },
      error: null,
    })
    const result = await findTool('gnubok_complete_document_upload').execute(
      { upload_id: uploadId, file_name: 'invoice.pdf', mime_type: 'application/pdf' },
      companyId,
      userId,
      { from: vi.fn().mockReturnValue(existing) } as never,
    )

    expect(result).toMatchObject({ document_id: uploadId, inbox_item_id: uploadId })
    expect(mocks.completePendingDocumentUpload).not.toHaveBeenCalled()
  })

  it('keeps the upload paths on the transactions:write scope and free of capability gates', () => {
    for (const name of [
      'gnubok_create_document_upload',
      'gnubok_complete_document_upload',
      'gnubok_upload_document',
    ]) {
      expect(TOOL_SCOPE_MAP[name]).toBe('transactions:write')
      expect(MCP_TOOL_CAPABILITY_MAP[name]).toBeUndefined()
    }
  })
})

describe('gnubok_delete_document: staging gates', () => {
  const documentId = '66666666-6666-4666-8666-666666666666'

  it('is registered on transactions:write with destructive annotations', () => {
    const tool = findTool('gnubok_delete_document')
    expect(tool.annotations.readOnlyHint).toBe(false)
    expect(tool.annotations.destructiveHint).toBe(true)
    expect(TOOL_SCOPE_MAP.gnubok_delete_document).toBe('transactions:write')
    expect(MCP_TOOL_CAPABILITY_MAP.gnubok_delete_document).toBeUndefined()
  })

  it('rejects a document that is delivery evidence for a sent invoice', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({
      data: { id: documentId, file_name: 'faktura-101.pdf', mime_type: 'application/pdf', journal_entry_id: null },
      error: null,
    })
    enqueue({ count: 1 }) // invoice_deliveries head-count

    await expect(
      findTool('gnubok_delete_document').execute(
        { document_id: documentId },
        companyId,
        userId,
        supabase as never,
      ),
    ).rejects.toThrow(/leveransbevis/i)
  })

  it('rejects an unknown document id', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({ data: null, error: null })

    await expect(
      findTool('gnubok_delete_document').execute(
        { document_id: documentId },
        companyId,
        userId,
        supabase as never,
      ),
    ).rejects.toThrow(/document not found/i)
  })

  it('stages deletion of a linked document with voucher and detach counts in the preview', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({
      data: { id: documentId, file_name: 'kvitto.pdf', mime_type: 'application/pdf', journal_entry_id: 'je-1' },
      error: null,
    })
    enqueue({ count: 0 }) // invoice_deliveries head-count
    enqueue({ data: { voucher_series: 'A', voucher_number: 42, status: 'posted' }, error: null })
    enqueue({ count: 2 }) // transactions head-count
    enqueue({ data: { id: 'op-deldoc-1' }, error: null }) // pending_operations insert

    const result = (await findTool('gnubok_delete_document').execute(
      { document_id: documentId },
      companyId,
      userId,
      supabase as never,
    )) as { staged: boolean; operation_id?: string; risk_level: string; preview: Record<string, unknown> }

    expect(result.staged).toBe(true)
    expect(result.operation_id).toBe('op-deldoc-1')
    expect(result.risk_level).toBe('high')
    expect(result.preview.linked_voucher).toBe('A42')
    expect(result.preview.transactions_to_detach).toBe(2)
    expect(result.preview.document_file_name).toBe('kvitto.pdf')
  })
})
