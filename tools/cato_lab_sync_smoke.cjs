'use strict'
// Real IDE controller smoke, with two synthetic replicas in one local store; not cloud sync.
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
    let data = await page.data()
    assert.equal(data.serverRecords.length, 0, 'requires fresh experiment; never clears existing records implicitly')
    await page.callMethod('setDraft', { ...event({ device: 'a' }), detail: { value: '本机测试事项' } })
    await page.callMethod('createTask', event({ device: 'a' }))
    data = await page.data()
    const record = data.serverRecords[0].id
    await page.callMethod('sync', event({ device: 'b' }))
    await page.callMethod('toggleOnline', event({ device: 'b' }))
    await page.callMethod('editTask', event({ device: 'b', record }))
    await page.callMethod('editTitle', { detail: { value: '设备B的未发送修改' } })
    await page.callMethod('saveEdit')
    await page.callMethod('editTask', event({ device: 'a', record }))
    await page.callMethod('editTitle', { detail: { value: '设备A的新版本' } })
    await page.callMethod('saveEdit')
    await page.callMethod('toggleOnline', event({ device: 'b' }))
    data = await page.data()
    assert.ok(data.clients.find(item => item.id === 'b').conflict)
    assert.equal(data.serverRecords[0].title, '设备A的新版本')
    await page.callMethod('resolve', event({ device: 'b', choice: 'remote' }))
    assert.equal((await page.data()).clients.find(item => item.id === 'b').conflict, null)
    await page.callMethod('toggleOnline', event({ device: 'b' }))
    await page.callMethod('completeTask', event({ device: 'b', record }))
    await page.callMethod('sync', event({ device: 'b', loseack: 'yes' }))
    data = await page.data()
    const revision = data.revision
    assert.equal(data.serverRecords[0].completed, true)
    assert.equal(data.clients.find(item => item.id === 'b').queue.length, 1)
    await page.callMethod('sync', event({ device: 'b' }))
    data = await page.data()
    assert.equal(data.revision, revision)
    assert.equal(data.clients.find(item => item.id === 'b').queue.length, 0)
    await page.callMethod('permissionProbe')
    assert.match((await page.data()).permissionResult, /拒绝/)
    console.log(JSON.stringify({ passed: true, mode: 'real IDE Page.callMethod; only one local store', assertions: ['offline changes queue', 'concurrent rename creates explicit conflict', 'keep authority resolves conflict', 'lost acknowledgement retry applies once', 'other simulated identity denied'], limitations: 'Not real network, multiple devices, touch/keyboard, or production permissions.' }, null, 2))
  } finally { mini.disconnect() }
}
main().catch(error => { console.error(error.message); process.exitCode = 1 })
