'use strict'
// Reproduce the independently found P2 through real IDE controllers. Creates only local synthetic records.
const path = require('node:path')
const assert = require('node:assert/strict')
const [automatorDir, port] = process.argv.slice(2)
const event = dataset => ({ currentTarget: { dataset } })
async function main() {
  const Launcher = require(path.join(path.resolve(automatorDir), 'out/Launcher')).default
  const mini = await new Launcher().connectTool({ wsEndpoint: 'ws://127.0.0.1:' + port })
  try {
    assert.equal(await mini.evaluate(() => getApp().globalData.catoLabOffline), true)
    const page = await mini.reLaunch('/pages/cato-sync-contract/index')
    const stamp = Date.now().toString(36)
    const oldTitle = '本机审计旧草稿 ' + stamp
    const newTitle = '本机审计较新草稿须保留 ' + stamp
    await page.callMethod('setDraft', { ...event({ device: 'a' }), detail: { value: oldTitle } })
    await page.callMethod('armFailure'); await page.callMethod('createTask', event({ device: 'a' }))
    assert.equal((await page.data()).retryAvailable, true)
    await page.callMethod('setDraft', { ...event({ device: 'a' }), detail: { value: newTitle } })
    await page.callMethod('retrySave')
    let data = await page.data()
    assert.equal(data.drafts.a, newTitle, 'P2 regression: newer creation input cleared by old retry')
    const saved = data.serverRecords.find(item => item.title === oldTitle)
    assert.ok(saved, 'retry must keep the old submitted meaning, not silently save new input')
    await page.callMethod('editTask', event({ device: 'a', record: saved.id }))
    await page.callMethod('editTitle', { detail: { value: oldTitle + ' 修改' } })
    await page.callMethod('armFailure'); await page.callMethod('saveEdit')
    assert.equal((await page.data()).retryAvailable, true)
    await page.callMethod('editTitle', { detail: { value: newTitle + ' 修改' } })
    await page.callMethod('retrySave')
    data = await page.data()
    assert.ok(data.editing, 'P2 regression: newer editor closed by old retry')
    assert.equal(data.editing.title, newTitle + ' 修改')
    assert.equal(data.serverRecords.find(item => item.id === saved.id).title, oldTitle + ' 修改')
    assert.equal(data.retryAvailable, false)
    console.log(JSON.stringify({ passed: true, mode: 'real IDE Page.callMethod, local synthetic data', assertions: ['retry saves original create intent without clearing newer input', 'retry saves original edit intent without closing newer edit'], limitations: 'No physical touch/keyboard or real cloud validation.' }, null, 2))
  } finally { mini.disconnect() }
}
main().catch(error => { console.error(error.message); process.exitCode = 1 })
