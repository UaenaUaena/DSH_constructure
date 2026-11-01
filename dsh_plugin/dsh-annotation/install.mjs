#!/usr/bin/env node
/**
 * Install (or update) this bundle into a DSH profile on any platform.
 *
 *   node install.mjs                    # install into $DSH_PROFILE, else "web"
 *   node install.mjs --profile desktop  # install into another profile
 *   node install.mjs --dry-run          # pack and print the command, change nothing
 *
 * The package is plain ESM with no dependencies and no build step, so one
 * tarball installs everywhere DSH runs. `dsh plugin add` copies the tarball into
 * the profile's package store and selects the bundle as a profile layer; the
 * directory this script lives in is not needed afterwards.
 *
 * Written in Node rather than bash or PowerShell so the same file runs in a
 * Windows terminal, a POSIX shell, and CI, and so argv quoting never depends on
 * a shell's rules.
 */

import { spawnSync } from 'node:child_process'
import { copyFileSync, existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const argv = process.argv.slice(2)

/** Read `--profile <name>` / `--profile=<name>` and `--dry-run` from the arguments. */
function parseArgs(args) {
  let profile
  let dryRun = false
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index]
    if (arg === '--dry-run') dryRun = true
    else if (arg === '--profile') {
      profile = args[index + 1]
      index += 1
    } else if (arg.startsWith('--profile=')) profile = arg.slice('--profile='.length)
    else throw new Error(`unexpected argument ${JSON.stringify(arg)}`)
  }
  if (profile === '') throw new Error('--profile needs a name')
  return { profile, dryRun }
}

/**
 * Quote one argument for a Windows command line.
 *
 * `spawn` with `shell: false` cannot start `dsh.cmd`/`pnpm.cmd` on current Node
 * (a `.cmd` file needs `cmd.exe`), and `shell: true` does not quote arguments,
 * so a workspace path with a space would break. This is the CommandLineToArgvW
 * escaping rule, applied to everything after the executable.
 * @param arg - one raw argument.
 * @returns the argument as it must appear on the command line.
 */
export function quoteWin(arg) {
  if (arg === '') return '""'
  if (!/[\s"]/.test(arg)) return arg
  let out = '"'
  let backslashes = 0
  for (const character of arg) {
    if (character === '\\') {
      backslashes += 1
      continue
    }
    if (character === '"') {
      out += `${'\\'.repeat(backslashes * 2 + 1)}"`
      backslashes = 0
      continue
    }
    out += `${'\\'.repeat(backslashes)}${character}`
    backslashes = 0
  }
  return `${out}${'\\'.repeat(backslashes * 2)}"`
}

/**
 * Spawn one command the way this platform can actually start it.
 * On Windows the executable may be a `.cmd` shim, which only `cmd.exe` runs;
 * arguments are pre-quoted and passed verbatim for that case.
 * @param command - executable or shim name.
 * @param args - arguments, unquoted.
 * @param options - spawn options.
 * @returns the spawn result.
 */
export function spawnCommand(command, args, options = {}) {
  if (process.platform !== 'win32') return spawnSync(command, args, options)
  const line = [command, ...args].map(quoteWin).join(' ')
  const comspec = process.env.ComSpec ?? 'cmd.exe'
  return spawnSync(comspec, ['/d', '/s', '/c', line], { ...options, windowsVerbatimArguments: true })
}

/**
 * Run one command, trying each candidate spelling until one exists.
 * @param candidates - argv arrays such as `['pnpm', '-s', 'dsh']`.
 * @param options - spawn options; `stdio` defaults to captured output.
 * @returns the argv that ran and its result.
 * @throws when no candidate exists on this machine.
 */
function runFirst(candidates, options = {}) {
  const failures = []
  for (const candidate of candidates) {
    const [command, ...args] = candidate
    const result = spawnCommand(command, [...args, ...(options.args ?? [])], {
      cwd: options.cwd ?? process.cwd(),
      encoding: 'utf8',
      stdio: options.stdio ?? 'pipe',
      shell: false,
    })
    if (result.error?.code === 'ENOENT') {
      failures.push(command)
      continue
    }
    return { candidate, result }
  }
  throw new Error(`找不到可执行文件：${[...new Set(failures)].join(', ')}`)
}

/** Directories that might be a DSH source checkout, nearest first. */
function checkoutCandidates() {
  const roots = []
  let current = here
  for (let depth = 0; depth < 4; depth += 1) {
    roots.push(current)
    const parent = resolve(current, '..')
    if (parent === current) break
    current = parent
  }
  return roots
}

/** Whether a directory is a DSH checkout exposing the `dsh` script. */
function isCheckout(root) {
  const manifestPath = join(root, 'package.json')
  if (!existsSync(manifestPath)) return false
  try {
    return JSON.parse(readFileSync(manifestPath, 'utf8'))?.scripts?.dsh !== undefined
  } catch {
    return false
  }
}

/**
 * The argv prefix that runs the `dsh` CLI here, or undefined.
 * Always returns `{ candidate, cwd }` so callers never branch on the form.
 * `dsh` on PATH wins; otherwise a source checkout at any nearby depth reaches
 * the same command through its `dsh` script, so a clone works wherever it lands.
 */
function findDsh() {
  const direct = process.platform === 'win32' ? [['dsh'], ['dsh.cmd']] : [['dsh']]
  for (const candidate of direct) {
    const probe = spawnCommand(candidate[0], ['--version'], { encoding: 'utf8', stdio: 'pipe' })
    if (probe.error === undefined && probe.status === 0) return { candidate }
  }
  const pnpm = process.platform === 'win32' ? [['pnpm', '-s', 'dsh'], ['pnpm.cmd', '-s', 'dsh']] : [['pnpm', '-s', 'dsh']]
  for (const root of checkoutCandidates()) {
    if (!isCheckout(root)) continue
    for (const candidate of pnpm) {
      const probe = spawnCommand(candidate[0], [...candidate.slice(1), '--version'], { cwd: root, encoding: 'utf8', stdio: 'pipe' })
      if (probe.error === undefined && probe.status === 0) return { candidate, cwd: root }
    }
  }
  return undefined
}

/** Pack this package into a fresh temporary directory and return the tarball path. */
function pack(destination) {
  const candidates = process.platform === 'win32'
    ? [['pnpm'], ['pnpm.cmd'], ['npm'], ['npm.cmd']]
    : [['pnpm'], ['npm']]
  const { candidate, result } = runFirst(candidates, {
    args: ['--dir', here, 'pack', '--pack-destination', destination, '--silent'],
  })
  if (result.status !== 0) {
    // `npm pack` has no `--dir`; retry from the package directory itself.
    const retry = runFirst(candidates, { cwd: here, args: ['pack', '--pack-destination', destination, '--silent'] })
    if (retry.result.status !== 0) {
      throw new Error(`${candidate[0]} pack 失败：${(retry.result.stderr ?? '').trim()}`)
    }
  }
  const tarball = readdirSync(destination).find(name => name.endsWith('.tgz'))
  if (tarball === undefined) throw new Error('打包没有产出 .tgz')
  return join(destination, tarball)
}

function main() {
  const { profile, dryRun } = parseArgs(argv)
  const target = profile ?? process.env.DSH_PROFILE ?? 'web'

  const dsh = findDsh()
  const work = mkdtempSync(join(tmpdir(), 'dsh-annotation-pack-'))
  let keepWork = false
  try {
    process.stdout.write(`install: 打包 ${here}\n`)
    const tarball = pack(work)
    const args = ['plugin', '--profile', target, 'add', tarball]

    // Nothing below this line writes into the package directory; `--dry-run`
    // also stops here, so a dry run never leaves an artifact behind.
    if (dryRun) {
      process.stdout.write(`install: tarball = ${tarball}\n`)
      process.stdout.write(`install: profile = ${target}\n`)
      process.stdout.write(`install: dry run, 未执行：${[...(dsh?.candidate ?? ['dsh']), ...args].join(' ')}\n`)
      return
    }

    if (dsh === undefined) {
      // No CLI to call: keep a usable artifact next to the package and name the commands.
      let orphan = tarball
      try {
        orphan = join(here, basename(tarball))
        copyFileSync(tarball, orphan)
      } catch {
        // A read-only package directory keeps the artifact where it was packed.
        keepWork = true
      }
      process.stderr.write([
        'install: 找不到 dsh 命令，未安装。包已打好：',
        `  ${orphan}`,
        '',
        '在 DSH 所在目录（或 dsh 已在 PATH 上时直接）执行：',
        `  pnpm dsh plugin --profile ${target} add "${orphan}"`,
        `  dsh plugin --profile ${target} add "${orphan}"`,
        '',
        '注意 dsh plugin 内部会用 pnpm 安装包；机器上没有 pnpm 时先装：npm i -g pnpm',
        '',
      ].join('\n'))
      process.exitCode = 1
      return
    }

    process.stdout.write(`install: tarball = ${tarball}\n`)
    process.stdout.write(`install: profile = ${target}\n`)
    const { candidate, result } = runFirst([dsh.candidate], { args, cwd: dsh.cwd, stdio: 'inherit' })
    if (result.status !== 0) {
      throw new Error(`${[...candidate, ...args].join(' ')} 失败（退出码 ${result.status}）`)
    }
    process.stdout.write([
      '',
      'install: 完成。接下来：',
      '  1. 重启 dsh（Host 侧换模块代际）',
      '  2. 刷新页面',
      '  3. 在对话正文里选一个词 → 「解释「词」」/ 右键 / Alt+Shift+E',
      '',
      `排错：dsh plugin --profile ${target} why @local/dsh-annotation`,
      `     包是否在 profile 的 dsh.profile.bundles 里：<DSH_HOME>/profiles/${target}/package.json`,
      '',
    ].join('\n'))
  } finally {
    if (!keepWork) rmSync(work, { recursive: true, force: true })
  }
}

const invokedDirectly = process.argv[1] !== undefined
  && resolve(process.argv[1]) === fileURLToPath(import.meta.url)

try {
  if (invokedDirectly) main()
} catch (error) {
  process.stderr.write(`install: ${error instanceof Error ? error.message : String(error)}\n`)
  process.exitCode = 1
}
