'use strict'

const assert = require('node:assert/strict')
const test = require('node:test')

let sharp = null
let sanitizeApprovedImage = null
try {
  sharp = require('../cloudfunctions/catOnline/node_modules/sharp')
  ;({ sanitizeApprovedImage } = require('../cloudfunctions/catOnline/sanitize'))
} catch (error) { /* dependency is installed remotely for the cloud function */ }

test('approved images are bounded JPEGs with source metadata removed', { skip: !sharp }, async () => {
  const source = await sharp({
    create: { width: 2200, height: 1100, channels: 3, background: '#ff91aa' }
  })
    .withMetadata({ orientation: 6 })
    .jpeg({ quality: 90 })
    .toBuffer()
  assert.equal(source.includes(Buffer.from('Exif\0\0', 'binary')), true)

  const output = await sanitizeApprovedImage(source)
  const metadata = await sharp(output).metadata()
  assert.equal(metadata.format, 'jpeg')
  assert.equal(Math.max(metadata.width, metadata.height), 1600)
  assert.equal(output.includes(Buffer.from('Exif\0\0', 'binary')), false)
})
