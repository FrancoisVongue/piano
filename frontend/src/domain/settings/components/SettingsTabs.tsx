'use client'

import { useState, useEffect } from 'react'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Alert, AlertDescription } from '@/components/ui/alert'
import { Input } from '@/components/ui/input'
import { Textarea } from '@/components/ui/textarea'
import { Button } from '@/components/ui/button'
import { Label } from '@/components/ui/label'
import { Skeleton } from '@/components/ui/skeleton'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { useUserProfile, useApiKeys } from '../hooks/useSettings'
import { UserApiKey } from '@piano/shared'
import { Info, User, Key, CreditCard, Trash2, Check, Brain, Server } from 'lucide-react'
import { ProviderModelPicker } from './ProviderModelPicker'
import { DaemonsTab } from '@/domain/daemon/components/DaemonsTab'

export function SettingsTabs() {
  const { profile, isLoading: profileLoading, updateProfile, isUpdating } = useUserProfile()
  const {
    keys, isLoading: keysLoading,
    upsertApiKey, deleteApiKey, setEnabledModels,
    isUpserting, isDeleting, isSettingModels,
  } = useApiKeys()

  const [name, setName] = useState('')
  const [selectedProvider, setSelectedProvider] = useState<UserApiKey.Provider>('ANTHROPIC')
  const [apiKey, setApiKey] = useState('')
  const [defaultSystemPromptDraft, setDefaultSystemPromptDraft] = useState('')
  const [isSavingSystemPrompt, setIsSavingSystemPrompt] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [successMessage, setSuccessMessage] = useState<string | null>(null)

  // Hydrate draft when profile loads
  useEffect(() => {
    if (profile) {
      setDefaultSystemPromptDraft(profile.defaultSystemPrompt ?? '')
    }
  }, [profile?.defaultSystemPrompt, profile])

  // Auto-clear success message after 3 seconds
  useEffect(() => {
    if (successMessage) {
      const timer = setTimeout(() => setSuccessMessage(null), 3000)
      return () => clearTimeout(timer)
    }
  }, [successMessage])

  const handleSaveKey = async () => {
    if (!apiKey.trim()) {
      setError('API key is required')
      return
    }
    setError(null)
    try {
      await upsertApiKey({ provider: selectedProvider, apiKey: apiKey.trim() })
      setApiKey('')
      setSuccessMessage('API key saved successfully')
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to save')
    }
  }

  const handleDeleteKey = async (provider: UserApiKey.Provider) => {
    if (!confirm(`Delete ${UserApiKey.providerConfig[provider].name} key?`)) return
    try {
      await deleteApiKey(provider)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to delete')
    }
  }

  const handleUpdateProfile = async () => {
    if (!name.trim()) return
    try {
      await updateProfile({ name: name.trim() })
      setName('')
      setSuccessMessage('Profile updated successfully')
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to update profile')
    }
  }

  const handleSaveDefaultSystemPrompt = async () => {
    setIsSavingSystemPrompt(true)
    setError(null)
    try {
      // Empty draft → null so the DB row reflects "no default system prompt".
      const next = defaultSystemPromptDraft.trim() === '' ? null : defaultSystemPromptDraft
      await updateProfile({ defaultSystemPrompt: next })
      setSuccessMessage(next ? 'Default system prompt saved' : 'Default system prompt cleared')
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to save')
    } finally {
      setIsSavingSystemPrompt(false)
    }
  }

  return (
    <Tabs defaultValue="api-keys" className="w-full">
      <TabsList className="grid w-full grid-cols-4 lg:w-[520px]">
        <TabsTrigger value="api-keys" className="flex items-center gap-2">
          <Key className="h-4 w-4" />
          <span className="hidden sm:inline">API Keys</span>
        </TabsTrigger>
        <TabsTrigger value="daemons" className="flex items-center gap-2">
          <Server className="h-4 w-4" />
          <span className="hidden sm:inline">Daemons</span>
        </TabsTrigger>
        <TabsTrigger value="profile" className="flex items-center gap-2">
          <User className="h-4 w-4" />
          <span className="hidden sm:inline">Profile</span>
        </TabsTrigger>
        <TabsTrigger value="subscription" className="flex items-center gap-2">
          <CreditCard className="h-4 w-4" />
          <span className="hidden sm:inline">Plan</span>
        </TabsTrigger>
      </TabsList>

      {/* API Keys Tab */}
      <TabsContent value="api-keys" className="space-y-6 mt-6">
        <div>
          <h2 className="text-2xl font-bold tracking-tight">Bring Your Own Key</h2>
          <p className="text-muted-foreground">
            Connect your API keys to use AI models with your own billing.
          </p>
        </div>

        <Alert>
          <Info className="h-4 w-4" />
          <AlertDescription>
            Keys are encrypted and used server-side only. You&apos;re billed directly by your provider.
            OpenRouter key unlocks all models; direct provider keys unlock only that provider&apos;s models.
          </AlertDescription>
        </Alert>

        {keysLoading ? (
          <Card>
            <CardContent className="pt-6 space-y-4">
              <Skeleton className="h-10 w-full" />
              <Skeleton className="h-10 w-full" />
            </CardContent>
          </Card>
        ) : (
          <Card>
            <CardHeader>
              <CardTitle>Add API Key</CardTitle>
            </CardHeader>
            <CardContent className="space-y-4">
              <div className="flex gap-3">
                <div className="w-40">
                  <Label htmlFor="provider" className="sr-only">Provider</Label>
                  <Select
                    value={selectedProvider}
                    onValueChange={(v) => setSelectedProvider(v as UserApiKey.Provider)}
                  >
                    <SelectTrigger id="provider">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {UserApiKey.providers.map((p) => (
                        <SelectItem key={p} value={p}>
                          {UserApiKey.providerConfig[p].name}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
                <div className="flex-1">
                  <Label htmlFor="apiKey" className="sr-only">API Key</Label>
                  <Input
                    id="apiKey"
                    type="password"
                    placeholder="Enter API key..."
                    value={apiKey}
                    onChange={(e) => { setApiKey(e.target.value); setError(null) }}
                  />
                </div>
                <Button onClick={handleSaveKey} disabled={isUpserting || !apiKey.trim()}>
                  {isUpserting ? '...' : 'Save'}
                </Button>
              </div>
              {error && <p className="text-sm text-destructive">{error}</p>}
              {successMessage && <p className="text-sm text-green-600">{successMessage}</p>}

              {/* Configured Keys */}
              {keys.length > 0 && (
                <div className="pt-4 border-t space-y-2">
                  <Label className="text-muted-foreground">Configured Keys</Label>
                  {keys.map((key) => (
                    <div
                      key={key.id}
                      className="p-3 rounded-md bg-muted/50"
                    >
                      <div className="flex items-center justify-between">
                        <div className="flex items-center gap-3">
                          <Check className="h-4 w-4 text-green-500" />
                          <span className="font-medium">
                            {UserApiKey.providerConfig[key.provider].name}
                          </span>
                          <code className="text-xs text-muted-foreground">{key.keyPrefix}</code>
                        </div>
                        <Button
                          variant="ghost"
                          size="sm"
                          onClick={() => handleDeleteKey(key.provider)}
                          disabled={isDeleting}
                          className="text-muted-foreground hover:text-destructive"
                        >
                          <Trash2 className="h-4 w-4" />
                        </Button>
                      </div>
                      <ProviderModelPicker
                        providerKey={key}
                        onToggle={(modelIds) =>
                          setEnabledModels({ provider: key.provider, modelIds }).catch(() => undefined)
                        }
                        disabled={isSettingModels}
                      />
                    </div>
                  ))}
                </div>
              )}
            </CardContent>
          </Card>
        )}
      </TabsContent>

      {/* Daemons Tab */}
      <TabsContent value="daemons" className="space-y-6 mt-6">
        <DaemonsTab />
      </TabsContent>

      {/* Profile Tab */}
      <TabsContent value="profile" className="space-y-6 mt-6">
        <div>
          <h2 className="text-2xl font-bold tracking-tight">Profile</h2>
          <p className="text-muted-foreground">Manage your account and global AI defaults.</p>
        </div>

        {profileLoading ? (
          <Card><CardContent className="pt-6"><Skeleton className="h-10 w-full" /></CardContent></Card>
        ) : (
          <>
            <Card>
              <CardContent className="pt-6 space-y-4">
                <div className="space-y-2">
                  <Label htmlFor="email">Email</Label>
                  <Input id="email" value={profile?.email ?? ''} disabled className="bg-muted" />
                </div>
                <div className="space-y-2">
                  <Label htmlFor="name">Display Name</Label>
                  <div className="flex gap-2">
                    <Input
                      id="name"
                      placeholder={profile?.name || 'Enter name'}
                      value={name}
                      onChange={(e) => setName(e.target.value)}
                      disabled={isUpdating}
                    />
                    <Button onClick={handleUpdateProfile} disabled={isUpdating || !name.trim()}>
                      Save
                    </Button>
                  </div>
                </div>
              </CardContent>
            </Card>

            <Card>
              <CardHeader>
                <CardTitle className="flex items-center gap-2">
                  <Brain className="h-5 w-5 text-blue-600" />
                  Default System Prompt
                </CardTitle>
              </CardHeader>
              <CardContent className="space-y-4">
                <Alert>
                  <Info className="h-4 w-4" />
                  <AlertDescription>
                    Prepended to <strong>every</strong> AI run across all your arrangements.
                    Arrangement-specific system prompts are appended after this one — you can
                    set a base persona here and refine it per arrangement.
                  </AlertDescription>
                </Alert>

                <div className="space-y-2">
                  <Textarea
                    id="defaultSystemPrompt"
                    value={defaultSystemPromptDraft}
                    onChange={(e) => setDefaultSystemPromptDraft(e.target.value)}
                    placeholder="You are a helpful assistant. Be concise and cite sources when relevant."
                    className="min-h-[150px] font-mono text-sm"
                  />
                  <div className="flex items-center justify-between">
                    <span className="text-xs text-muted-foreground">
                      {defaultSystemPromptDraft.length} / 10000 characters
                    </span>
                    <div className="flex gap-2">
                      {profile?.defaultSystemPrompt && (
                        <Button
                          variant="outline"
                          onClick={() => {
                            setDefaultSystemPromptDraft('')
                            handleSaveDefaultSystemPrompt()
                          }}
                          disabled={isSavingSystemPrompt}
                        >
                          Clear
                        </Button>
                      )}
                      <Button
                        onClick={handleSaveDefaultSystemPrompt}
                        disabled={
                          isSavingSystemPrompt ||
                          defaultSystemPromptDraft === (profile?.defaultSystemPrompt ?? '')
                        }
                      >
                        {isSavingSystemPrompt ? 'Saving…' : 'Save'}
                      </Button>
                    </div>
                  </div>
                </div>
              </CardContent>
            </Card>
          </>
        )}
      </TabsContent>

      {/* Subscription Tab */}
      <TabsContent value="subscription" className="space-y-6 mt-6">
        <div>
          <h2 className="text-2xl font-bold tracking-tight">Plan</h2>
          <p className="text-muted-foreground">Your subscription details.</p>
        </div>
        <Card>
          <CardContent className="pt-6">
            <div className="flex items-center justify-between p-4 rounded-lg bg-muted/50 border">
              <div>
                <h3 className="font-semibold">Free Plan</h3>
                <p className="text-sm text-muted-foreground">BYOK enabled</p>
              </div>
              <span className="text-xs bg-secondary text-secondary-foreground px-2 py-1 rounded">Current</span>
            </div>
          </CardContent>
        </Card>
      </TabsContent>
    </Tabs>
  )
}
