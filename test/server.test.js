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

// The tests below run after the upload limiter is exhausted for the direct IP: they upload from other client IPs
// (X-Forwarded-For, the server trusts one proxy hop), which is itself part of what they pin.
const from = ip => ({'x-forwarded-for': ip})

test('Express error pages, routing and static fallbacks', async () => {
    const page = (msg) => `<!DOCTYPE html>\n<html lang="en">\n<head>\n<meta charset="utf-8">\n<title>Error</title>\n` +
        `</head>\n<body>\n<pre>${msg}</pre>\n</body>\n</html>\n`
    for (const [method, url, msg] of [['GET', '/nope', 'Cannot GET /nope'], ['POST', '/title', 'Cannot POST /title'],
        ['GET', '/.env', 'Cannot GET /.env'], ['GET', '/www', 'Cannot GET /www'], ['GET', '//title', 'Cannot GET //title'],
        ['GET', '/%2e%2e/package.json', 'Cannot GET /package.json'], ['GET', '/..%2fpackage.json', 'Cannot GET /..%2fpackage.json']]) {
        const r = await fetch(BASE + url, {method})
        assert.deepEqual([url, r.status, r.headers.get('content-type'), await r.text()],
            [url, 404, 'text/html; charset=utf-8', page(msg)])
    }
    // routes are case-insensitive and accept a trailing slash; the query string is ignored
    for (const url of ['/TITLE', '/title/', '/title?x[a]=1&y=2&y=3']) {
        assert.equal(await (await fetch(BASE + url)).text(), 'Dev Instant shit', url)
    }
    const index = await fetch(BASE + '/index.html')
    assert.equal(index.status, 200)
    assert.match(index.headers.get('content-type'), /^text\/html; charset=utf-8$/i) // case of "utf-8" is not significant
    assert.equal(index.headers.get('cache-control'), 'public, max-age=0')
    assert.equal(await index.text(), await (await fetch(BASE + '/')).text())
    const css = await fetch(BASE + '/style.css', {method: 'HEAD'})
    assert.deepEqual([css.status, css.headers.get('accept-ranges')], [200, 'bytes'])
    assert.match(css.headers.get('content-type'), /^text\/css; charset=utf-8$/i)

    // body parsing errors: Express's default error page (dev config shows the stack)
    const bad = await fetch(BASE + '/all', {method: 'POST', headers: {'content-type': 'application/json'}, body: '{bad'})
    assert.equal(bad.status, 400)
    assert.match(await bad.text(), /<pre>SyntaxError: Expected property name or &#39;}&#39; in JSON at position 1/)
    const charset = await fetch(BASE + '/limits', {method: 'POST', headers: {'content-type': 'application/json; charset=klingon'}, body: '{}'})
    assert.equal(charset.status, 415)
    assert.match(await charset.text(), /<pre>UnsupportedMediaTypeError: unsupported charset &quot;KLINGON&quot;/)

    // CORS (DEV config): any origin, default preflight
    const pre = await fetch(BASE + '/all', {method: 'OPTIONS', headers: {origin: 'http://x.example', 'access-control-request-method': 'POST'}})
    assert.deepEqual([pre.status, pre.headers.get('access-control-allow-origin'), pre.headers.get('access-control-allow-methods')],
        [204, '*', 'GET,HEAD,PUT,PATCH,POST,DELETE'])
})

test('download: Content-Disposition per file name, HEAD, ranges', async () => {
    const cases = [
        ['.env', 'attachment; filename=".env"'],
        ['a b.txt', 'attachment; filename="a b.txt"'],
        // fetch's FormData sends '"' as %22; a %XX sequence in the name adds filename*
        ['50%25 "q".txt', 'attachment; filename="50%25 %22q%22.txt"; filename*=UTF-8\'\'50%2525%20%2522q%2522.txt'],
        // express-fileupload decodes the multipart name as latin1: "é" arrives as "Ã©"
        ['café.txt', 'attachment; filename="cafÃ©.txt"'],
        // ... and "€" as "â\x82¬": the C1 control gets a "?" fallback plus filename*
        ['5€.txt', 'attachment; filename="5â?¬.txt"; filename*=UTF-8\'\'5%C3%A2%C2%82%C2%AC.txt'],
    ]
    for (const [i, [name, header]] of cases.entries()) {
        const form = new FormData()
        form.append('newFile', new Blob(['abc']), name)
        assert.equal((await fetch(BASE + '/newFile', {method: 'POST', body: form, headers: from(`10.9.0.${i + 1}`)})).status, 200)
        const dl = await fetch(BASE + '/file', {headers: from(`10.9.1.${i + 1}`)})
        assert.deepEqual([name, dl.status, dl.headers.get('content-disposition'), dl.headers.get('content-type'), await dl.text()],
            [name, 200, header, 'application/octet-stream', 'abc'])
    }
    const head = await fetch(BASE + '/file', {method: 'HEAD', headers: from('10.9.2.1')})
    assert.deepEqual([head.status, head.headers.get('content-length'), await head.text()], [200, '3', ''])
    const part = await fetch(BASE + '/file', {headers: {range: 'bytes=1-', ...from('10.9.2.2')}})
    assert.deepEqual([part.status, part.headers.get('content-range'), await part.text()], [206, 'bytes 1-2/3', 'bc'])
    const off = await fetch(BASE + '/file', {headers: {range: 'bytes=9-', ...from('10.9.2.3')}})
    assert.deepEqual([off.status, off.headers.get('content-range')], [416, 'bytes */3'])
    assert.match(await off.text(), /<pre>RangeNotSatisfiableError: Range Not Satisfiable/)
})

test('rate limits: draft-6 RateLimit-* headers, one bucket per client IP (IPv6 addresses not grouped)', async () => {
    const limits = r => ['ratelimit-policy', 'ratelimit-limit', 'ratelimit-remaining', 'x-ratelimit-limit', 'retry-after']
        .map(h => r.headers.get(h))
    const dl = await fetch(BASE + '/file', {headers: from('10.9.3.1')})
    assert.ok(Number(dl.headers.get('ratelimit-reset')) > 0)
    assert.deepEqual(limits(dl), ['30;w=60', '30', '29', null, null])
    for (const ip of ['2001:db8::1', '2001:db8::2', '2001:db8:0:ff::3']) {
        assert.deepEqual(limits(await fetch(BASE + '/file', {headers: from(ip)})), ['30;w=60', '30', '29', null, null], ip)
    }
    assert.equal((await fetch(BASE + '/file', {headers: from('2001:db8::1')})).headers.get('ratelimit-remaining'), '28')

    const form = () => { const f = new FormData(); f.append('newFile', new Blob(['x']), 'x.txt'); return f }
    const up = await fetch(BASE + '/newFile', {method: 'POST', body: form(), headers: from('2001:db8::1')})
    assert.deepEqual([up.status, ...limits(up)], [200, '15;w=600', '15', '14', null, null])
    const other = await fetch(BASE + '/newFile', {method: 'POST', body: form(), headers: from('2001:db8::2')})
    assert.deepEqual([other.status, ...limits(other)], [200, '15;w=600', '15', '14', null, null])
    // the direct client is still limited (previous test), with Retry-After
    const blocked = await fetch(BASE + '/newFile', {method: 'POST', body: form()})
    assert.deepEqual([blocked.status, ...limits(blocked).slice(0, 4)], [429, '15;w=600', '15', '0', null])
    assert.ok(Number(blocked.headers.get('retry-after')) > 0)
})
