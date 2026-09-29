'use strict'

const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const test = require('node:test')

const MINIAPP_ROOT = path.resolve(__dirname, '..')
const read = relativePath => fs.readFileSync(path.join(MINIAPP_ROOT, relativePath), 'utf8')

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

function cssRule(source, selector) {
  const matches = [...source.matchAll(new RegExp(`${escapeRegExp(selector)}\\s*\\{([^{}]*)\\}`, 'g'))]
  assert.ok(matches.length, `missing CSS rule: ${selector}`)
  return matches[0][1]
}

function declaration(rule, property) {
  const match = rule.match(new RegExp(`(?:^|;)\\s*${escapeRegExp(property)}\\s*:\\s*([^;]+)`, 'i'))
  return match ? match[1].trim() : null
}

function assertRpxAtLeast(source, selector, property, minimum) {
  const value = declaration(cssRule(source, selector), property)
  assert.ok(value, `${selector} must declare ${property}`)
  const match = value.match(/^(\d+(?:\.\d+)?)rpx$/)
  assert.ok(match, `${selector} ${property} must use a plain rpx value, got ${value}`)
  assert.ok(Number(match[1]) >= minimum, `${selector} ${property} must be at least ${minimum}rpx`)
}

test('pets header can reflow without rigid action buttons squeezing the title', () => {
  const wxml = read('pages/pets/index.wxml')
  const wxss = read('pages/pets/index.wxss')
  const header = cssRule(wxss, '.pets-header')
  const actions = cssRule(wxss, '.header-actions')

  assert.match(wxml, /class="pets-heading"/)
  assert.match(cssRule(wxss, '.pets-heading'), /min-width:\s*0/)
  assert.ok(
    declaration(header, 'flex-direction') === 'column' || declaration(header, 'flex-wrap') === 'wrap',
    '.pets-header must stack or wrap when horizontal space is limited'
  )
  assert.doesNotMatch(actions, /(?:^|;)\s*flex:\s*none(?:;|$)/)

  for (const selector of ['.network-button', '.add-button']) {
    const button = cssRule(wxss, selector)
    assert.equal(declaration(button, 'min-width'), '0', `${selector} must be allowed to shrink inside the action layout`)
    assert.equal(declaration(button, 'width'), '0', `${selector} must let flex growth determine its share of the row`)
    assert.equal(declaration(button, 'flex'), '1 1 0', `${selector} must split the action row without overflowing narrow phones`)
  }
})

test('important pet names wrap instead of being truncated', () => {
  const targets = [
    [read('pages/garden/index.wxss'), '.compact-cat-name'],
    [read('pages/pets/index.wxss'), '.pet-name']
  ]

  for (const [source, selector] of targets) {
    const rule = cssRule(source, selector)
    assert.match(rule, /word-break:\s*break-word/)
    assert.doesNotMatch(rule, /white-space:\s*nowrap/)
    assert.doesNotMatch(rule, /text-overflow:\s*ellipsis/)
    assert.doesNotMatch(rule, /(?:^|;)\s*overflow:\s*hidden/)
  }
})

test('home compact card keeps flexible layout on narrow phones', () => {
  const wxss = read('pages/garden/index.wxss')
  const narrowBlock = wxss.match(/@media\s*\(max-width:\s*360px\)\s*\{([\s\S]*)\}\s*$/)

  assert.ok(narrowBlock, 'home must provide a narrow-phone layout contract')
  assert.match(narrowBlock[1], /\.action-grid\s*\{[^{}]*grid-template-columns:\s*minmax\(0,\s*1fr\)/)
  assert.match(narrowBlock[1], /\.house-quick-action\s*\{[^{}]*font-size:\s*19rpx/)
  assert.match(cssRule(wxss, '.compact-context'), /padding:\s*24rpx/)
  assert.match(cssRule(wxss, '.compact-cat-row'), /gap:\s*16rpx/)
  assert.equal(declaration(cssRule(wxss, '.compact-cat-copy'), 'min-width'), '0')
})

test('identify upload copy can grow and long feature labels can break safely', () => {
  const wxss = read('pages/identify/index.wxss')
  const upload = cssRule(wxss, '.upload-card')
  const uploadEmpty = cssRule(wxss, '.upload-empty')
  const feature = cssRule(wxss, '.feature-chip')

  assert.match(upload, /min-height:\s*\d+rpx/)
  assert.equal(declaration(upload, 'height'), null, 'empty upload card must not use a fixed height')
  assert.match(uploadEmpty, /min-height:\s*\d+rpx/)
  assert.equal(declaration(uploadEmpty, 'height'), null, 'upload instructions must be able to grow with large text')
  assert.equal(declaration(feature, 'max-width'), '100%')
  assert.match(feature, /word-break:\s*break-word/)
  assert.doesNotMatch(feature, /white-space:\s*nowrap/)
})

test('audited compact actions keep at least 88rpx touch targets', () => {
  const home = read('pages/garden/index.wxss')
  const global = read('app.wxss')
  const identify = read('pages/identify/index.wxss')
  const pets = read('pages/pets/index.wxss')

  assertRpxAtLeast(home, '.house-quick-action', 'min-height', 88)
  assertRpxAtLeast(home, '.compact-switch', 'min-height', 88)
  assertRpxAtLeast(home, '.compact-switch', 'min-width', 88)
  assertRpxAtLeast(global, '.section-link', 'min-height', 88)
  assertRpxAtLeast(global, '.section-link', 'min-width', 88)
  assertRpxAtLeast(identify, '.notice-link', 'min-height', 88)
  assertRpxAtLeast(identify, '.notice-link', 'min-width', 88)
  assertRpxAtLeast(pets, '.more', 'min-height', 88)
  assertRpxAtLeast(pets, '.more', 'min-width', 88)
})

test('settings cloud test action clears the status divider and lets its label grow', () => {
  const wxss = read('pages/settings/index.wxss')
  const actions = cssRule(wxss, '.settings-actions')
  const button = cssRule(wxss, '.settings-button')

  assertRpxAtLeast(wxss, '.settings-actions', 'margin-top', 24)
  assert.equal(declaration(button, 'margin'), '0')
  assert.equal(declaration(button, 'min-width'), '0')
  assert.match(button, /white-space:\s*normal/)
  assert.match(button, /word-break:\s*break-word/)
  assert.doesNotMatch(actions, /(?:^|;)\s*position:\s*absolute/)
})

test('global empty title has one canonical definition', () => {
  const wxss = read('app.wxss')
  const definitions = wxss.match(/\.empty-title\s*\{/g) || []

  assert.equal(definitions.length, 1)
})

test('pet detail keeps names and stat values readable without ellipsis', () => {
  const wxml = read('pages/pet-detail/index.wxml')
  const wxss = read('pages/pet-detail/index.wxss')
  const statValue = cssRule(wxss, '.stat-value')

  assert.match(wxml, /class="detail-name-text"/)
  assert.match(wxml, /class="stat-value stat-value-detail"/)
  assert.match(cssRule(wxss, '.detail-name-text'), /word-break:\s*break-word/)
  assert.match(cssRule(wxss, '.detail-breed'), /word-break:\s*break-word/)
  assert.match(statValue, /max-width:\s*100%/)
  assert.match(statValue, /word-break:\s*break-word/)
  assert.doesNotMatch(statValue, /white-space:\s*nowrap|text-overflow:\s*ellipsis|overflow:\s*hidden/)
  assert.doesNotMatch(wxss, /\.stat-value\.small\s*\{/)
})

test('relationship network uses a bounded dynamic stage and non-truncated nodes', () => {
  const wxml = read('pages/relationships/index.wxml')
  const wxss = read('pages/relationships/index.wxss')
  const stage = cssRule(wxss, '.network-stage')

  assert.match(wxml, /class="network-stage"[^>]*style="height:\s*\{\{stageHeight\}\}rpx"/)
  assert.equal(declaration(stage, 'max-width'), '100%')
  assert.equal(declaration(stage, 'min-height'), '300rpx')
  assert.equal(declaration(stage, 'height'), null, 'network height must come from the computed row layout')
  assert.equal(declaration(stage, 'margin-left'), 'auto')
  assert.equal(declaration(stage, 'margin-right'), 'auto')
  assertRpxAtLeast(wxss, '.network-node', 'min-height', 188)

  for (const selector of ['.node-name', '.node-relation']) {
    const nodeText = cssRule(wxss, selector)
    assert.match(nodeText, /white-space:\s*normal/)
    assert.match(nodeText, /word-break:\s*(?:break-word|break-all)/)
    assert.doesNotMatch(nodeText, /text-overflow:\s*ellipsis|overflow:\s*hidden/)
  }

  assertRpxAtLeast(wxss, '.relation-edit, .relation-remove', 'min-height', 88)
})
