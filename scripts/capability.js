#!/usr/bin/env node
// Capability checks against a RUNNING instance (used by scripts/smoke-compose.sh; Node built-ins only).
//   node scripts/capability.js write  BASE MARKER   notepad edit seen by a 2nd client + upload/download round-trip
//   node scripts/capability.js verify BASE MARKER   the same text and file are served (e.g. after a restart)
// It replaces the pad and the file: never point it at a live instance.
'use strict'
const assert = require('node:assert/strict')
const {PollClient} = require('../test/sio-poll')

const [mode, base, marker] = process.argv.slice(2)
if (!['write', 'verify'].includes(mode) || !base || !marker) {
    console.error('usage: capability.js write|verify BASE MARKER'); process.exit(2)
}
const content = {ops: [{insert: `capability ${marker}\n`}]}
const fileName = `capability-${marker}.txt`
const fileBody = `file body ${marker}\n`.repeat(100)

async function write() {
    const a = await new PollClient(base).connect()
    const b = await new PollClient(base).connect()
    try {
        assert.deepEqual(await a.waitFor('my-id'), [a.id])
        await a.emit('txt_update', {content, delta: content, source: 'user'})
        const [got] = await b.waitFor('new_text')
        assert.deepEqual([got.from, got.val.content], [a.id, content])

        const form = new FormData()
        form.append('newFile', new Blob([fileBody], {type: 'text/plain'}), fileName)
        const up = await fetch(base + '/newFile', {method: 'POST', body: form})
        assert.equal(up.status, 200)
        assert.deepEqual((await up.json()).data, {name: fileName, mimetype: 'text/plain', size: fileBody.length})
        const [ev] = await b.waitFor('new_file')
        assert.deepEqual([ev.val, ev.size], [fileName, fileBody.length])
    } finally {
        await a.close()
        await b.close()
    }
    await verify()
}

async function verify() {
    const all = await (await fetch(base + '/all')).json()
    assert.deepEqual(all.txt.val, content, 'notepad content')
    assert.deepEqual([all.file.val, all.file.size], [fileName, fileBody.length], 'file metadata')
    const dl = await fetch(base + '/file')
    assert.equal(dl.status, 200)
    assert.equal(dl.headers.get('content-disposition'), `attachment; filename="${fileName}"`)
    assert.equal(await dl.text(), fileBody, 'file body')
}

;(mode === 'write' ? write() : verify()).then(
    () => console.log(`capability ${mode}: OK`),
    e => { console.error(`capability ${mode}: FAIL`, e); process.exit(1) })
