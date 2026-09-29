'use strict'

const fs = require('node:fs')
const path = require('node:path')
const assert = require('node:assert/strict')
const test = require('node:test')
const read = file => fs.readFileSync(path.join(__dirname, '..', file), 'utf8')
const theme = read('styles/sakura.wxss')
const garden = read('components/showcase-garden/index.wxss')
const markup = read('components/showcase-garden/index.wxml')
const rule = (css, selector) => {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const matches = [...css.matchAll(new RegExp(`${escaped}\\s*\\{([^{}]*)\\}`, 'g'))]
  assert.ok(matches.length, `missing ${selector}`)
  return matches.map(match => match[1]).join(';')
}

function luminance(hex) {
  const values = hex.match(/[a-f\d]{2}/gi).map(value => {
    const s = parseInt(value, 16) / 255
    return s <= .04045 ? s / 12.92 : ((s + .055) / 1.055) ** 2.4
  })
  return values[0] * .2126 + values[1] * .7152 + values[2] * .0722
}
function contrast(a, b) {
  const values = [luminance(a), luminance(b)].sort((x, y) => y - x)
  return (values[0] + .05) / (values[1] + .05)
}

test('sakura typography uses local Chinese system fonts and readable text contrast', () => {
  assert.match(theme, /PingFang SC/)
  assert.match(theme, /Microsoft YaHei/)
  assert.doesNotMatch(theme + garden, /@font-face|https?:\/\//)
  const token = name => theme.match(new RegExp(`--sakura-${name}:\\s*(#[a-f\\d]{6})`, 'i'))[1]
  for (const text of ['ink', 'body', 'muted', 'accent']) {
    for (const background of ['paper', 'wash']) {
      assert.ok(contrast(token(text), token(background)) >= 4.5, `${text} on ${background} needs 4.5:1`)
    }
  }
  assert.ok(contrast('#FFFFFF', token('accent')) >= 4.5, 'white like label needs 4.5:1')
})

test('sakura frames reserve proportional space while full photos retain original aspect ratio', () => {
  assert.match(rule(garden, '.bubble-stage'), /width:\s*100%;\s*height:\s*0;\s*padding-top:\s*75%/)
  assert.match(rule(garden, '.bubble-1 .bubble-stage, .bubble-2 .bubble-stage'), /width:\s*86%;\s*padding-top:\s*86%/)
  assert.match(rule(garden, '.bubble-title'), /margin-top:\s*10rpx/)
  assert.doesNotMatch(rule(garden, '.bubble-title'), /(?:^|;)\s*height:|white-space:\s*nowrap|text-overflow/)
  assert.match(markup, /class="detail-photo"[^>]+mode="widthFix"/)
  assert.match(rule(garden, '.bubble-frame'), /border:\s*2rpx/)
})

test('sakura actions keep 88rpx targets and override native sheet button defaults', () => {
  assert.match(rule(garden, '.garden-control'), /min-height:\s*88rpx/)
  assert.match(rule(garden, '.garden-control'), /white-space:\s*normal/)
  assert.match(rule(garden, '.photo-sheet .like-button'), /width:\s*100%;\s*margin:\s*0/)
  assert.match(rule(garden, '.photo-sheet .sheet-close'), /margin:\s*0/)
  assert.match(rule(garden, '.sheet-bottom'), /env\(safe-area-inset-bottom\)/)
})

test('sakura decoration is noninteractive; important copy is not tiny', () => {
  assert.match(rule(theme, '.sakura-flower'), /flex:\s*none/)
  assert.match(rule(theme, '.sakura-flower'), /pointer-events:\s*none/)
  assert.match(markup, /class="sakura-flower" aria-hidden="true"/)
  // V4: the sakura home is the only home; the showcaseEnabled toggle is retired.
  const homeMarkup = read('pages/garden/index.wxml')
  assert.match(homeMarkup, /class="page home-page garden-home sakura-theme"/)
  assert.doesNotMatch(homeMarkup, /showcaseEnabled/)
  assert.doesNotMatch(read('pages/garden/index.js'), /showcaseEnabled/)
  // V1: the "not your house archive" disclaimer copy is retired; visual zoning carries the meaning.
  assert.match(rule(garden, '.garden-disclaimer'), /display:\s*none/)
  for (const selector of ['.garden-subtitle', '.detail-source', '.detail-license', '.bubble-title']) {
    const size = Number(rule(garden, selector).match(/font-size:\s*(\d+)rpx/)[1])
    assert.ok(size >= 23, `${selector} needs at least 23rpx`)
  }
  assert.match(garden, /prefers-reduced-motion:\s*reduce/)
})

test('rosette orbit garden rotates rigidly, keeps photos upright and stays overlap-free', () => {
  // Rosette layout: slots are positioned by 90°-divergence alternating-radius style from JS.
  assert.match(markup, /class="spiral-stage"/)
  assert.match(markup, /wx:for="\{\{\[rotorEpoch\]\}\}" wx:key="\*this" class="spiral-rotor"/)
  assert.match(markup, /class="spiral-slot" style="\{\{item\.spiralStyle\}\}"/)
  assert.match(markup, /class="spiral-counter"/)
  assert.match(garden, /@keyframes spiral-spin/)
  assert.match(garden, /@keyframes spiral-spin-back/)
  assert.match(rule(garden, '.spiral-rotor'), /animation:\s*spiral-spin\s+9\d+s linear infinite/)
  assert.match(rule(garden, '.spiral-counter'), /animation:\s*spiral-spin-back\s+9\d+s linear infinite/)
  assert.match(rule(garden, '.spiral-slot'), /transform:\s*translate\(-50%,\s*-50%\)/)
  // Compact stage fits the first screen; narrow slots keep orbiting bubbles apart.
  assert.match(rule(garden, '.spiral-stage'), /padding-top:\s*(6\d|7\d)%/)
  assert.match(rule(garden, '.spiral-slot'), /width:\s*2[0-4]%/)
  // Rotation pauses with the page and stops under reduced motion.
  assert.match(rule(garden, '.paused .bubble-frame, .paused .spiral-rotor, .paused .spiral-counter'), /animation-play-state:\s*paused/)
  assert.match(rule(garden, '.reduced .bubble-frame, .reduced .spiral-rotor, .reduced .spiral-counter'), /animation:\s*none/)
  const media = garden.match(/@media \(prefers-reduced-motion: reduce\) \{([^{}]|\{[^{}]*\})*\}/)[0]
  assert.match(media, /spiral-rotor/)
  // Rotating "cat and life" value lines fade instead of jumping.
  assert.match(markup, /garden-subtitle \{\{lineFading \? 'fading' : ''\}\}/)
  assert.match(markup, /\{\{valueLine\}\}/)
  assert.match(rule(garden, '.garden-subtitle'), /transition:\s*opacity/)
})

test('home avatar carries a decorative golden-angle petal ring that never intercepts taps', () => {
  const homeMarkup = read('pages/garden/index.wxml')
  const homeCss = read('pages/garden/index.wxss')
  assert.match(homeMarkup, /class="avatar-orbit-ring" aria-hidden="true"/)
  assert.match(rule(homeCss, '.avatar-orbit-ring'), /pointer-events:\s*none/)
  assert.match(rule(homeCss, '.avatar-orbit-ring'), /animation:\s*spiral-spin-back\s+\d+s linear infinite/)
  assert.match(rule(homeCss, '.orbit-dot:nth-child(2)'), /rotate\(137\.5deg\)/)
  assert.match(homeCss, /@media \(prefers-reduced-motion: reduce\)/)
})

test('mono-aware layer: faded petal field stays decorative, layered and motion-safe', () => {
  const homeMarkup = read('pages/garden/index.wxml')
  const homeCss = read('pages/garden/index.wxss')
  const gardenJs = read('components/showcase-garden/index.js')
  // Desaturated fade pink is decoration-only and lives in the theme tokens.
  assert.match(theme, /--sakura-fade:\s*#[a-f\d]{6}/i)
  // The field is inert, behind the content, and split into three depth layers.
  assert.match(homeMarkup, /class="petal-field" aria-hidden="true"/)
  assert.match(homeMarkup, /wx:if="\{\{!calmMode\}\}"/)
  assert.match(rule(homeCss, '.petal-field'), /pointer-events:\s*none/)
  assert.match(rule(homeCss, '.petal-field'), /z-index:\s*-1/)
  assert.match(homeCss, /@keyframes petal-fall/)
  for (const layer of ['.petal-near', '.petal-mid', '.petal-far']) {
    const seconds = Number(rule(homeCss, layer).match(/animation-duration:\s*(\d+)s/)[1])
    assert.ok(seconds >= 18 && seconds <= 26, `${layer} should drift slowly (18–26s)`)
  }
  const homeMedia = homeCss.match(/@media \(prefers-reduced-motion: reduce\) \{([^{}]|\{[^{}]*\})*\}/)[0]
  assert.match(homeMedia, /\.petal-field\s*\{\s*display:\s*none/)
  // The garden carries the counterpoints: a fallen petal and a tap shimmer.
  assert.match(markup, /class="fallen-petal" aria-hidden="true"/)
  assert.match(markup, /class="pollen-burst" aria-hidden="true"/)
  assert.match(rule(garden, '.fallen-petal'), /opacity:\s*0?\.0?[6-9]/)
  assert.match(rule(garden, '.fallen-petal'), /pointer-events:\s*none/)
  assert.match(rule(garden, '.reduced .pollen-burst'), /display:\s*none/)
  // Five healing lines carry exactly one mono-aware line.
  assert.match(gardenJs, /花开一季，猫伴一生/)
  const lines = gardenJs.match(/VALUE_LINES = \[([\s\S]*?)\]/)[1].match(/'[^']+'/g)
  assert.equal(lines.length, 6)
})
