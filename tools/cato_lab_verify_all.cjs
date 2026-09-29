'use strict'
// Read-only final verifier. Runs offline tests/compilers; never pushes, deploys or resets stores.
const fs = require('node:fs')
const path = require('node:path')
const { spawnSync } = require('node:child_process')
const root = path.resolve(process.argv[2] || 'C:/Users/13622/.codex/worktrees')
const variants = ['capture','care-planner','house-goals','focus','expenses','journal','social-followup','companion','sync-contract','encounter-review','relationship-observe','knowledge-action']
function run(command, args, cwd) {
  const result = spawnSync(command, args, { cwd, encoding: 'utf8', maxBuffer: 8 * 1024 * 1024, windowsHide: true })
  return { status: result.status, output: (result.stdout || '') + (result.stderr || ''), error: result.error && result.error.message }
}
const rows = variants.map(variant => {
  const cwd = path.join(root, 'cato-' + variant, 'cat-ai-service')
  const branch = run('git', ['branch','--show-current'], cwd).output.trim()
  const sha = run('git', ['rev-parse','HEAD'], cwd).output.trim()
  const dirty = run('git', ['status','--porcelain'], cwd)
  const files = fs.readdirSync(path.join(cwd, 'miniapp/tests')).filter(name => /^cato-.*\.test\.cjs$/.test(name)).map(name => path.join(cwd, 'miniapp/tests', name))
  const tests = run(process.execPath, ['--test','--test-reporter=tap',...files], cwd)
  const allFiles = fs.readdirSync(path.join(cwd, 'miniapp/tests')).filter(name => /\.test\.cjs$/.test(name)).map(name => path.join(cwd, 'miniapp/tests', name))
  const fullRun = run(process.execPath, ['--test','--test-reporter=tap',...allFiles], cwd)
  const check = run(process.execPath, [path.join(__dirname,'cato_lab_check.cjs'),cwd], cwd)
  let structure
  try { structure = JSON.parse(check.output) } catch (_) { structure = { parseError: check.output.slice(-2500) } }
  const count = expression => Number((tests.output.match(expression) || [])[1] || 0)
  const result = { variant, branch, sha, clean: dirty.status === 0 && !dirty.output.trim(), tests: count(/^# tests (\d+)$/m), passed: count(/^# pass (\d+)$/m), failed: count(/^# fail (\d+)$/m), skipped: count(/^# skipped (\d+)$/m), structure }
  const fullCount = expression => Number((fullRun.output.match(expression) || [])[1] || 0)
  result.fullRegression = { tests: fullCount(/^# tests (\d+)$/m), passed: fullCount(/^# pass (\d+)$/m), failed: fullCount(/^# fail (\d+)$/m), skipped: fullCount(/^# skipped (\d+)$/m) }
  result.ok = branch === 'codex/cato-lab/' + variant && result.clean && tests.status === 0 && result.tests > 5 && result.failed === 0 && result.skipped === 0 && check.status === 0 && structure.nativeWxmlCompiled === true && fullRun.status === 0 && result.fullRegression.tests > 339 && result.fullRegression.failed === 0 && result.fullRegression.skipped === 0
  if (!result.ok) result.diagnostics = { dirty: dirty.output, tests: tests.output.slice(-2500), fullRegression: fullRun.output.slice(-2500), check: check.output.slice(-2500) }
  return result
})
console.log(JSON.stringify({ verifiedAt: new Date().toISOString(), scope: 'Offline unit/controller tests, route/bindings, native WXML compiler, branch SHA and clean worktree. Not cloud, device, typography or integration approval.', allPassed: rows.every(row => row.ok), rows }, null, 2))
if (rows.some(row => !row.ok)) process.exitCode = 1
