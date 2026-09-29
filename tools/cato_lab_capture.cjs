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
  let mini
  for (let attempt = 0; attempt < 12; attempt += 1) {
    try { mini = await new Launcher().connectTool({wsEndpoint:'ws://127.0.0.1:'+port}); break }
    catch (error) { if (attempt === 11) throw error; await new Promise(resolve => setTimeout(resolve, 500)) }
  }
  try {
    let state
    for (let attempt = 0; attempt < 16; attempt += 1) {
      state = await mini.evaluate(() => {
        const app = getApp()
        return app && app.globalData ? { offline:app.globalData.catoLabOffline, cloudReady:app.globalData.cloudReady } : null
      })
      if (state) break
      await new Promise(resolve => setTimeout(resolve, 500))
    }
    assert.ok(state, 'app did not launch; inspect WeChat compile errors')
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
