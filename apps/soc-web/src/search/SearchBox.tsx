import { useCombobox, type UseComboboxState, type UseComboboxStateChangeOptions } from 'downshift'
import { Search } from 'lucide-react'
import { useEffect, useMemo, useState } from 'react'

import { useSelect } from '../app/router'
import { MENU } from '../app/styles'
import { useAircraftColours } from '../fleets/colours'
import { useAircraftModels, useDevices, useFleets } from '../fleets/data'
import { Swatch } from '../fleets/Swatch'
import { marked, search, searchables, type Found } from './match'

const { InputKeyDownEnter, ItemClick, InputBlur } = useCombobox.stateChangeTypes

/** A key the console's own fields take, so `/` there is typed, not a jump to the search. */
function typing(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false
  return target.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName)
}

/** `/` anywhere but in a field focuses the search, as the hint beside it says. */
function useSlashFocuses(input: HTMLInputElement | null) {
  useEffect(() => {
    const focus = (event: KeyboardEvent) => {
      if (event.key !== '/' || event.ctrlKey || event.metaKey || event.altKey) return
      if (typing(event.target)) return
      event.preventDefault()
      input?.focus()
    }
    window.addEventListener('keydown', focus)
    return () => {
      window.removeEventListener('keydown', focus)
    }
  }, [input])
}

function foundWords(count: number): string {
  if (count === 0) return 'No aircraft matches'
  return count === 1 ? '1 found' : `${String(count)} found`
}

/** `text` with where the query is found in it marked. */
function Marked({ text, query }: { readonly text: string; readonly query: string }) {
  const [before = '', match, after] = marked(text, query)
  return (
    <>
      {before}
      {match !== undefined && (
        <mark className="text-primary-emphasis bg-transparent font-semibold">{match}</mark>
      )}
      {after}
    </>
  )
}

/**
 * Choosing selects; leaving the field never does, and keeps what was typed. Downshift
 * would otherwise select the highlighted result on blur.
 */
function stateReducer(
  state: UseComboboxState<Found>,
  { type, changes }: UseComboboxStateChangeOptions<Found>,
): Partial<UseComboboxState<Found>> {
  if (type === InputKeyDownEnter || type === ItemClick) return { ...changes, inputValue: '' }
  if (type === InputBlur) return { ...changes, inputValue: state.inputValue }
  return changes
}

/**
 * The organization's search in the top bar: its fleets and the aircraft its stacks
 * announced, by name, model or serial, best first. Choosing one selects it, so the
 * inspector shows it and the scene follows it (FR-SCN-05); `/` focuses it.
 */
export function SearchBox() {
  const fleets = useFleets()
  const devices = useDevices()
  const models = useAircraftModels()
  const select = useSelect()
  const colourOf = useAircraftColours()
  // The field as state, not a ref: Downshift's prop getter takes it during render.
  const [input, setInput] = useState<HTMLInputElement | null>(null)
  const [query, setQuery] = useState('')
  useSlashFocuses(input)

  const entries = useMemo(
    () => searchables(fleets.data ?? [], devices.data ?? [], models.data ?? []),
    [fleets.data, devices.data, models.data],
  )
  const found = useMemo(() => search(entries, query), [entries, query])

  const { isOpen, highlightedIndex, getLabelProps, getInputProps, getMenuProps, getItemProps } =
    useCombobox<Found>({
      items: found,
      itemToString: (item) => item?.title ?? '',
      inputValue: query,
      selectedItem: null,
      defaultHighlightedIndex: 0,
      stateReducer,
      onInputValueChange: ({ inputValue }) => {
        setQuery(inputValue)
      },
      onStateChange: ({ type, selectedItem }) => {
        if ((type === InputKeyDownEnter || type === ItemClick) && selectedItem) {
          select(selectedItem.selection)
          input?.blur()
        }
      },
    })

  const nothing = isOpen && found.length === 0
  return (
    <div role="search" className="relative ml-4 w-full max-w-sm">
      <label {...getLabelProps()} className="sr-only">
        Search aircraft
      </label>
      <Search
        size={16}
        aria-hidden
        className="text-muted pointer-events-none absolute top-1/2 left-3 -translate-y-1/2"
      />
      <input
        {...getInputProps({ ref: setInput })}
        type="text"
        placeholder="Search aircraft"
        autoComplete="off"
        spellCheck={false}
        className="peer bg-page text-heading placeholder:text-muted rounded-pill focus-visible:ring-primary h-9 w-full pr-9 pl-9 text-sm outline-none focus-visible:ring-2"
      />
      <kbd
        aria-hidden
        className="border-border text-muted pointer-events-none absolute top-1/2 right-3 hidden -translate-y-1/2 rounded-md border px-1.5 text-xs peer-placeholder-shown:inline peer-focus:hidden"
      >
        /
      </kbd>
      <div className={isOpen ? `${MENU} absolute top-full right-0 left-0 mt-2` : 'hidden'}>
        <ul {...getMenuProps({ 'aria-label': 'Aircraft found' })}>
          {isOpen &&
            found.map((item, index) => (
              <li
                key={item.key}
                {...getItemProps({ item, index })}
                className={`flex cursor-pointer items-center gap-3 rounded-lg px-3 py-2 text-sm ${
                  index === highlightedIndex ? 'bg-primary-subtle' : ''
                }`}
              >
                <Swatch colour={colourOf(item.aircraft)} />
                <span className="min-w-0 flex-1">
                  <span className="text-heading block truncate font-medium">
                    <Marked text={item.title} query={query} />
                  </span>
                  <span className="text-muted block truncate text-xs">
                    <Marked text={item.detail} query={query} />
                  </span>
                </span>
                <span className="text-muted shrink-0 text-xs">{item.kind}</span>
              </li>
            ))}
        </ul>
        {nothing && (
          <p className="text-muted px-3 py-2 text-sm">
            {query.trim() === '' ? 'No aircraft yet.' : `No aircraft matches “${query.trim()}”.`}
          </p>
        )}
      </div>
      <p role="status" className="sr-only">
        {isOpen && query.trim() !== '' ? foundWords(found.length) : ''}
      </p>
    </div>
  )
}
