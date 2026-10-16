// What the end to end's browser drivers share (console.mjs, operation.mjs): the environment
// they are given, the JSON lines they speak with the harness (out on stdout, in on stdin),
// their trace on stderr, Chrome's arguments and how they exit.

/** The value of an environment variable a driver needs, or the error that says it is missing. */
export function required(name) {
  const value = process.env[name]
  if (value === undefined || value === '') throw new Error(`${name} is not set`)
  return value
}

/** One line of JSON to the harness. */
export function emit(line) {
  process.stdout.write(`${JSON.stringify(line)}\n`)
}

/** The driver's trace for `script`, on stderr: where a run that stops half way had got to. */
export function tracer(script) {
  return (step) => {
    process.stderr.write(`[${script} ${new Date().toISOString()}] ${step}\n`)
  }
}

/** Chrome's arguments. Without a GPU, as on the runners, WebGL needs SwiftShader allowed. */
export function chromeArguments() {
  return process.env.SOC_E2E_SOFTWARE_GL === '1'
    ? ['--use-angle=swiftshader', '--enable-unsafe-swiftshader']
    : ['--enable-gpu', '--ignore-gpu-blocklist', '--use-angle=gl']
}

/**
 * Runs a driver's `main`, then exits. On an error it says `failed` with the message first. The
 * exit is explicit: the harness's open stdin, and Playwright's own SIGTERM handler, would
 * otherwise keep Node running after the browser has closed.
 */
export function run(main) {
  main().then(
    () => process.exit(0),
    (error) => {
      emit({ event: 'failed', message: error.message })
      process.exit(1)
    },
  )
}
