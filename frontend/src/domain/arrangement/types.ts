import { Arrangement, Note } from '@piano/shared'

export namespace ArrangementUI {
  // UI state for arrangement list
  export interface ListState {
    selectedId: string | null
    filter: 'all' | 'recent' | 'favorites'
    sortBy: 'title' | 'updatedAt' | 'createdAt'
    sortDirection: 'asc' | 'desc'
    searchQuery: string
  }

  // Extended arrangement with UI metadata
  export interface WithUIMetadata extends Arrangement.Model {
    isSelected: boolean
    isLoading: boolean
    isFavorite?: boolean
    hasUnsavedChanges?: boolean
    lastOpenedAt?: Date
  }

  // Sidebar specific types
  export interface SidebarState {
    isCollapsed: boolean
    width: number
    searchQuery: string
  }

  // Create/Edit form data
  export interface FormData {
    title: string
    description?: string
  }

  // Helper functions for arrangement UI
  export const sortArrangements = (
    arrangements: Arrangement.Model[],
    sortBy: ListState['sortBy'],
    sortDirection: ListState['sortDirection']
  ): Arrangement.Model[] => {
    return [...arrangements].sort((a, b) => {
      let comparison = 0

      switch (sortBy) {
        case 'title':
          comparison = a.title.localeCompare(b.title)
          break
        case 'updatedAt':
          comparison = new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime()
          break
        case 'createdAt':
          comparison = new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime()
          break
      }

      return sortDirection === 'asc' ? comparison : -comparison
    })
  }

  export const filterArrangements = (
    arrangements: WithUIMetadata[],
    filter: ListState['filter']
  ): WithUIMetadata[] => {
    switch (filter) {
      case 'recent':
        // Filter to last 7 days
        const weekAgo = new Date()
        weekAgo.setDate(weekAgo.getDate() - 7)
        return arrangements.filter(a => new Date(a.updatedAt) > weekAgo)

      case 'favorites':
        return arrangements.filter(a => a.isFavorite)

      default:
        return arrangements
    }
  }

  export const searchArrangements = (
    arrangements: Arrangement.Model[],
    query: string
  ): Arrangement.Model[] => {
    if (!query.trim()) return arrangements

    const lowerQuery = query.toLowerCase()
    return arrangements.filter(a =>
      a.title.toLowerCase().includes(lowerQuery)
    )
  }

  // Calculate arrangement statistics
  export interface ArrangementStats {
    totalNodes: number
    userNodes: number
    assistantNodes: number
    systemNodes: number
  }

  export const calculateStats = (notes: Note.Model[]): ArrangementStats => {
    return {
      totalNodes: notes.length,
      userNodes: notes.filter(n => n.type === 'USER').length,
      assistantNodes: notes.filter(n => n.type === 'ASSISTANT').length,
      systemNodes: notes.filter(n => n.type === 'SYSTEM').length
    }
  }
}