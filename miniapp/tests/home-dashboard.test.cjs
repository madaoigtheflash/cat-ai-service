'use strict'

const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const test = require('node:test')

const dashboard = require('../pages/garden/dashboard')
const homeWxml = fs.readFileSync(path.join(__dirname, '..', 'pages', 'garden', 'index.wxml'), 'utf8')
const homeWxss = fs.readFileSync(path.join(__dirname, '..', 'pages', 'garden', 'index.wxss'), 'utf8')
const homeJs = fs.readFileSync(path.join(__dirname, '..', 'pages', 'garden', 'index.js'), 'utf8')

function escapeRegex(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

test('home keeps the agreed core order and removes fabricated rewards', () => {
  const sections = [
    'data-section="current-context"',
    'data-section="bubble-garden"',
    'data-section="today-status"',
    'data-section="primary-actions"',
    'data-section="recent-activity"'
  ]
  const positions = sections.map(marker => homeWxml.indexOf(marker))
  positions.forEach((position, index) => assert.ok(position >= 0, `missing home section ${sections[index]}`))
  assert.deepEqual(positions.slice().sort((left, right) => left - right), positions)
  assert.doesNotMatch(homeWxml, /陪伴值|养猫经验|关系卡|心情很好|\+新发现/)
  assert.match(homeWxml, /今日状态/)
  assert.match(homeWxml, /最近动态/)
  assert.match(homeWxml, /class="action-card cream" bindtap="goSighting"/)
})

test('home exposes create, join, and invite house shortcuts with safe touch targets', () => {
  const shortcuts = [
    ['create', 'goCreateHouse', '新增小屋'],
    ['join', 'goJoinHouse', '加入小屋'],
    ['invite', 'goInviteHouse', '邀请猫友']
  ]

  for (const [mode, handler, label] of shortcuts) {
    assert.match(
      homeWxml,
      new RegExp(`class="house-quick-action[^"]*"[^>]*aria-role="button"[^>]*bindtap="${handler}"`)
    )
    assert.match(homeWxml, new RegExp(`<text>${label}</text>`))
    assert.match(
      homeJs,
      new RegExp(`${handler}\\(\\)\\s*\\{[^}]*url:\\s*['"]${escapeRegex(`/pages/online/index?section=home&mode=${mode}`)}['"]`)
    )
  }

  const shortcutRule = homeWxss.match(/\.house-quick-action\s*\{([^}]*)\}/s)
  assert.ok(shortcutRule, 'missing .house-quick-action style')
  const minHeight = shortcutRule[1].match(/min-height:\s*(\d+)rpx/)
  assert.ok(minHeight, 'house shortcut must declare a minimum touch height')
  assert.ok(Number(minHeight[1]) >= 88, 'house shortcut touch height must be at least 88rpx')
})

test('profile completion is derived only from stored fields', () => {
  assert.deepEqual(dashboard.profileCompletion(null), { completed: 0, total: 6, percent: 0 })
  assert.deepEqual(dashboard.profileCompletion({
    name: '奶糖',
    breed: '中华田园猫',
    gender: '未知',
    coatColor: '橘白',
    estimatedAge: '约两岁'
  }), { completed: 4, total: 6, percent: 67 })
})

test('today status reflects records, directed relationships, and current house link', () => {
  const pet = {
    id: 'pet-a',
    name: '奶糖',
    breed: '中华田园猫',
    gender: '母',
    coatColor: '橘白',
    birthday: '2024-01-02',
    imagePath: 'wxfile://cat.jpg',
    weights: [{ id: 'w1', date: '2026-09-08', content: '4.2 kg' }],
    vaccines: [],
    deworming: [],
    medical: []
  }
  const cards = dashboard.buildStatusCards({
    pet,
    relationships: [{ petAId: 'pet-a', petBId: 'pet-b', directionStatus: 'confirmed' }],
    community: { id: 'house-a', name: '樱花小屋' },
    link: { localPetId: 'pet-a', syncedFingerprint: 'same' },
    syncFingerprint: 'same',
    nowMs: Date.parse('2026-09-08T16:00:00+08:00')
  })

  assert.equal(cards.find(item => item.id === 'profile').value, '6/6')
  assert.equal(cards.find(item => item.id === 'records').value, '1 条')
  assert.equal(cards.find(item => item.id === 'relationships').value, '1 组')
  assert.equal(cards.find(item => item.id === 'sync').value, '已同步')
  assert.equal(cards.find(item => item.id === 'sync').detail, '樱花小屋')
})

test('recent activity combines local records and authorized house sightings by timestamp', () => {
  const nowMs = Date.parse('2026-09-08T16:00:00+08:00')
  const rows = dashboard.buildRecentActivity({
    nowMs,
    pet: {
      id: 'pet-a',
      name: '奶糖',
      updatedAt: Date.parse('2026-09-07T10:00:00+08:00'),
      weights: [{ id: 'w1', date: '2026-09-06', content: '4.2 kg' }]
    },
    pets: [{ id: 'pet-a', name: '奶糖' }, { id: 'pet-b', name: '豆包' }],
    relationships: [{
      id: 'r1',
      petAId: 'pet-a',
      petBId: 'pet-b',
      directionStatus: 'confirmed',
      updatedAt: Date.parse('2026-09-08T09:00:00+08:00')
    }],
    sightings: [{
      sightingId: 's1',
      status: 'approved',
      cat: { displayName: '奶糖' },
      areaText: '樱花公园一带',
      observedTimeBucket: '2026-09-08T12:00+08:00'
    }]
  })

  assert.equal(rows[0].kind, 'sighting')
  assert.equal(rows[0].timeLabel, '今天 12:00')
  assert.equal(rows[1].kind, 'relationship')
  assert.match(rows[1].title, /豆包/)
  assert.equal(rows.length, 4)
})
