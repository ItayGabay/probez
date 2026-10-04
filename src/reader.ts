import { spawn } from 'node:child_process'
import { mkdir, readFile, stat, writeFile } from 'node:fs/promises'
import { delimiter, dirname, extname, isAbsolute, join } from 'node:path'

/**
 * The one place probez runs anything.
 *
 * Everything else here reads files and prints. This spawns a command — the one the person wrote
 * into `reader.json` — writes a prompt to its stdin and reads its stdout. It exists so that
 * `probez explain` can hand a question to whatever model the person already has, and it is the
 * whole of that capability: nothing else in the codebase spawns, and CI greps to keep it that way.
 *
 * It is worth being precise about what this does and does not cross.
 *
 * - probez still opens no socket. The reader might; that is the reader's business, run under the
 *   person's own account with their own credentials, the same as typing the command themselves.
 * - `command` is argv and is spawned with `shell: false`, so a `;`, a `|` or a `$(…)` inside it is
 *   an argument and never a second command. There is nowhere for a project name, a file path or
 *   anything else read out of a session to reach the argv: only this file's config does.
 * - There is no default command. An unconfigured probez cannot execute anything at all, which is
 *   the fence — not a flag that defaults to off, but an absence of anything to run.
 */

/** What to run, and how long to wait for it. */
export interface ReaderConfig {
  schema_version: number
  /** argv, not a shell line: `["claude", "-p"]`, `["ollama", "run", "llama3"]`. */
  command: string[]
  timeout_ms: number
}

export const READER_VERSION = 1

/** A minute. Long enough for a local model on a cold start, short enough to not look hung. */
export const DEFAULT_TIMEOUT_MS = 60_000
/** Anything past this is a reader that is streaming its own logs at us, not answering. */
export const MAX_OUTPUT = 64 * 1024

/** The file the command lives in, beside `pricing.json` rather than inside any one project. */
export function readerFile(dataDir: string): string {
  return join(dataDir, 'reader.json')
}

function asCommand(value: unknown): string[] | null {
  if (!Array.isArray(value) || value.length === 0) return null
  const argv: string[] = []
  for (const part of value) {
    if (typeof part !== 'string' || part.trim() === '') return null
    argv.push(part)
  }
  return argv
}

/**
 * The configured reader, or null when there is none.
 *
 * Null is the ordinary case and not an error: probez ships with no reader, and every caller has
 * something to say when there is nothing to run. A file that exists but does not parse is null too
 * — a half-written config must not become a command.
 */
export async function readReader(dataDir: string): Promise<ReaderConfig | null> {
  let raw: unknown
  try {
    raw = JSON.parse(await readFile(readerFile(dataDir), 'utf8'))
  } catch {
    return null
  }
  const value = raw as { command?: unknown; timeout_ms?: unknown } | null
  const command = asCommand(value?.command)
  if (command === null) return null
  const timeout = value?.timeout_ms
  return {
    schema_version: READER_VERSION,
    command,
    timeout_ms:
      typeof timeout === 'number' && Number.isFinite(timeout) && timeout > 0
        ? Math.round(timeout)
        : DEFAULT_TIMEOUT_MS,
  }
}

/** Owner-only, the mode everything under the data directory is written with. */
export async function writeReader(dataDir: string, config: ReaderConfig): Promise<void> {
  await mkdir(dataDir, { recursive: true, mode: 0o700 })
  const body = {
    schema_version: READER_VERSION,
    command: config.command,
    timeout_ms: config.timeout_ms,
  }
  await writeFile(readerFile(dataDir), JSON.stringify(body, null, 2) + '\n', {
    encoding: 'utf8',
    mode: 0o600,
  })
}

/** The reader as it would be typed, which is what a failure has to name to be fixable. */
export function readerName(config: ReaderConfig): string {
  return config.command.join(' ')
}

/**
 * How a reader is credited on screen: the program, and nothing else.
 *
 * A working config is often five flags long, and a reading that ends `— claude -p --model haiku
 * --effort low --disallowed-tools Bash Read Edit …` spends a line and a half saying `claude`. What
 * the whole argv was is in `reader.json`, which is one file and never a surprise.
 */
export function readerShortName(config: ReaderConfig): string {
  const program = config.command[0] ?? ''
  return program.split(/[/\\]/).pop() || program
}

export class ReaderError extends Error {}

/** The first line of whatever the reader complained with, which is the useful part of a failure. */
function firstLine(text: string): string {
  const line = text.split('\n').find((one) => one.trim() !== '')
  return line === undefined ? '' : line.trim().slice(0, 200)
}

/** What to spawn in place of a name: a file, and any arguments that have to come before the user's. */
export interface Located {
  file: string
  prefix: string[]
}

/**
 * The program an npm `.cmd` shim starts, read out of the shim rather than run through `cmd.exe`.
 *
 * Windows will not spawn a batch file without a shell, and most of what people would name here —
 * `claude`, `codex`, `gemini` — is installed by npm as exactly that: a few lines of batch whose only
 * job is to start a `.exe` or `node <script>` with `%*` after it. Reading that one line and
 * spawning what it names keeps the reader argv-only, which a shell would not.
 *
 * Only the shapes npm writes are understood. Anything else — a variable this does not know, a line
 * with no `%*` — is null, and the caller says so rather than guessing at a batch file.
 */
export function shimTarget(text: string, shimDir: string, node: string): Located | null {
  const line = text.split(/\r?\n/).find((one) => one.includes('%*') && one.includes('"'))
  if (line === undefined) return null
  const dir = shimDir.endsWith('\\') || shimDir.endsWith('/') ? shimDir : `${shimDir}\\`
  const parts: string[] = []
  for (const [, quoted] of line.matchAll(/"([^"]*)"/g)) {
    if (quoted === '%_prog%') {
      parts.push(node)
      continue
    }
    const filled = quoted!.replace(/%dp0%\\?|%~dp0\\?/gi, dir)
    if (filled.includes('%')) return null
    parts.push(filled)
  }
  if (parts.length === 0) return null
  return { file: parts[0]!, prefix: parts.slice(1) }
}

async function isFile(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isFile()
  } catch {
    return false
  }
}

/**
 * Find what a reader's program name means on Windows, the way `cmd.exe` would, without one.
 *
 * `spawn` with no shell takes `claude` literally and finds nothing, because what is on PATH is
 * `claude.cmd`. So the name is looked up across PATH and PATHEXT here, an `.exe` is spawned by its
 * full path, and an npm shim is read for the program it starts. Null means nothing was found and
 * the spawn goes ahead with the name as given, which is what reports it missing.
 */
export async function locateOnWindows(
  program: string,
  env: NodeJS.ProcessEnv,
): Promise<Located | null> {
  const exts = (env.PATHEXT ?? '.COM;.EXE;.BAT;.CMD').split(';').filter((one) => one !== '')
  const given = extname(program) !== ''
  const dirs =
    isAbsolute(program) || program.includes('\\') || program.includes('/')
      ? ['']
      : (env.PATH ?? env.Path ?? '').split(delimiter).filter((one) => one !== '')

  for (const dir of dirs) {
    for (const ext of given ? [''] : exts) {
      const path = dir === '' ? program + ext : join(dir, program + ext)
      if (!(await isFile(path))) continue
      const kind = extname(path).toLowerCase()
      if (kind !== '.cmd' && kind !== '.bat') return { file: path, prefix: [] }
      const target = shimTarget(await readFile(path, 'utf8'), dirname(path), process.execPath)
      if (target === null) {
        throw new ReaderError(
          `\`${program}\` is a batch file (${path}) that probez cannot read the program out of, and ` +
            'it runs nothing through a shell; name the .exe or the script it starts instead',
        )
      }
      return target
    }
  }
  return null
}

/**
 * Run the reader over one prompt and hand back what it printed.
 *
 * stdin is the prompt and is closed immediately, because a reader that waits for more input would
 * otherwise sit until the timeout. stdout is capped: a reader that streams progress forever is a
 * misconfiguration, and the cap turns it into a message rather than into memory. The child inherits
 * the environment, which is how `claude -p` and its like find their own credentials — probez holds
 * no key and has nowhere to put one.
 */
export async function runReader(config: ReaderConfig, prompt: string): Promise<string> {
  const [named, ...rest] = config.command
  let program = named!
  let argv = rest
  if (process.platform === 'win32') {
    const found = await locateOnWindows(named!, process.env)
    if (found !== null) {
      program = found.file
      argv = [...found.prefix, ...rest]
    }
  }
  return new Promise((ok, fail) => {
    const child = spawn(program, argv, {
      stdio: ['pipe', 'pipe', 'pipe'],
      shell: false,
      env: process.env,
    })

    let out = ''
    let err = ''
    let over = false
    let done = false

    const finish = (error: Error | null, value?: string): void => {
      if (done) return
      done = true
      clearTimeout(timer)
      if (error !== null) fail(error)
      else ok(value!)
    }

    // SIGTERM first, then SIGKILL, because a reader that ignores the polite one still has to go.
    const stop = (): void => {
      child.kill('SIGTERM')
      setTimeout(() => child.kill('SIGKILL'), 2000).unref()
    }

    const timer = setTimeout(() => {
      stop()
      finish(
        new ReaderError(
          `\`${readerName(config)}\` did not answer within ${Math.round(config.timeout_ms / 1000)}s`,
        ),
      )
    }, config.timeout_ms)

    child.stdout.setEncoding('utf8')
    child.stdout.on('data', (chunk: string) => {
      if (out.length + chunk.length > MAX_OUTPUT) {
        over = true
        out += chunk.slice(0, Math.max(0, MAX_OUTPUT - out.length))
        stop()
        return
      }
      out += chunk
    })
    child.stderr.setEncoding('utf8')
    child.stderr.on('data', (chunk: string) => {
      if (err.length < MAX_OUTPUT) err += chunk
    })

    child.on('error', (error: NodeJS.ErrnoException) => {
      finish(
        new ReaderError(
          error.code === 'ENOENT'
            ? `there is no \`${named}\` on this machine's PATH`
            : `\`${readerName(config)}\` could not be run: ${error.message}`,
        ),
      )
    })

    child.on('close', (code) => {
      if (over) {
        finish(
          new ReaderError(
            `\`${readerName(config)}\` printed more than ${Math.round(MAX_OUTPUT / 1024)} KB`,
          ),
        )
        return
      }
      if (code !== 0 && code !== null) {
        const said = firstLine(err)
        finish(
          new ReaderError(
            `\`${readerName(config)}\` exited ${code}${said === '' ? '' : `: ${said}`}`,
          ),
        )
        return
      }
      finish(null, out)
    })

    child.stdin.on('error', () => {
      // A reader that closed its stdin before reading the whole prompt is answering from what it
      // got, or failing. Either way its exit code is the thing to report, not this.
    })
    child.stdin.end(prompt, 'utf8')
  })
}
