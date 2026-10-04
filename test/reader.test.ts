import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'

import { locateOnWindows, ReaderError, shimTarget } from '../src/reader.js'

// What npm writes for a package whose bin is a native program, `claude` among them.
const EXE_SHIM = [
  '@ECHO off',
  'GOTO start',
  ':find_dp0',
  'SET dp0=%~dp0',
  'EXIT /b',
  ':start',
  'SETLOCAL',
  'CALL :find_dp0',
  '"%dp0%\\node_modules\\@anthropic-ai\\claude-code\\bin\\claude.exe"   %*',
].join('\r\n')

// And for one whose bin is a script node has to run.
const NODE_SHIM = [
  '@ECHO off',
  'GOTO start',
  ':find_dp0',
  'SET dp0=%~dp0',
  'EXIT /b',
  ':start',
  'SETLOCAL',
  'CALL :find_dp0',
  '',
  'IF EXIST "%dp0%\\node.exe" (',
  '  SET "_prog=%dp0%\\node.exe"',
  ') ELSE (',
  '  SET "_prog=node"',
  '  SET PATHEXT=%PATHEXT:;.JS;=;%',
  ')',
  '',
  'endLocal & goto #_undefined_# 2>NUL || title %COMSPEC% & "%_prog%"  "%dp0%\\node_modules\\codex\\bin\\codex.js" %*',
].join('\r\n')

test('an npm shim for a native program is read as that program, with nothing in front', () => {
  assert.deepEqual(shimTarget(EXE_SHIM, 'C:\\npm', 'C:\\node\\node.exe'), {
    file: 'C:\\npm\\node_modules\\@anthropic-ai\\claude-code\\bin\\claude.exe',
    prefix: [],
  })
})

test('an npm shim for a script is node, with the script as its first argument', () => {
  assert.deepEqual(shimTarget(NODE_SHIM, 'C:\\npm\\', 'C:\\node\\node.exe'), {
    file: 'C:\\node\\node.exe',
    prefix: ['C:\\npm\\node_modules\\codex\\bin\\codex.js'],
  })
})

test('a batch file that is not a shim is not guessed at', () => {
  assert.equal(shimTarget('@echo off\r\necho hello', 'C:\\x', 'node'), null)
  // A variable this does not know could be anything by the time cmd expands it.
  assert.equal(shimTarget('"%SOMEWHERE%\\tool.exe" %*', 'C:\\x', 'node'), null)
})

test('on Windows a name is found through PATH and PATHEXT, the way cmd would find it', { skip: process.platform !== 'win32' }, async () => {
  const dir = mkdtempSync(join(tmpdir(), 'probez-reader-'))
  try {
    writeFileSync(join(dir, 'tool'), '#!/bin/sh\n') // the sh shim npm also writes; not runnable here
    writeFileSync(join(dir, 'tool.cmd'), EXE_SHIM.replace('claude-code\\bin\\claude.exe', 'tool\\tool.exe'))
    writeFileSync(join(dir, 'plain.exe'), '')
    writeFileSync(join(dir, 'odd.bat'), '@echo off\r\necho no\r\n')
    const env = { PATH: dir, PATHEXT: '.COM;.EXE;.BAT;.CMD' }

    assert.deepEqual(await locateOnWindows('tool', env), {
      file: join(dir, 'node_modules', '@anthropic-ai', 'tool', 'tool.exe'),
      prefix: [],
    })
    // The extension comes from PATHEXT, in its case; Windows does not care which.
    const plain = await locateOnWindows('plain', env)
    assert.equal(plain?.file.toLowerCase(), join(dir, 'plain.exe').toLowerCase())
    assert.deepEqual(plain?.prefix, [])
    assert.equal(await locateOnWindows('missing', env), null)
    await assert.rejects(locateOnWindows('odd', env), ReaderError)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
