import { apiClient } from '@/services/api'
import { Union } from '@/lib/types'
import { Arrangement, Note, Edge as EdgeModel } from '@piano/shared'

/** Generate a collision-safe id for imported nodes/edges */
const newId = () => `imp_${Date.now()}_${Math.random().toString(36).slice(2, 11)}`

/** Convert an ExportDoc into a patch payload ready for `/arrangements/:id/patch`. */
const documentToPatchPayload = (doc: Arrangement.ExportDoc.Document): Note.DTO.PatchPayload => ({
  dirtyNodes: doc.notes.map(n => ({
    id: n.id,
    type: n.type,
    content: n.content,
    label: n.label ?? undefined,
    color: n.color ?? undefined,
    tags: n.tags,
    layers: (n as any).layers ?? [],
    pinned: n.pinned,
    isMergePoint: n.isMergePoint,
    ancestorOverride: n.ancestorOverride,
    scale: n.scale,
    x: n.x,
    y: n.y,
    width: n.width ?? undefined,
    height: n.height ?? undefined,
    parentId: n.parentId ?? undefined,
    style: n.style ?? undefined, // TextStyle for TEXT nodes, opaque for others
  })),
  dirtyEdges: doc.edges.map(e => ({
    id: e.id,
    source: e.sourceId,
    target: e.targetId,
    sourceHandle: e.sourceHandleId ?? undefined,
    targetHandle: e.targetHandleId ?? undefined,
    type: e.type,
    label: e.label ?? undefined,
  })),
  deletedNodeIds: [],
  deletedEdgeIds: [],
  demotedNodeIds: [],
})

export const ArrangementService = {
  async fetchAll(): Promise<Union.Variant<{
    success: Arrangement.Model[];
    error: { message: string };
  }>> {
    return apiClient<Arrangement.Model[]>('/arrangements')
  },

  async fetchById(id: string): Promise<Union.Variant<{
    success: Arrangement.Model;
    error: { message: string };
  }>> {
    return apiClient<Arrangement.Model>(`/arrangements/${id}`)
  },

  async create(
    input: string | { title: string; tags?: string[] }
  ): Promise<Union.Variant<{
    success: Arrangement.Model;
    error: { message: string };
  }>> {
    // Legacy call signature: create(title) → wrap into the object form.
    const body = typeof input === 'string' ? { title: input } : input
    return apiClient<Arrangement.Model>('/arrangements', {
      method: 'POST',
      body: JSON.stringify(body),
    })
  },

  async update(id: string, updateData: Arrangement.DTO.Update): Promise<Union.Variant<{
    success: Arrangement.Model;
    error: { message: string };
  }>> {
    return apiClient<Arrangement.Model>(`/arrangements/${id}`, {
      method: 'PATCH',
      body: JSON.stringify(updateData),
    })
  },

  async deleteArrangement(id: string): Promise<Union.Variant<{
    success: void;
    error: { message: string };
  }>> {
    return apiClient<void>(`/arrangements/${id}`, {
      method: 'DELETE',
    })
  },

  // Granular patch endpoint for optimistic sync
  async patch(
    id: string,
    payload: Note.DTO.PatchPayload
  ): Promise<Union.Variant<{
    success: { processed: { nodes: string[]; edges: string[] }; failed: { id: string; reason: string }[] };
    error: { message: string };
  }>> {
    return apiClient<{ processed: { nodes: string[]; edges: string[] }; failed: { id: string; reason: string }[] }>(
      `/arrangements/${id}/patch`,
      {
        method: 'POST',
        body: JSON.stringify(payload),
      }
    )
  },

  async executeAction(
    arrangementId: string,
    data: Arrangement.DTO.ExecuteAction
  ): Promise<Union.Variant<{
    success: Arrangement.Response.RunResult;
    error: { message: string };
  }>> {
    return apiClient<Arrangement.Response.RunResult>(`/arrangements/${arrangementId}/execute-action`, {
      method: 'POST',
      body: JSON.stringify(data),
    })
  },

  /**
   * Import a portable arrangement document. Creates a new arrangement with fresh IDs
   * and persists all notes + edges via the existing patch endpoint.
   *
   * Wraps two API calls (create + patch) so the caller gets one Union result.
   */
  async importFromDocument(
    doc: Arrangement.ExportDoc.Document
  ): Promise<Union.Variant<{
    success: { id: string; title: string };
    error: { message: string };
  }>> {
    // Validate and remap IDs before hitting the backend
    let remapped: Arrangement.ExportDoc.Document
    try {
      const validated = Arrangement.ExportDoc.validate(doc)
      remapped = Arrangement.ExportDoc.remapIds(validated, newId)
    } catch (err) {
      return { error: { message: err instanceof Error ? err.message : 'Invalid document' } }
    }

    // Create the empty arrangement first, then populate it via the patch endpoint.
    // Using plain narrowing rather than Union.match so TypeScript can follow the flow.
    const createResult = await ArrangementService.create(remapped.title)
    if ('error' in createResult && createResult.error) {
      return { error: { message: createResult.error.message } }
    }
    if (!('success' in createResult) || !createResult.success) {
      return { error: { message: 'Unexpected empty create response' } }
    }
    const createdId = createResult.success.id

    const patchResult = await ArrangementService.patch(createdId, documentToPatchPayload(remapped))
    if ('error' in patchResult && patchResult.error) {
      return { error: { message: patchResult.error.message } }
    }

    return { success: { id: createdId, title: remapped.title } }
  },

  async executeUnifier(
    arrangementId: string,
    unifierId: string,
    data: {
      noteIds: string[];
      userPrompt?: string;
      model: string;
    }
  ): Promise<Union.Variant<{
    success: Arrangement.Response.RunResult;
    error: { message: string };
  }>> {
    return apiClient<Arrangement.Response.RunResult>(
      `/arrangements/${arrangementId}/unifiers/${unifierId}`,
      {
        method: 'POST',
        body: JSON.stringify(data),
      }
    )
  },

  async exportAsJson(id: string): Promise<Union.Variant<{
    success: { noteCount: number };
    error: { message: string };
  }>> {
    const result = await ArrangementService.fetchById(id)
    if ('error' in result && result.error) {
      return { error: result.error }
    }
    if (!('success' in result) || !result.success) {
      return { error: { message: 'Failed to fetch arrangement' } }
    }
    const arr = result.success
    const notes = ((arr.notes as Note.Model[] | undefined) ?? [])
    const edges = ((arr.edges as EdgeModel.Model[] | undefined) ?? [])
    const doc = Arrangement.ExportDoc.toDocument(arr.title, notes, edges)
    const blob = new Blob([JSON.stringify(doc, null, 2)], { type: 'application/json' })
    const safeTitle = arr.title.replace(/[^\w-]+/g, '_').slice(0, 64) || 'arrangement'
    const a = document.createElement('a')
    a.href = URL.createObjectURL(blob)
    a.download = `${safeTitle}.piano.json`
    document.body.appendChild(a)
    a.click()
    document.body.removeChild(a)
    URL.revokeObjectURL(a.href)
    return { success: { noteCount: doc.notes.length } }
  },
}
