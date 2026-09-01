'use strict'

const assert = require('node:assert/strict')
const test = require('node:test')
const { createCore, adminInviteHash } = require('../cloudfunctions/catAdmin/core')

class FakeRepository {
  constructor() { this.calls = [] }
  async mutateCommunity(input) {
    this.calls.push(input)
    return {
      community: {
        id: input.communityId, name: input.patch.name, scope: input.patch.scope,
        status: 'active', version: 1, ownerPending: true,
        createdAt: input.now, updatedAt: input.now
      },
      auditId: `audit_${input.idempotencyKey}`,
      idempotent: false
    }
  }
}

test('manager invocation creates an audited owner-pending house', async () => {
  const repository = new FakeRepository()
  const core = createCore(repository, {
    now: () => '2026-09-01T00:00:00.000Z',
    randomId: prefix => `${prefix}_fixedvalue`
  })
  const result = await core.handle({
    action: 'mutateCommunity', operation: 'create', idempotencyKey: 'idem-create-001',
    patch: { name: '奶糖小屋', scope: 'invite' }, reason: '本地创建'
  }, {})
  assert.equal(result.ok, true)
  assert.equal(result.data.community.ownerPending, true)
  assert.match(result.data.inviteCode, /^[A-Z2-9]{5}-[A-Z2-9]{5}$/)
  assert.equal(repository.calls[0].createFields.adminInviteHash, adminInviteHash(result.data.inviteCode))
})

test('miniapp identity is rejected before repository access', async () => {
  const repository = new FakeRepository()
  const result = await createCore(repository).handle({ action: 'mutateCommunity' }, { openid: 'user-openid' })
  assert.equal(result.ok, false)
  assert.equal(result.error.code, 'FORBIDDEN')
  assert.equal(repository.calls.length, 0)
})
