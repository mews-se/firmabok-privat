import { NextResponse } from 'next/server'
import { ensureInitialized } from '@/lib/init'
import { withRouteContext } from '@/lib/api/with-route-context'
import { deleteDocument } from '@/lib/core/documents/document-service'
import { fileStorage } from '@/lib/storage/local'
import { eventBus } from '@/lib/events'
import { getErrorMessage as getUserErrorMessage } from '@/lib/errors/get-error-message'

ensureInitialized()

/**
 * GET /api/documents/:id
 * Fetch document metadata + signed download URL (60 min expiry)
 */
export const GET = withRouteContext<{ params: Promise<{ id: string }> }>(
  'document.get',
  async (_request, { supabase, companyId, user }, { params }) => {
    const { id } = await params

    // Fetch document record
    const { data: doc, error: docError } = await supabase
      .from('document_attachments')
      .select('*')
      .eq('id', id)
      .eq('company_id', companyId)
      .single()

    if (docError || !doc) {
      return NextResponse.json({ error: 'Document not found' }, { status: 404 })
    }

    // Sign the download URL (60 minutes) and persist the access event in
    // parallel: both depend only on the row fetch and are independent of
    // each other. The emit stays awaited (event-log-handler's insert must
    // not race Vercel function suspension) and never rejects (the bus
    // settles handlers via Promise.allSettled), so it cannot fail this
    // Promise.all.
    //
    // The row fetch above (RLS + explicit company filter) is the
    // authorization, mirroring the inline proxy route.
    const [signResult] = await Promise.all([
      fileStorage().from('documents').createSignedUrl(doc.storage_path, 3600),
      eventBus.emit({
        type: 'document.accessed',
        payload: {
          document: { id: doc.id, file_name: doc.file_name },
          userId: user.id,
          companyId,
        },
      }),
    ])
    const { data: signedUrl, error: signError } = signResult

    if (signError) {
      return NextResponse.json(
        { error: `Failed to create download URL: ${getUserErrorMessage(signError)}` },
        { status: 500 }
      )
    }

    return NextResponse.json({
      data: {
        ...doc,
        download_url: signedUrl?.signedUrl ?? null,
      },
    })
  }
)

/**
 * DELETE /api/documents/:id
 * Remove a document permanently, linked to a verifikat or not. The
 * delete_document RPC refuses invoice delivery evidence; everything else
 * goes, storage objects included. Superseding via POST
 * /api/documents/:id/versions remains the traceable alternative.
 */
export const DELETE = withRouteContext<{ params: Promise<{ id: string }> }>(
  'document.delete',
  async (_request, { supabase, companyId, user }, { params }) => {
    const { id } = await params

    try {
      const result = await deleteDocument(supabase, companyId, id, user.id)

      if (!result.ok) {
        return NextResponse.json({ error: result.message }, { status: result.status })
      }

      return NextResponse.json({ data: { id: result.document.id, deleted: true } })
    } catch (error) {
      console.error('[documents/DELETE] Failed to delete document:', error)
      return NextResponse.json(
        { error: error instanceof Error ? getUserErrorMessage(error) : 'Failed to delete document' },
        { status: 500 }
      )
    }
  },
  { requireWrite: true }
)
