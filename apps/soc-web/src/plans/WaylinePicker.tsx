import {
  useCombobox,
  useMultipleSelection,
  type UseComboboxState,
  type UseComboboxStateChangeOptions,
} from 'downshift'
import { X } from 'lucide-react'
import { useMemo, useState, type KeyboardEvent } from 'react'

import { FIELD } from '../app/styles'
import type { Wayline } from '../backend/backend'
import { matching, normalise } from '../search/match'

const { InputKeyDownEnter, ItemClick, InputBlur } = useCombobox.stateChangeTypes

/** A wayline not yet chosen, with the words it is matched by: its name, normalised. */
interface Candidate {
  readonly wayline: Wayline
  readonly words: readonly string[]
}

const LIST = 'rounded-card bg-surface border-border max-h-72 overflow-y-auto border p-1.5'

function idsOf(waylines: readonly Wayline[]): string[] {
  return waylines.map(({ id }) => id)
}

function waypointWords(count: number): string {
  return count === 1 ? '1 waypoint' : `${String(count)} waypoints`
}

function foundWords(count: number): string {
  if (count === 0) return 'No waylines match'
  return count === 1 ? '1 found' : `${String(count)} found`
}

/**
 * Choosing selects; leaving the field never does, and keeps what was typed. Downshift
 * would otherwise choose the highlighted wayline on blur. A choice clears the text and
 * keeps the list open, its first wayline highlighted, for the next one.
 */
function stateReducer(
  state: UseComboboxState<Wayline>,
  { type, changes }: UseComboboxStateChangeOptions<Wayline>,
): Partial<UseComboboxState<Wayline>> {
  if (type === InputKeyDownEnter || type === ItemClick) {
    return { ...changes, inputValue: '', isOpen: true, highlightedIndex: 0 }
  }
  if (type === InputBlur) return { ...changes, inputValue: state.inputValue }
  return changes
}

interface Props {
  /** The organization's saved waylines. */
  readonly waylines: readonly Wayline[]
  /** The ids chosen, in the order they were chosen: the order the round follows. */
  readonly chosen: readonly string[]
  /** Called with the chosen ids, in order, after every change. */
  readonly onChange: (chosen: readonly string[]) => void
}

/**
 * The waylines a generated geofence round follows (FR-GEO-03): one multiple-choice
 * combobox over the saved waylines. Typing narrows them by name, Enter or a click adds
 * one, and each chosen one is a pill with a remove button. Backspace in an empty field
 * removes the last. Enter never submits the form around it. With no wayline saved, the
 * field is disabled.
 */
export function WaylinePicker({ waylines, chosen, onChange }: Props) {
  const [query, setQuery] = useState('')
  // The field as state, not a ref: Downshift's prop getter takes it during render.
  const [field, setField] = useState<HTMLInputElement | null>(null)
  const selected = useMemo(() => {
    const byId = new Map(waylines.map((wayline) => [wayline.id, wayline] as const))
    return chosen.flatMap((id) => byId.get(id) ?? [])
  }, [chosen, waylines])
  const candidates = useMemo<Candidate[]>(() => {
    const taken = new Set(idsOf(selected))
    return waylines
      .filter(({ id }) => !taken.has(id))
      .map((wayline) => ({ wayline, words: [normalise(wayline.name)] }))
  }, [selected, waylines])
  const matches = useMemo(
    () => matching(candidates, query).map(({ wayline }) => wayline),
    [candidates, query],
  )

  const { getDropdownProps, getSelectedItemProps, removeSelectedItem } =
    useMultipleSelection<Wayline>({
      selectedItems: selected,
      itemToKey: (wayline) => wayline?.id,
      onSelectedItemsChange: ({ selectedItems }) => {
        onChange(idsOf(selectedItems))
      },
    })
  const { isOpen, highlightedIndex, getLabelProps, getMenuProps, getInputProps, getItemProps } =
    useCombobox<Wayline>({
      items: matches,
      itemToString: (wayline) => wayline?.name ?? '',
      inputValue: query,
      selectedItem: null,
      defaultHighlightedIndex: 0,
      stateReducer,
      onInputValueChange: ({ inputValue }) => {
        setQuery(inputValue)
      },
      onStateChange: ({ type, selectedItem }) => {
        if ((type === InputKeyDownEnter || type === ItemClick) && selectedItem) {
          onChange([...idsOf(selected), selectedItem.id])
        }
      },
    })
  // Backspace takes a pill only from an empty field: downshift would also take one at the
  // start of typed text.
  const dropdown = getDropdownProps({ preventKeyAction: query !== '', ref: setField })
  const open = isOpen && matches.length > 0

  return (
    <div className="flex flex-col gap-1.5">
      <label {...getLabelProps()} className="text-heading text-sm font-medium">
        Waylines
      </label>
      {selected.length > 0 && (
        <ul aria-label="Chosen waylines" className="flex flex-wrap gap-1.5">
          {selected.map((wayline, index) => (
            <li
              key={wayline.id}
              {...getSelectedItemProps({ selectedItem: wayline, index })}
              className="rounded-pill bg-primary-subtle text-primary-emphasis focus-visible:ring-primary inline-flex max-w-full items-center gap-1 py-0.5 pr-1 pl-2.5 text-xs font-semibold outline-none focus-visible:ring-2"
            >
              <span className="min-w-0 truncate">{wayline.name}</span>
              <button
                type="button"
                aria-label={`Remove ${wayline.name}`}
                className="rounded-pill text-primary-emphasis hover:bg-primary hover:text-on-primary focus-visible:ring-primary inline-flex size-5 shrink-0 items-center justify-center outline-none focus-visible:ring-2"
                onClick={(event) => {
                  // The pill beneath would otherwise take the click as a selection.
                  event.stopPropagation()
                  removeSelectedItem(wayline)
                  field?.focus()
                }}
              >
                <X size={12} aria-hidden />
              </button>
            </li>
          ))}
        </ul>
      )}
      <input
        {...getInputProps({
          ...dropdown,
          onKeyDown: (event: KeyboardEvent<HTMLInputElement>) => {
            // Downshift leaves Enter alone while the list is closed, and there Enter would
            // submit the form around the field.
            if (event.key === 'Enter') event.preventDefault()
            dropdown.onKeyDown?.(event)
          },
        })}
        className={FIELD}
        autoComplete="off"
        spellCheck={false}
        disabled={waylines.length === 0}
      />
      <ul {...getMenuProps()} className={open ? LIST : 'hidden'}>
        {open &&
          matches.map((wayline, index) => (
            <li
              key={wayline.id}
              {...getItemProps({ item: wayline, index })}
              className={`flex cursor-pointer items-center gap-3 rounded-lg px-3 py-2 text-sm ${
                index === highlightedIndex ? 'bg-primary-subtle' : ''
              }`}
            >
              <span className="text-heading min-w-0 flex-1 truncate">{wayline.name}</span>
              <span className="text-muted shrink-0 text-xs">
                {waypointWords(wayline.metrics.waypointCount)}
              </span>
            </li>
          ))}
      </ul>
      <p role="status" className="sr-only">
        {isOpen && query.trim() !== '' ? foundWords(matches.length) : ''}
      </p>
    </div>
  )
}
