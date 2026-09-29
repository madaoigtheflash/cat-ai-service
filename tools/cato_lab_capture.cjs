'use strict'
// Uses an existing project-owned automator install; no dependency installation.
// Usage: node tools/cato_lab_capture.cjs <automator-dir> <port> <variant> <output.png>
const path = require('node:path')
const fs = require('node:fs')
const assert = require('node:assert/strict')
const [automatorDir, port, variant, output] = process.argv.slice(2)
if (!automatorDir || !/^\d+$/.test(port || '') || !/^[a-z-]+$/.test(variant || '') || !output) throw Error('arguments required')
async function main() {
  const Launcher = require(path.join(path.resolve(automatorDir),'out/Launcher')).default
  const mini = await new Launcher().connectTool({wsEndpoint:'ws://127.0.0.1:'+port})
  try {
    const state = await mini.evaluate(() => ({ offline:getApp().globalData.catoLabOffline, cloudReady:getApp().globalData.cloudReady }))
    assert.equal(state.offline,true,'not the offline lab'); assert.equal(state.cloudReady,false)
    const entry = variant==='baseline'?'/pages/cato-lab/index':'/pages/cato-'+variant+'/index'
    const page = await mini.reLaunch(entry)
    assert.equal(page.path, entry.slice(1))
    const system = await mini.systemInfo()
    const data = await page.data()
    fs.mkdirSync(path.dirname(path.resolve(output)), {recursive:true})
    await mini.screenshot({path:path.resolve(output)})
    console.log(JSON.stringify({variant,entry,offline:state.offline,width:system.windowWidth,height:system.windowHeight,fontSizeSetting:system.fontSizeSetting,SDKVersion:system.SDKVersion,pageDataKeys:Object.keys(data),screenshot:path.resolve(output)},null,2))
  } finally { mini.disconnect() }
}
main().catch(e=>{ console.error(e.message); process.exitCode=1 })
