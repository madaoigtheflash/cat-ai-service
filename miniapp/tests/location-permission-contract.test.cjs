const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')

const MINIAPP_ROOT = path.join(__dirname, '..')

function read(relativePath) {
  return fs.readFileSync(path.join(MINIAPP_ROOT, relativePath), 'utf8')
}

function listFiles(directory, extensions) {
  const output = []
  fs.readdirSync(directory, { withFileTypes: true }).forEach(entry => {
    const absolute = path.join(directory, entry.name)
    if (entry.isDirectory()) output.push(...listFiles(absolute, extensions))
    else if (extensions.includes(path.extname(entry.name))) output.push(absolute)
  })
  return output
}

test('location permission declaration matches the only production location API', () => {
  const appConfig = JSON.parse(read('app.json'))
  assert.deepEqual(appConfig.requiredPrivateInfos, ['chooseLocation'])
  assert.deepEqual(Object.keys(appConfig.permission || {}), ['scope.userLocation'])
  assert.match(appConfig.permission['scope.userLocation'].desc, /主动选择/)
  assert.match(appConfig.permission['scope.userLocation'].desc, /模糊热区/)
  assert.equal(Object.prototype.hasOwnProperty.call(appConfig, 'requiredBackgroundModes'), false)

  const productionFiles = [
    ...listFiles(path.join(MINIAPP_ROOT, 'pages'), ['.js']),
    ...listFiles(path.join(MINIAPP_ROOT, 'services'), ['.js'])
  ]
  const productionSource = productionFiles.map(file => fs.readFileSync(file, 'utf8')).join('\n')
  const chooseCalls = productionSource.match(/wx\.chooseLocation\s*\(/g) || []
  assert.equal(chooseCalls.length, 1)
  ;[
    'getLocation',
    'getFuzzyLocation',
    'choosePoi',
    'startLocationUpdate',
    'startLocationUpdateBackground',
    'onLocationChange'
  ].forEach(api => assert.doesNotMatch(productionSource, new RegExp(`wx\\.${api}\\s*\\(`)))
})

test('location UI requires an explicit tap and the heat map never shows current location', () => {
  const uploadPage = read(path.join('pages', 'online', 'index.wxml'))
  const uploadLogic = read(path.join('pages', 'online', 'index.js'))
  const mapPage = read(path.join('pages', 'community-insights', 'index.wxml'))

  assert.match(uploadPage, /bindtap="chooseLocation"/)
  assert.match(uploadPage, /本次目击地点（可跳过）/)
  assert.match(uploadPage, /不会自动或持续定位/)
  assert.match(uploadLogic, /source:\s*'map'/)
  assert.doesNotMatch(uploadLogic, /'draft\.areaText':\s*String\(result\.(?:name|address)/)
  assert.match(mapPage, /show-location="\{\{false\}\}"/)
  assert.match(mapPage, /不获取你的当前位置/)
})
