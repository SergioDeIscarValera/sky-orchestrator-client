// The console's own lint rules, kept free of imports so their test loads in
// milliseconds; eslint.config.js applies them to every source file.

const HEX_COLOUR = '/#[0-9a-fA-F]{3,8}(?![0-9a-zA-Z_-])/'
const FUNCTIONAL_COLOUR = '/\\b(?:rgba?|hsla?|hwb|lab|lch|oklab|oklch|color)\\(/'
const TOKENS_ONLY = 'Colours come from the design tokens in src/theme/theme.css (NFR-UX-01).'
const PLAIN_HTTP = 'Not available over plain HTTP from a LAN address (ADR-0015, NFR-PORT-04).'
const INLINE_STYLE =
  "A modal Radix menu injects an inline style the console's CSP refuses (NFR-SEC-07): give it modal={false}."
const NO_SIGN_UP = "SOC offers no sign-up: accounts are Virtual Origen's (FR-AUT-01)."

export const colourLiterals = [
  { selector: `Literal[value=${HEX_COLOUR}]`, message: TOKENS_ONLY },
  { selector: `Literal[value=${FUNCTIONAL_COLOUR}]`, message: TOKENS_ONLY },
  { selector: `TemplateElement[value.raw=${HEX_COLOUR}]`, message: TOKENS_ONLY },
  { selector: `TemplateElement[value.raw=${FUNCTIONAL_COLOUR}]`, message: TOKENS_ONLY },
]

export const accountCreation = [
  {
    selector: 'MemberExpression[property.name=/^(signUp|signInAnonymously|signInWithOtp)$/]',
    message: NO_SIGN_UP,
  },
]

export const inlineStyles = [
  {
    selector:
      "JSXOpeningElement[name.object.name='DropdownMenu'][name.property.name='Root']:not(:has(JSXAttribute[name.name='modal']))",
    message: INLINE_STYLE,
  },
]

export const secureContextApis = [
  { object: 'navigator', property: 'clipboard', message: PLAIN_HTTP },
  { object: 'navigator', property: 'serviceWorker', message: PLAIN_HTTP },
  { object: 'navigator', property: 'credentials', message: PLAIN_HTTP },
  { object: 'navigator', property: 'geolocation', message: PLAIN_HTTP },
  { object: 'navigator', property: 'storage', message: PLAIN_HTTP },
  { object: 'crypto', property: 'subtle', message: PLAIN_HTTP },
  { object: 'crypto', property: 'randomUUID', message: PLAIN_HTTP },
  { object: 'window', property: 'showSaveFilePicker', message: PLAIN_HTTP },
]

export const consoleRules = {
  'no-restricted-syntax': ['error', ...colourLiterals, ...accountCreation, ...inlineStyles],
  'no-restricted-properties': ['error', ...secureContextApis],
}
