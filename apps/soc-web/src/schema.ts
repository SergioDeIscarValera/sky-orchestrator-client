import { z } from 'zod/mini'
import en from 'zod/v4/locales/en.js'

z.config(en())

/** Zod's small build with English messages, the one every schema in the web uses. */
export { z }
