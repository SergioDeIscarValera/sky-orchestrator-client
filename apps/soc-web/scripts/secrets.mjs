// The built application carries no secret and no secret's name (NFR-SEC-02): its
// only key is the public one, read from /config.json when the console starts.
import { readFileSync, readdirSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

export const FORBIDDEN = [
  { name: 'a JWT', pattern: /eyJ[\w-]{8,}\.eyJ[\w-]{8,}\.[\w-]+/ },
  { name: 'a Supabase secret key', pattern: /sb_secret_[\w-]{8,}/ },
  {
    name: "a service's secret variable",
    pattern: /SOC_(?:SUPABASE_SERVICE_ROLE_KEY|DB_PASSWORD_\w+|MQTT_PASSWORD_\w+|SO_API_TOKEN_\w+)/,
  },
]

export function secretsIn(text) {
  return FORBIDDEN.filter(({ pattern }) => pattern.test(text)).map(({ name }) => name)
}

function scan(directory) {
  return readdirSync(directory, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => `${entry.parentPath}/${entry.name}`)
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const files = scan(fileURLToPath(new URL('../dist', import.meta.url)))
  const found = files.flatMap((file) =>
    secretsIn(readFileSync(file, 'latin1')).map((name) => `${file}: ${name}`),
  )
  if (found.length > 0) {
    console.error(`Secrets in the built application (NFR-SEC-02):\n${found.join('\n')}`)
    process.exit(1)
  }
  console.log(`no secret in the ${String(files.length)} built files`)
}
