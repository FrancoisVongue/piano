'use client'

import { useState } from 'react'
import { useMachineCenterStore } from '../store'
import { Spinner } from '@/components/ui/spinner'
import { Plus, Trash2, Eye, EyeOff } from 'lucide-react'

export function SecretsTab() {
  const secrets = useMachineCenterStore(s => s.secrets)
  const isLoading = useMachineCenterStore(s => s.isLoadingSecrets)
  const createSecret = useMachineCenterStore(s => s.createSecret)
  const deleteSecret = useMachineCenterStore(s => s.deleteSecret)

  const [newKey, setNewKey] = useState('')
  const [newValue, setNewValue] = useState('')
  const [showValue, setShowValue] = useState(false)
  const [isAdding, setIsAdding] = useState(false)

  const handleAdd = async () => {
    if (!newKey.trim() || !newValue.trim()) return
    setIsAdding(true)
    const ok = await createSecret(newKey.trim(), newValue.trim())
    if (ok) {
      setNewKey('')
      setNewValue('')
      setShowValue(false)
    }
    setIsAdding(false)
  }

  return (
    <div className="space-y-4">
      <p className="text-xs text-muted-foreground">
        Secrets are injected as environment variables into all new machines.
      </p>

      {/* Add form */}
      <div className="flex gap-2 items-end">
        <div className="flex-1">
          <label className="text-xs font-medium text-muted-foreground">Key</label>
          <input
            type="text"
            value={newKey}
            onChange={e => setNewKey(e.target.value.toUpperCase().replace(/[^A-Z0-9_]/g, ''))}
            placeholder="GITHUB_TOKEN"
            className="w-full text-sm px-2.5 py-1.5 border rounded bg-background mt-0.5"
          />
        </div>
        <div className="flex-1 relative">
          <label className="text-xs font-medium text-muted-foreground">Value</label>
          <div className="relative mt-0.5">
            <input
              type={showValue ? 'text' : 'password'}
              value={newValue}
              onChange={e => setNewValue(e.target.value)}
              placeholder="ghp_xxxx..."
              className="w-full text-sm px-2.5 py-1.5 border rounded bg-background pr-8"
            />
            <button
              onClick={() => setShowValue(!showValue)}
              className="absolute right-2 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
            >
              {showValue ? <EyeOff className="w-3.5 h-3.5" /> : <Eye className="w-3.5 h-3.5" />}
            </button>
          </div>
        </div>
        <button
          onClick={handleAdd}
          disabled={!newKey.trim() || !newValue.trim() || isAdding}
          className="flex items-center gap-1 text-xs font-medium px-3 py-1.5 rounded bg-primary text-primary-foreground hover:bg-primary/90 disabled:opacity-50 transition-colors shrink-0 self-end mb-0.5"
        >
          <Plus className="w-3 h-3" />
          Add
        </button>
      </div>

      {/* List */}
      {isLoading ? (
        <div className="flex justify-center py-8"><Spinner /></div>
      ) : secrets.length === 0 ? (
        <p className="text-sm text-muted-foreground py-4">
          No secrets yet. Add your first one above.
        </p>
      ) : (
        <div className="border rounded-lg divide-y">
          {secrets.map(secret => (
            <div key={secret.id} className="flex items-center gap-3 px-4 py-2.5">
              <code className="text-sm font-medium flex-1 font-mono">{secret.key}</code>
              <span className="text-sm text-muted-foreground font-mono">{secret.maskedValue}</span>
              <button
                onClick={() => {
                  if (confirm(`Delete secret ${secret.key}? Existing machines will keep it, but new machines won't get it.`)) {
                    deleteSecret(secret.id)
                  }
                }}
                className="text-muted-foreground hover:text-destructive transition-colors p-1"
                title={`Delete ${secret.key}`}
              >
                <Trash2 className="w-3.5 h-3.5" />
              </button>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
