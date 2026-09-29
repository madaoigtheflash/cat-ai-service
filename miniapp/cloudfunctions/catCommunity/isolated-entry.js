'use strict'

const path = require('node:path')
const { Worker } = require('node:worker_threads')
const { prepareWorkerInvocation, boundedClone } = require('./worker-env')

const DEADLINE_MS = 55000
const MAX_WORKERS = 2
const FAILURE = Object.freeze({ ok: false, error: Object.freeze({ code: 'SERVICE_UNAVAILABLE', message: '服务暂时不可用，请稍后重试' }) })
const INVALID = Object.freeze({ ok: false, error: Object.freeze({ code: 'INVALID_CONTEXT', message: '无法确认本次请求，请重新进入后再试' }) })

// Injection is only a local test seam, never event-controlled. The exported main
// fixes the worker filename, maximum deadline and maximum active worker count.
function createIsolatedHandler({ WorkerClass = Worker, workerFile = path.join(__dirname, 'request-worker.js'),
  environment = () => process.env, parseContextFn, deadlineMs = DEADLINE_MS } = {}) {
  const deadline = Math.max(1, Math.min(DEADLINE_MS, Number(deadlineMs) || DEADLINE_MS))
  let active = 0
  return async function isolatedMain(event, runtimeContext) {
    if (active >= MAX_WORKERS) return FAILURE
    let invocation
    try { invocation = prepareWorkerInvocation(event, runtimeContext, environment(), parseContextFn) }
    catch (_) { return INVALID }
    active += 1
    try {
      return await new Promise(resolve => {
        let worker, timer, finished = false
        const swallow = () => {}
        function finish(result) {
          if (finished) return
          finished = true
          clearTimeout(timer)
          if (worker) {
            worker.removeListener('message', onMessage)
            worker.removeListener('error', onError)
            worker.removeListener('exit', onExit)
            worker.on('error', swallow)
            worker.unref()
            // Never await SDK background timers or a stuck request. Termination
            // is always requested on result, error, early exit and deadline.
            try {
              Promise.resolve(worker.terminate()).catch(swallow).finally(() => worker.removeListener('error', swallow))
            } catch (_) { worker.removeListener('error', swallow) }
          }
          resolve(result)
        }
        function onMessage(message) {
          try {
            if (!message || message.type !== 'result') return finish(FAILURE)
            const result = boundedClone(message.result, { maxBytes: 524288, maxNodes: 16384 })
            if (!result || typeof result.ok !== 'boolean') return finish(FAILURE)
            finish(result)
          } catch (_) { finish(FAILURE) }
        }
        function onError() { finish(FAILURE) }
        function onExit() { finish(FAILURE) }
        try {
          worker = new WorkerClass(workerFile, {
            env: invocation.env, workerData: { event: invocation.event, runtimeContext: invocation.runtimeContext },
            // No inherited NODE_OPTIONS/loaders/debuggers, shared environment or
            // stdout forwarding that could disclose SDK context/credentials.
            execArgv: [], stdout: true, stderr: true,
            resourceLimits: { maxOldGenerationSizeMb: 160, maxYoungGenerationSizeMb: 16, stackSizeMb: 4 }
          })
          if (worker.stdout) worker.stdout.on('data', swallow)
          if (worker.stderr) worker.stderr.on('data', swallow)
          worker.on('message', onMessage)
          worker.on('error', onError)
          worker.on('exit', onExit)
          timer = setTimeout(() => finish(FAILURE), deadline)
        } catch (_) { finish(FAILURE) }
      })
    } finally { active -= 1 }
  }
}

exports.main = createIsolatedHandler()
exports.createIsolatedHandler = createIsolatedHandler
exports.DEADLINE_MS = DEADLINE_MS
