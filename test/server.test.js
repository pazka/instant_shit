// Upgrade safety net (see TESTING.md): black-box characterization tests of server.js, started the way the
// image does (`node server.js`, DEV config.json here, DATA_DIR in a temp dir). They pin what it does TODAY so
// a Node, Express, express-fileupload, express-rate-limit or Socket.IO bump that changes behaviour fails.
// Node built-ins only:  node --test --test-reporter=spec test/server.test.js
'use strict'

const {test, before, after} = require('node:test')
const assert = require('node:assert/strict')
const {spawn} = require('node:child_process')
const fs = require('node:fs')
const path = require('node:path')
const {PollClient} = require('./sio-poll')

const ROOT = path.join(__dirname, '..')
const PORT = 12131
const BASE = `http://127.0.0.1:${PORT}`
const MB = 1024 * 1024
let data, server

// Keep the data dir on the repo's filesystem (uploads stream to DATA_DIR/tmp, then move to DATA_DIR).
data = fs.mkdtempSync(path.join(ROOT, '.test-data-'))

async function start() {
    let log = ''
    const p = spawn(process.execPath, ['server.js', '-p', String(PORT)], {cwd: ROOT, env: {...process.env, DATA_DIR: data}})
    p.stdout.on('data', d => { log += d })
    p.stderr.on('data', d => { log += d })
    const until = Date.now() + 15000
    while (!log.includes(`Listening on http://localhost:${PORT}`)) {
        if (Date.now() > until || p.exitCode !== null) throw new Error('server did not start:\n' + log)
        await new Promise(r => setTimeout(r, 50))
    }
    return p
}

async function stop(p) {
    p.kill()
    await new Promise(r => p.once('exit', r))
}

before(async () => { server = await start() })
after(async () => {
    await stop(server)
    fs.rmSync(data, {recursive: true, force: true})
})

function upload(name, bytes) {
    const form = new FormData()
    form.append('newFile', new Blob([bytes]), name)
    return fetch(BASE + '/newFile', {method: 'POST', body: form})
}

test('static page, title, limits, initial state, no file yet', async () => {
    const page = await fetch(BASE + '/')
    assert.equal(page.status, 200)
    assert.match(await page.text(), /<script src="\/socket.io\/socket.io.js"><\/script>/)
    assert.equal((await fetch(BASE + '/socket.io/socket.io.js')).status, 200)
    assert.equal(await (await fetch(BASE + '/title')).text(), 'Dev Instant shit')
    assert.deepEqual(await (await fetch(BASE + '/limits')).json(), {maxFileSize: MB, maxTextSize: 1000})
    const all = await (await fetch(BASE + '/all')).json()
    assert.deepEqual(all.file, {time: 0, val: '', size: 0})
    assert.equal(all.txt.val, '')
    const file = await fetch(BASE + '/file')
    assert.deepEqual([file.status, await file.json()], [404, {status: false, message: 'No file has been uploaded yet'}])
})

test('upload: no file 400, file stored and downloadable, new_file broadcast, size limits', async () => {
    const watcher = await new PollClient(BASE).connect()
    try {
        const none = await fetch(BASE + '/newFile', {method: 'POST', body: new FormData()})
        assert.deepEqual([none.status, await none.json()], [400, {status: false, message: 'No file uploaded'}])

        const r = await upload('notes.txt', Buffer.from('hello paste'))
        assert.equal(r.status, 200)
        assert.deepEqual(await r.json(), {status: true, message: 'File is uploaded',
            data: {name: 'notes.txt', mimetype: 'application/octet-stream', size: 11}})
        const [ev] = await watcher.waitFor('new_file')
        assert.deepEqual([ev.val, ev.size], ['notes.txt', 11])

        const dl = await fetch(BASE + '/file')
        assert.equal(dl.status, 200)
        assert.equal(dl.headers.get('content-disposition'), 'attachment; filename="notes.txt"')
        assert.equal(await dl.text(), 'hello paste')
        assert.deepEqual((await (await fetch(BASE + '/all')).json()).file.val, 'notes.txt')

        // between the limit and limit + 1 MB: read, then refused by express-fileupload
        const big = await upload('big.bin', Buffer.alloc(MB + 10))
        assert.deepEqual([big.status, await big.text()], [413, 'File too big, max is 1 Mo'])
        // announced Content-Length above limit + 1 MB: refused before reading the body
        const huge = await upload('huge.bin', Buffer.alloc(2 * MB + 10))
        assert.deepEqual([huge.status, await huge.json()], [413, {status: false, message: 'File too big, max is 1 Mo'}])
        assert.equal(await (await fetch(BASE + '/file')).text(), 'hello paste')
    } finally {
        await watcher.close()
    }
})

test('notepad: my-id, txt_update broadcast to everyone, size limit to the sender only', async () => {
    const a = await new PollClient(BASE).connect()
    const b = await new PollClient(BASE).connect()
    try {
        assert.deepEqual(await a.waitFor('my-id'), [a.id])
        const update = {content: {ops: [{insert: 'Bonjour\n'}]}, delta: {ops: [{insert: 'Bonjour'}]}, source: 'user'}
        await a.emit('txt_update', update)
        const [got] = await b.waitFor('new_text')
        assert.deepEqual([got.from, got.val, got.resync], [a.id, update, false])
        assert.equal(typeof got.time, 'number')
        assert.deepEqual((await a.waitFor('new_text'))[0].from, a.id) // the sender gets it too
        assert.deepEqual((await (await fetch(BASE + '/all')).json()).txt.val, update.content)

        await a.emit('txt_update', {content: {ops: [{insert: 'x'.repeat(1200)}]}})
        const [err] = await a.waitFor('new_text')
        assert.match(err.error, /^Text is too big ! Maximum length is 1000, yours is \d+$/)
        assert.deepEqual((await (await fetch(BASE + '/all')).json()).txt.val, update.content)
    } finally {
        await a.close()
        await b.close()
    }
})

test('state survives a restart (meta.json, currentFile, currentText.json in DATA_DIR)', async () => {
    await new Promise(r => setTimeout(r, 2500)) // notepad is persisted 2 s after the last edit
    await stop(server)
    server = await start()
    const all = await (await fetch(BASE + '/all')).json()
    assert.deepEqual([all.file.val, all.file.size], ['notes.txt', 11])
    assert.deepEqual(all.txt.val, {ops: [{insert: 'Bonjour\n'}]})
    assert.equal(await (await fetch(BASE + '/file')).text(), 'hello paste')
    assert.deepEqual(fs.readdirSync(path.join(data, 'tmp')), [])
})

test('uploads are rate-limited to 15 per 10 minutes per IP', async () => {
    // fresh process after the restart above: the limiter starts empty
    for (let i = 0; i < 15; i++) assert.equal((await upload(`f${i}.txt`, Buffer.from('x'))).status, 200)
    const r = await upload('one-too-many.txt', Buffer.from('x'))
    assert.deepEqual([r.status, await r.json()], [429, {status: false, message: 'Too many uploads, try again in a few minutes'}])
})
