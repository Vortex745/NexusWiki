import { useCallback, useEffect, useState } from "react"

import {
  fetchMemoryProfile,
  resetMemoryProfile,
  saveMemoryProfile,
  type MemorySections,
  type ServerMemoryProfile,
} from "./api"

/**
 * Long-term memory (2026-10-30): the browser does NOT own the profile. It is
 * one account-level row on the server; this module mirrors it for the UI.
 * The old browser-owned record list is purged once on load.
 */
export interface MemoryProfileView extends MemorySections {
  updatedAt: string | null
}

const EMPTY_PROFILE: MemoryProfileView = {
  workBackground: "",
  personalBackground: "",
  recentActivity: "",
  updatedAt: null,
}

const LEGACY_STORAGE_KEY = "kefu_rag_memories"

function fromServer(profile: ServerMemoryProfile): MemoryProfileView {
  return {
    workBackground: profile.workBackground,
    personalBackground: profile.personalBackground,
    recentActivity: profile.recentActivity,
    updatedAt: profile.updatedAt,
  }
}

export function formatMemoryUpdatedAt(isoString?: string | null): string {
  if (!isoString) return ""
  const date = new Date(isoString)
  if (Number.isNaN(date.getTime())) return ""
  const time = `${date.getHours().toString().padStart(2, "0")}:${date
    .getMinutes()
    .toString()
    .padStart(2, "0")}`
  return `${date.getMonth() + 1}月${date.getDate()}日 ${time}`
}

export function useMemoryProfile() {
  const [profile, setProfile] = useState<MemoryProfileView>(EMPTY_PROFILE)
  const [loaded, setLoaded] = useState(false)
  const [failed, setFailed] = useState(false)

  const refresh = useCallback(async () => {
    try {
      const server = await fetchMemoryProfile()
      setProfile(fromServer(server))
      setFailed(false)
    } catch {
      // Keep the last known state; the server stays the source.
      setFailed(true)
    } finally {
      setLoaded(true)
    }
  }, [])

  useEffect(() => {
    // One-time purge of the browser-owned copy this feature replaced.
    try {
      localStorage.removeItem(LEGACY_STORAGE_KEY)
    } catch {
      // Storage may be blocked; nothing depends on it anymore.
    }
    void refresh()
  }, [refresh])

  const save = useCallback(async (sections: Partial<MemorySections>) => {
    const updated = await saveMemoryProfile(sections)
    setProfile(fromServer(updated))
    setFailed(false)
  }, [])

  const reset = useCallback(async () => {
    await resetMemoryProfile()
    setProfile(EMPTY_PROFILE)
    setFailed(false)
  }, [])

  return { profile, loaded, failed, refresh, save, reset }
}
