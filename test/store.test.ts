import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

import { copilotVsUsageFile } from '../src/copilot-vs-log.js'
import { collectProject, projectDir, readRoundsIn, sniffSource } from '../src/store.js'
import type { Project } from '../src/types.js'
import { packInt, requestTurn, responseTurn, sessionMeta, textBlock } from './vs-fixture.js'

const here = dirname(fileURLToPath(import.meta.url))
const CLAUDE = join(here, '..', '..', 'test', 'fixtures', 'session.jsonl')
const CURSOR = join(here, '..', '..', 'test', 'fixtures', 'cursor-session.jsonl')
const CODEX = join(here, '..', '..', 'test', 'fixtures', 'codex-session.jsonl')
const COPILOT = join(here, '..', '..', 'test', 'fixtures', 'copilot-session.jsonl')

test('sniffSource recognises transcript format, not missing tokens', async () => {
  assert.equal(await sniffSource(CLAUDE), 'claude-code')
  assert.equal(await sniffSource(CURSOR), 'cursor')
  assert.equal(await sniffSource(CODEX), 'codex')
  assert.equal(await sniffSource(COPILOT), 'copilot')
})

test('sniffSource returns unknown when the file is not a known transcript', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'probez-sniff-'))
  const file = join(dir, 'notes.jsonl')
  writeFileSync(file, `${JSON.stringify({ foo: 1 })}\n`)
  assert.equal(await sniffSource(file), 'unknown')

  const empty = join(dir, 'empty.jsonl')
  writeFileSync(empty, '\n')
  assert.equal(await sniffSource(empty), 'unknown')

  assert.equal(await sniffSource(join(dir, 'missing.jsonl')), 'unknown')
})

test('sniffSource does not infer Cursor from a Claude row that happens to lack tokens', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'probez-sniff-claude-'))
  const file = join(dir, 'sess.jsonl')
  writeFileSync(
    file,
    `${JSON.stringify({ type: 'user', sessionId: 'aaaa', message: { role: 'user', content: 'hi' } })}\n`,
  )
  assert.equal(await sniffSource(file), 'claude-code')
})

test("collect gives a Visual Studio chat its log's usage, and keeps it past the log", async () => {
  const root = mkdtempSync(join(tmpdir(), 'probez-vs-collect-'))
  const id = '9b58251b-2eca-4d74-8159-b8f7d38b07e7'
  const sessions = join(root, 'app', '.vs', 'app', 'copilot-chat', 'b7a19d4b', 'sessions')
  mkdirSync(sessions, { recursive: true })
  const file = join(sessions, id)
  writeFileSync(
    file,
    Buffer.concat([
      packInt(1),
      sessionMeta(),
      requestTurn('corr-old', 'what does this do', 'gpt-5-mini'),
      responseTurn('corr-old', 'm1', [textBlock('It prints a menu.')]),
      requestTurn('corr-new', 'add a comment', 'gpt-5-mini'),
      responseTurn('corr-new', 'm2', [textBlock('Done.')]),
    ]),
  )
  // Only the second request is still in a log; the first one's log was cleared long ago.
  const logs = join(root, 'logs')
  mkdirSync(logs)
  const usage = (input: number, cached: number, output: number): string =>
    `[2026-10-03 14:06:55.997 Conversations V] [CopilotClient EventType(11)] [${JSON.stringify({
      InputTokenCount: input,
      OutputTokenCount: output,
      AdditionalCounts: { prompt_tokens_details_cached_tokens: cached },
    })}]`
  writeFileSync(
    join(logs, '20261003_140603.057_VSGitHubCopilot.chat.log'),
    [
      `[2026-10-03 14:06:47.950 CopilotSessionProvider I] Begin sending message ` +
        `(ConversationId:${id}, CorrelationId:corr-new, MessageId: x)`,
      'Model: gpt-5-mini',
      usage(12_571, 12_160, 420),
      'Model: gpt-5-mini',
      usage(13_013, 12_800, 14),
    ].join('\n'),
  )

  const info = statSync(file)
  const project: Project = {
    key: join(root, 'app'),
    path: join(root, 'app'),
    dir: join(root, 'app'),
    sessions: [
      { id: `vs-${id}`, file, size: info.size, mtimeMs: info.mtimeMs, source: 'copilot', vs: true },
    ],
    lastActivity: info.mtimeMs,
  }
  const dataDir = join(root, 'data')
  await collectProject(project, dataDir, { copilotVsLogDir: logs })
  const read = async (): Promise<Array<[number | null, number | null]>> =>
    (await readRoundsIn(projectDir(dataDir, project))).map((r) => [
      r.in_tokens,
      r.context_tokens ?? null,
    ])
  assert.deepEqual(await read(), [
    [null, null],
    [25_584, 13_013],
  ])

  // Visual Studio clears its log. A full re-collect still has what probez kept.
  rmSync(logs, { recursive: true })
  await collectProject(project, dataDir, { full: true, copilotVsLogDir: logs })
  assert.deepEqual(await read(), [
    [null, null],
    [25_584, 13_013],
  ])
  assert.ok(statSync(copilotVsUsageFile(dataDir)).size > 0)
})
