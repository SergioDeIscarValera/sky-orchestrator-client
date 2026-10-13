import { useLiveState } from '../fleets/data'

/** Keeps the open organization's live topics current, as Console does in the app. */
export function LiveTopics() {
  useLiveState()
  return null
}
