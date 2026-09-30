// Local simulator smoke. Only synthetic local records; no cloud call or upload.
const fs = require('node:fs')
const path = require('node:path')
const assert = require('node:assert/strict')
const [automatorDir, port = '9480'] = process.argv.slice(2)
const Launcher = require(path.join(automatorDir, 'out/Launcher')).default
const out = path.resolve(__dirname, '../docs/companion-convergence/previews')
const keys = ['catai_mini_pets_v1','catai_mini_relationships_v1','catai_companion_messages_v1','catai_companion_actions_v1','catai_companion_composer_v1','catai_companion_sightings_v1']
const event = dataset => ({currentTarget:{dataset}})
async function main() {
  const mini = await new Launcher().connectTool({wsEndpoint:'ws://127.0.0.1:'+port})
  let backed = false
  try {
    await mini.evaluate(keys => {
      const app = getApp()
      const existing = wx.getStorageInfoSync().keys
      app.__convergenceSmokeBackup = keys.map(key => ({key, exists:existing.includes(key), value:wx.getStorageSync(key)}))
      app.__convergenceCloudReady = app.globalData.cloudReady
      app.globalData.cloudReady = false
      keys.forEach(key => wx.removeStorageSync(key))
    }, keys)
    backed = true
    fs.mkdirSync(out,{recursive:true})
    let page = await mini.reLaunch('/pages/home/index')
    await new Promise(resolve => setTimeout(resolve,500))
    await mini.screenshot({path:path.join(out,'01-home-empty.png')})
    await page.callMethod('onKeyboard',{detail:{height:290}})
    await mini.screenshot({path:path.join(out,'06-keyboard-height-simulated.png')})
    await page.callMethod('onKeyboard',{detail:{height:0}})
    for (const name of ['奶糖','团子']) {
      await page.callMethod('onInput',{detail:{value:'登记猫咪叫'+name}})
      await page.callMethod('send')
      const draft = await page.data('draft')
      assert.equal(draft.fields.name,name)
      if (name === '奶糖') await mini.screenshot({path:path.join(out,'02-confirm-cat.png')})
      await page.callMethod('confirmDraft')
      assert.equal((await page.data()).draft,null)
    }
    await page.callMethod('onInput',{detail:{value:'奶糖是团子的妈妈'}})
    await page.callMethod('send')
    assert.equal((await page.data('draft')).fields.fromRole,'mother')
    await mini.screenshot({path:path.join(out,'03-relationship.png')})
    await page.callMethod('confirmDraft')
    await page.callMethod('makeDraft',event({kind:'location'}))
    const d = await page.data('draft')
    // Synthetic coarse-location sample; not a device GPS reading.
    await mini.mockWxMethod('chooseLocation', { latitude:31.23, longitude:121.47, name:'演示公园', address:'' })
    await page.callMethod('choosePlace')
    await mini.restoreWxMethod('chooseLocation')
    await page.callMethod('onDraftInput',{currentTarget:{dataset:{field:'areaText'}},detail:{value:'演示公园周边'}})
    await page.callMethod('refresh')
    await page.callMethod('confirmDraft')
    page = await mini.navigateTo('/pages/companion-data/index?section=history')
    await new Promise(resolve => setTimeout(resolve,300))
    assert.equal(await page.data('counts.pets'),2)
    assert.equal(await page.data('counts.relationships'),1)
    await mini.screenshot({path:path.join(out,'04-history.png')})
    page = await mini.navigateTo('/pages/companion-map/index')
    await new Promise(resolve => setTimeout(resolve,800))
    await mini.screenshot({path:path.join(out,'05-map.png')})
    const system = await mini.systemInfo()
    const report = {passed:true, width:system.windowWidth,height:system.windowHeight,fontSizeSetting:system.fontSizeSetting,
      checks:['two confirmed cats','mother-to-child relationship','coarse synthetic location','own history and map','keyboard height 290px state (not physical keyboard)'],
      cloudCalls:0, synthetic:true, limitations:['no physical keyboard or large-font/other-width verification','no production upload or model request']}
    fs.writeFileSync(path.join(out,'native-report.json'),JSON.stringify(report,null,2))
    console.log(JSON.stringify(report))
  } finally {
    if (backed) await mini.evaluate(() => {
      const app = getApp()
      app.__convergenceSmokeBackup.forEach(item => item.exists ? wx.setStorageSync(item.key,item.value) : wx.removeStorageSync(item.key))
      app.globalData.cloudReady = app.__convergenceCloudReady
      delete app.__convergenceSmokeBackup; delete app.__convergenceCloudReady
    })
    mini.disconnect()
  }
}
main().catch(error => {console.error(error.message);process.exitCode=1})
