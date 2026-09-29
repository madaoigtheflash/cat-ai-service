'use strict'
// Offline structural audit. This is not a WeChat visual or cloud acceptance test.
const fs = require('node:fs')
const path = require('node:path')
const cp = require('node:child_process')
const assert = require('node:assert/strict')
const { createRequire } = require('node:module')
const vm = require('node:vm')
const root = path.resolve(process.argv[2] || path.join(__dirname, '..'))
const mini = path.join(root, 'miniapp')
const config = require(path.join(mini, 'config/cato-lab.js'))
const app = JSON.parse(fs.readFileSync(path.join(mini, 'app.json'), 'utf8'))
const errors = []
function check(name, fn) { try { fn() } catch (e) { errors.push({ check: name, error: e.message }) } }
check('offline config', () => { assert.equal(config.enabled, true); assert.match(config.entry, /^\/pages\/cato-[a-z-]+\/index$/); assert.ok(app.pages.includes(config.entry.slice(1))) })
const route = config.entry || '/pages/cato-lab/index'
const pageFile = path.join(mini, route.slice(1))
for (const ext of ['js','json','wxml','wxss']) check('page ' + ext, () => assert.ok(fs.existsSync(pageFile + '.' + ext)))
const js = fs.existsSync(pageFile + '.js') ? fs.readFileSync(pageFile + '.js', 'utf8') : ''
let page
check('controller load', () => {
  const state = {}
  const wx = { getStorageSync: key => state[key] || '', setStorageSync: (key, value) => { state[key] = value }, getStorageInfoSync: () => ({keys:Object.keys(state)}), getSystemInfoSync: () => ({windowWidth:375, windowHeight:750}), getWindowInfo: () => ({windowWidth:375, windowHeight:750}) }
  const ownRequire = createRequire(pageFile + '.js')
  global.wx = wx
  try { vm.runInNewContext(js, { require: ownRequire, module:{exports:{}}, exports:{}, Page: value => { page = value }, wx, getApp: () => ({ globalData:{ catoLabOffline:true, cloudReady:false } }), console, setTimeout,clearTimeout,setInterval,clearInterval,Date }, { filename:pageFile+'.js' }) }
  finally { delete global.wx }
  assert.ok(page && typeof page === 'object')
})
check('event handlers', () => {
  const wxml = fs.readFileSync(pageFile + '.wxml','utf8')
  const bindings = [...wxml.matchAll(/(?:bind|catch):?[\w-]+\s*=\s*["']([A-Za-z_$][\w$]*)["']/g)].map(m=>m[1])
  for (const handler of new Set(bindings)) assert.equal(typeof page[handler], 'function', 'missing handler ' + handler)
  assert.match(wxml, /模拟|实验|本地|离线/, 'visible experiment boundary missing')
})
check('shared UI styles', () => {
  const css = fs.readFileSync(pageFile + '.wxss','utf8')
  assert.match(css, /cato-lab\.wxss/, 'reuse shared accessible style')
})
check('review guide', () => assert.ok(fs.readFileSync(path.join(root,'docs/cato-lab/REVIEW.md'),'utf8').length > 300))
const files = cp.execFileSync('git',['diff','--name-only','0dde597b04b946c66169709376c99be8d803effe','HEAD'],{cwd:root,encoding:'utf8'}).trim().split(/\r?\n/)
for (const file of files.filter(f=> /\.(?:js|cjs)$/.test(f))) check('syntax ' + file, () => cp.execFileSync(process.execPath,['--check',path.join(root,file)],{stdio:'pipe'}))
for (const file of files.filter(f=> /\.json$/.test(f))) check('json ' + file, () => JSON.parse(fs.readFileSync(path.join(root,file),'utf8')))
const report = { variant:config.variant, structuralPass:errors.length===0, changedFiles:files.length, errors }
console.log(JSON.stringify(report,null,2))
process.exitCode = errors.length ? 1 : 0
