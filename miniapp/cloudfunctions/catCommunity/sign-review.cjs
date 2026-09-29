'use strict'

// Pure local request builder: no network or cloud writes. Pass the resulting JSON
// to an authenticated administrator's CloudBase function-invocation tool.
const crypto = require('crypto')
const { signReview } = require('./review')
const args = process.argv.slice(2)
function argument(name) { const index = args.indexOf(name); return index >= 0 ? args[index + 1] : '' }
const secret = process.env.CAT_COMMUNITY_REVIEW_SECRET || ''
if (Buffer.byteLength(secret) < 32) throw new Error('Set CAT_COMMUNITY_REVIEW_SECRET locally (at least 32 bytes); never pass it on the command line.')
const postId = argument('--post')
const requestHash = argument('--request-hash')
const decision = argument('--decision')
const reason = argument('--reason')
if (!/^post_[a-f0-9]{40}$/.test(postId) || !/^[a-f0-9]{64}$/.test(requestHash) || !['approved', 'rejected'].includes(decision) || !reason || reason.length > 300) {
  throw new Error('Required: --post post_ID --request-hash HASH --decision approved|rejected --reason REASON [--reviewed-text --reviewed-images]')
}
const event = {
  action: 'reviewPost', postId, requestHash, decision, reason,
  reviewedText: args.includes('--reviewed-text'), reviewedImages: args.includes('--reviewed-images'),
  reviewId: crypto.randomBytes(16).toString('hex'), expiresAt: new Date(Date.now() + 4 * 60 * 1000).toISOString()
}
if (decision === 'approved' && (!event.reviewedText || !event.reviewedImages)) throw new Error('Approval requires --reviewed-text --reviewed-images after human inspection of the actual submission.')
process.stdout.write(`${JSON.stringify({ ...event, signature: signReview(event, secret) })}\n`)
