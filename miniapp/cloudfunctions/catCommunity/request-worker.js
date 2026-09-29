'use strict'

const { parentPort, workerData, isMainThread } = require('node:worker_threads')
const { boundedClone } = require('./worker-env')

if (!isMainThread && parentPort) {
  ;(async () => {
    try {
      // The SDK is first loaded here, after Node has installed the private
      // per-invocation env. A prior SDK cache/token cannot survive this worker.
      const result = await require('./index').main(workerData.event, workerData.runtimeContext)
      parentPort.postMessage({ type: 'result', result: boundedClone(result, { maxBytes: 524288, maxNodes: 16384 }) })
    } catch (_) {
      // Never serialize stacks, SDK errors, input data or platform credentials.
      parentPort.postMessage({ type: 'result', result: {
        ok: false, error: { code: 'SERVICE_UNAVAILABLE', message: '服务暂时不可用，请稍后重试' }
      } })
    } finally { parentPort.close() }
  })()
}
