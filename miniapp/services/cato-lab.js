'use strict'

const ROOT = 'catai_cato_lab_v1:'
function valid(value) {
  if (!/^[a-z][a-z0-9-]{0,48}$/.test(value || '')) throw new Error('实验数据标识无效')
  return value
}
function clone(value) { return JSON.parse(JSON.stringify(value)) }
function createStore(feature, driver) {
  const api = driver || wx
  const prefix = ROOT + valid(feature) + ':'
  const key = name => prefix + valid(name)
  return {
    load(name, fallback) {
      const value = api.getStorageSync(key(name))
      return value === '' || value === null || value === undefined ? clone(fallback) : clone(value)
    },
    save(name, value) { api.setStorageSync(key(name), clone(value)); return clone(value) },
    remove(name) { api.removeStorageSync(key(name)) },
    reset() {
      const keys = api.getStorageInfoSync().keys || []
      keys.filter(item => item.startsWith(prefix)).forEach(item => api.removeStorageSync(item))
    }
  }
}
function uid(prefix = 'record') { return valid(prefix) + '_' + Date.now() + '_' + Math.random().toString(36).slice(2, 10) }
// Call only after a user explicitly chooses to import basic cat cards.
function readLocalCatCards() {
  const stored = wx.getStorageSync('catai_mini_pets_v1')
  return (Array.isArray(stored) ? stored : []).filter(pet => pet && pet.id && !pet.demo)
    .map(pet => ({ id: String(pet.id).slice(0, 160), name: String(pet.name || '未命名猫咪').slice(0, 60) }))
}
module.exports = { createStore, uid, readLocalCatCards, ROOT }
