const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const { createStore, readLocalCatCards } = require('../services/cato-lab')
test('实验存储只清理自己的命名空间，且不会吞掉写入失败', () => {
  const values = { catai_mini_pets_v1: [{ id: 'private' }], 'catai_cato_lab_v1:other:data': 'other' }
  const driver = { getStorageSync: key => values[key], setStorageSync: (key, value) => { values[key] = value }, removeStorageSync: key => { delete values[key] }, getStorageInfoSync: () => ({ keys: Object.keys(values) }) }
  const store = createStore('test', driver)
  assert.deepEqual(store.load('data', []), [])
  const input = [{ id: 1 }]; store.save('data', input); input[0].id = 99
  assert.equal(store.load('data', [])[0].id, 1)
  store.reset(); assert.equal(Object.keys(values).length, 2)
  assert.throws(() => createStore('../escape', driver))
  assert.throws(() => createStore('test', { setStorageSync() { throw Error('quota') } }).save('data', {}), /quota/)
})
test('档案导入只投影ID和名字，不导入健康资料或照片', () => {
  global.wx = { getStorageSync: () => [{ id: 'a', name: '长名字', medical: ['private'], imagePath: 'private' }] }
  assert.deepEqual(readLocalCatCards(), [{ id: 'a', name: '长名字' }]); delete global.wx
})
test('实验启动不调用云初始化、不写原有设置', () => {
  let app; global.App = value => { app = value }
  global.wx = { cloud: { init() { throw Error('cloud called') } }, setStorageSync() { throw Error('original settings changed') } }
  require('../app'); app.onLaunch()
  assert.equal(app.globalData.catoLabOffline, true); assert.equal(app.globalData.cloudReady, false)
  delete global.wx; delete global.App
})
test('生产云传输在实验中被拒绝', () => {
  global.getApp = () => ({ globalData: { catoLabOffline: true } })
  assert.throws(() => require('../services/cato-lab-guard')(), /不连接生产云端/)
  delete global.getApp
})
test('入口存在、默认游客项目和触控安全区', () => {
  const root = path.resolve(__dirname, '..')
  const app = JSON.parse(fs.readFileSync(path.join(root, 'app.json'), 'utf8'))
  assert.equal(app.pages[0], 'pages/cato-lab/index')
  assert.equal(JSON.parse(fs.readFileSync(path.join(root, 'project.config.json'), 'utf8')).appid, 'touristappid')
  const css = fs.readFileSync(path.join(root, 'styles/cato-lab.wxss'), 'utf8')
  assert.match(css, /min-height: 88rpx/); assert.match(css, /safe-area-inset-bottom/)
})
