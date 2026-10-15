/**
 * Opens a live subscription from above the shell's region boundaries (Console.tsx). One that throws
 * as it opens costs the console its live updates, never the console and its safety controls
 * (FR-CMD-07): the failure is reported, and what it kept live goes stale instead (FR-SAF-02).
 */
export function openLive(name: string, open: () => () => void): () => void {
  try {
    return open()
  } catch (error) {
    console.error(`The ${name} subscription did not open`, error)
    return () => undefined
  }
}
