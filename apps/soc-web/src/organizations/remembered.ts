const PREFIX = 'soc.organization.'

/** The organization last opened on this device by this user (FR-AUT-02). */
export function rememberedOrganization(userId: string): string | null {
  try {
    return window.localStorage.getItem(PREFIX + userId)
  } catch {
    return null
  }
}

export function rememberOrganization(userId: string, organizationId: string): void {
  try {
    window.localStorage.setItem(PREFIX + userId, organizationId)
  } catch {
    return
  }
}
