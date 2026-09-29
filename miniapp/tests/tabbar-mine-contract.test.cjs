'use strict'

// N1 + N3 契约：自定义 tabBar 五槽位（中间凸起识猫），identify 转为普通页，
// 每个 tab 页必须在 onShow 同步 selected，否则图标会停留在上一个 tab。
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const test = require('node:test')

const MINIAPP_ROOT = path.resolve(__dirname, '..')
const read = relativePath => fs.readFileSync(path.join(MINIAPP_ROOT, relativePath), 'utf8')

test('custom tabBar keeps four real tabs and moves identify out of the tab list', () => {
  const appConfig = JSON.parse(read('app.json'))
  assert.equal(appConfig.tabBar.custom, true)
  const paths = appConfig.tabBar.list.map(item => item.pagePath)
  assert.deepEqual(paths, [
    'pages/home/index',
    'pages/pets/index',
    'pages/social/index',
    'pages/mine/index'
  ])
  assert.ok(!paths.includes('pages/identify/index'), 'identify must be a plain page reached via the raised middle button')
  assert.ok(appConfig.pages.includes('pages/identify/index'))
  assert.ok(appConfig.pages.includes('pages/mine/index'))
})

test('custom tab bar component exists with a raised identify action', () => {
  const js = read('custom-tab-bar/index.js')
  const wxml = read('custom-tab-bar/index.wxml')
  const wxss = read('custom-tab-bar/index.wxss')

  assert.match(js, /wx\.switchTab/)
  assert.match(js, /wx\.navigateTo\(\{\s*url:\s*'\/pages\/identify\/index'\s*\}\)/)
  assert.match(js, /components\/icon\/icons/)
  assert.match(wxml, /aria-label="拍照识猫"/)
  // Raised middle button must clear the bar and every tab label stays tappable.
  assert.match(wxss, /\.mid-button\s*\{[^}]*margin-top:\s*-/)
  assert.match(wxss, /env\(safe-area-inset-bottom\)/)
})

test('every tab page syncs the custom tab bar selection on show', () => {
  const expectations = [
    ['pages/home/index.js', 0],
    ['pages/pets/index.js', 1],
    ['pages/social/index.js', 2],
    ['pages/mine/index.js', 3]
  ]
  for (const [file, selected] of expectations) {
    const source = read(file)
    assert.match(source, /getTabBar\(\)\.setData\(\{\s*selected:\s*\d\s*\}\)/, `${file} must sync tabBar selected`)
    assert.ok(
      source.includes(`selected: ${selected}`),
      `${file} must select tab index ${selected}`
    )
  }
  assert.match(read('pages/home/index.js'), /goIdentify\(\)\s*\{\s*wx\.navigateTo/, 'home must open identify via navigateTo now that it is not a tab')
})

test('mine page aggregates personal assets with honest empty states', () => {
  const js = read('pages/mine/index.js')
  const wxml = read('pages/mine/index.wxml')

  assert.match(js, /storage\.listPets\(\)/)
  assert.match(js, /showcase\.refresh\(\)/)
  assert.match(js, /online\.bootstrap\(\)/)
  assert.match(js, /online\.listWorkspace/)
  assert.match(js, /item\.isMine/, 'only the owner sightings count toward the asset tiles')
  assert.match(wxml, /喜欢的猫片/)
  assert.match(wxml, /我的目击/)
  assert.match(wxml, /猫咪档案/)
  assert.match(wxml, /favoriteCount >= 0 \? favoriteCount : '—'/, 'unsynced favorites must show a placeholder, never a fabricated count')
  // Subscription management stays a disabled placeholder until template IDs exist (I2).
  assert.match(wxml, /订阅消息管理/)
  assert.match(wxml, /aria-disabled="true"/)
})
