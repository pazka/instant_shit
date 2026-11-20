// Logging standard (pazka/hosh-management AGENTS.md section 11): the format cannot rot.
// Unit tests of log.js, the request logger on a real Express app, and server.js black box (spawned as the
// image runs it): startup line, error lines with `err`, shutdown line, nothing but JSON on stdout,
// never the paste, a file name, a path, a query string or an IP.
// Node built-ins only:  node --test --test-reporter=spec test/log.test.js
'use strict'

const {test} = require('node:test')
const assert = require('node:assert/strict')
const {spawn} = require('node:child_process')
const fs = require('node:fs')
const path = require('node:path')
const express = require('express')
const {PollClient} = require('./sio-poll')
const L = require('../log.js')

const ROOT = path.join(__dirname, '..')
const TS = /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
const sleep = ms => new Promise(r => setTimeout(r, ms))

function memLogger(level, version = 'v1.2.3') {
    const lines = []
    const logger = L.createLogger(level, {write: s => lines.push(s)}, version)
    logger.lines = lines
    logger.parsed = () => lines.map(l => JSON.parse(l))
    return logger
}

// ---- log.js -----------------------------------------------------------------------------------------------

test('log: one JSON object per line with ts, level, service, version, event, msg; level filter', () => {
    const lg = memLogger('info')
    lg.debug('hidden', 'not at info')
    lg.info('one', 'first', {n: 1})
    lg.warn('two', 'second')
    lg.error('three', 'third')
    assert.equal(lg.lines.length, 3)
    for (const l of lg.lines) assert.ok(l.endsWith('\n') && !l.slice(0, -1).includes('\n'))
    const [a, b, c] = lg.parsed()
    assert.match(a.ts, TS)
    assert.deepEqual([a.level, a.service, a.version, a.event, a.msg, a.n], ['info', 'instantshit', 'v1.2.3', 'one', 'first', 1])
    assert.deepEqual([b.level, c.level], ['warn', 'error'])
    assert.equal(memLogger('nonsense').level, 'info')
    const e = memLogger('error'); e.warn('x', 'x'); e.error('y', 'y')
    assert.deepEqual(e.parsed().map(o => o.event), ['y'])
    const d = memLogger('debug'); d.debug('z', 'z')
    assert.equal(d.parsed()[0].level, 'debug')
})

test('log: LOG_LEVEL, else APP_LOG_LEVEL, else info; config names without values', () => {
    assert.equal(L.levelFromEnv({}), 'info')
    assert.equal(L.levelFromEnv({APP_LOG_LEVEL: 'debug'}), 'debug')
    assert.equal(L.levelFromEnv({LOG_LEVEL: 'warn', APP_LOG_LEVEL: 'debug'}), 'warn')
    assert.deepEqual(L.configNamesSet({PORT: '8000', DATA_DIR: '/data', TITLE: '', OTHER: 'x'}), ['PORT', 'DATA_DIR'])
})

test('log: errField has type, message, code, stack frames; hidden strings never reach it', () => {
    const e = new Error("ENOENT: no such file, open '/data/tmp/secret-name.txt'")
    e.code = 'ENOENT'
    const {err} = L.errField(e, ['secret-name.txt', 'x'])
    assert.equal(err.type, 'Error')
    assert.equal(err.code, 'ENOENT')
    assert.equal(err.message, "ENOENT: no such file, open '/data/tmp/<hidden>'")
    assert.match(err.stack, /^Error: ENOENT: no such file, open '\/data\/tmp\/<hidden>'\n\s+at /)
    assert.ok(!JSON.stringify(err).includes('secret-name'))
    assert.deepEqual(L.errField('boom'), {err: {type: 'string', message: 'boom'}})
    const t = L.errField(new TypeError('bad'))
    assert.equal(t.err.type, 'TypeError')
    assert.equal(t.err.code, undefined)
})

test('log: request id from X-Request-Id when it is a plain token, else a new UUID', () => {
    assert.equal(L.requestId('abc-123.x:y_z'), 'abc-123.x:y_z')
    assert.equal(L.requestId(['first', 'second']), 'first')
    assert.match(L.requestId(undefined), UUID)
    assert.match(L.requestId('has space'), UUID)
    assert.match(L.requestId('a'.repeat(65)), UUID)
    assert.equal(L.requestId('a'.repeat(64)), 'a'.repeat(64))
})

test('log: route templates, never the raw path or query string', () => {
    const cases = {
        '/healthz': '/healthz', '/HEALTHZ/': '/healthz', '/title?x=1': '/title', '/limits': '/limits',
        '/all': '/all', '/file': '/file', '/File/': '/file', '/newFile': '/newFile', '/newfile?q=s': '/newFile',
        '/': '/', '/?q=secret': '/', '/socket.io/?EIO=4&transport=polling&sid=abc': '/socket.io/*',
        '/main.js': '/:file', '/secret-path': '/:file', '/a/b/c': '(other)', '': '(other)',
    }
    for (const [url, route] of Object.entries(cases)) assert.equal(L.routeOf(url), route, url)
})

// ---- the request logger on a real Express app ---------------------------------------------------------------

async function withApp(level, fn) {
    const lg = memLogger(level)
    let clock = 0
    const app = express()
    app.set('env', 'test') // as server.js: Express prints no error on stderr
    app.use(L.requestLogger(lg, () => clock))
    app.get('/healthz', (req, res) => res.status(Number(req.query.s || 200)).send('ok'))
    app.get('/title', (req, res) => {
        if (req.query.slow) clock += 1001
        res.send('t')
    })
    app.get('/all', () => { throw new Error('broke on /all?q=Secret1') })
    app.get('/limits', (req, res) => res.status(502).send('bad gateway'))
    app.use(L.errorRecorder)
    const srv = app.listen(0, '127.0.0.1')
    await new Promise(r => srv.once('listening', r))
    try {
        await fn(`http://127.0.0.1:${srv.address().port}`, lg.parsed)
    } finally {
        await new Promise(r => srv.close(r))
    }
}

test('request logger: 5xx = one error line with err, slow = warn, the rest only at debug; X-Request-Id', async () => {
    await withApp('info', async (base, parsed) => {
        const r1 = await fetch(`${base}/all?q=Secret1`, {headers: {'x-request-id': 'req-1'}})
        assert.equal(r1.status, 500)
        assert.equal(r1.headers.get('x-request-id'), 'req-1')
        const r2 = await fetch(`${base}/limits?q=Q2`)
        assert.equal(r2.status, 502)
        assert.match(r2.headers.get('x-request-id'), UUID)
        await fetch(`${base}/title?slow=1`)
        await fetch(`${base}/title?q=Q3`)
        await fetch(`${base}/healthz?s=503`)
        await sleep(50)
        const lines = parsed()
        assert.equal(lines.length, 3, JSON.stringify(lines))
        const [e1, e2, w] = lines
        assert.deepEqual([e1.level, e1.event, e1.req_id, e1.method, e1.route, e1.status],
            ['error', 'request_failed', 'req-1', 'GET', '/all', 500])
        assert.equal(typeof e1.dur_ms, 'number')
        assert.equal(e1.err.type, 'Error')
        assert.equal(e1.err.message, 'broke on <hidden>')
        assert.match(e1.err.stack, /^Error: broke on <hidden>\n\s+at /)
        assert.deepEqual([e2.level, e2.event, e2.route, e2.status, e2.err], ['error', 'request_failed', '/limits', 502, undefined])
        assert.deepEqual([w.level, w.event, w.route, w.status, w.dur_ms], ['warn', 'request_slow', '/title', 200, 1001])
        const all = JSON.stringify(lines)
        for (const s of ['Secret1', 'Q2', 'Q3', 'slow=1', '127.0.0.1']) assert.ok(!all.includes(s), s)
    })
    await withApp('debug', async (base, parsed) => {
        await fetch(`${base}/healthz?s=503`)
        await fetch(`${base}/title?q=Q4`)
        await sleep(50)
        assert.deepEqual(parsed().map(o => [o.level, o.event, o.route, o.status]),
            [['debug', 'healthz', '/healthz', 503], ['debug', 'request', '/title', 200]])
    })
})

// ---- server.js, black box -----------------------------------------------------------------------------------

function startServer(port, extraEnv = {}, prepare = () => {}, spawnOpts = {}) {
    const data = fs.mkdtempSync(path.join(ROOT, '.test-log-'))
    prepare(data)
    const env = {...process.env, DATA_DIR: data, ...extraEnv}
    for (const k of ['LOG_LEVEL', 'APP_LOG_LEVEL', 'APP_VERSION']) if (!(k in extraEnv)) delete env[k]
    const s = {out: '', err: '', base: `http://127.0.0.1:${port}`, data}
    s.proc = spawn(process.execPath, ['server.js', '-p', String(port)], {cwd: ROOT, env, ...spawnOpts})
    s.proc.stdout.on('data', d => { s.out += d })
    s.proc.stderr.on('data', d => { s.err += d })
    s.exited = new Promise(r => s.proc.once('exit', (code, signal) => r({code, signal})))
    s.lines = () => s.out.split('\n').filter(Boolean).map(l => JSON.parse(l)) // every line is JSON
    s.ready = (async () => {
        const until = Date.now() + 15000
        while (!s.out.includes('"event":"startup"')) {
            if (Date.now() > until || s.proc.exitCode !== null) throw new Error('server did not start:\n' + s.out + s.err)
            await sleep(50)
        }
    })()
    s.stop = async () => {
        if (s.proc.exitCode === null && s.proc.signalCode === null) s.proc.kill('SIGKILL')
        await s.exited
        for (const d of [data, path.join(data, 'tmp')]) try { fs.chmodSync(d, 0o755) } catch (e) { /* gone */ }
        fs.rmSync(data, {recursive: true, force: true})
    }
    return s
}

function upload(base, name, bytes, headers = {}) {
    const form = new FormData()
    form.append('newFile', new Blob([bytes]), name)
    return fetch(base + '/newFile', {method: 'POST', body: form, headers})
}

// root writes everywhere: the server then runs as nobody (65534), as the image runs as a non-root uid
const asRoot = typeof process.getuid === 'function' && process.getuid() === 0
const nobody = asRoot ? {uid: 65534, gid: 65534} : {}
const giveToNobody = data => { if (asRoot) fs.chownSync(data, 65534, 65534) }
const hiddenEverywhere = (s, extra = []) => {
    for (const x of [s.data, 'meta.json', 'currentText.json', 'currentFile', ...extra]) assert.ok(!s.out.includes(x), x)
}

test('server: startup line (version, port, data dir writable, config names), file_uploaded, shutdown on SIGTERM saves the notepad', async () => {
    const s = startServer(12141, {APP_VERSION: 'v9.8.7', TITLE: 'secret-title-value'})
    try {
        await s.ready
        const starts = s.lines().filter(o => o.event === 'startup')
        assert.equal(starts.length, 1)
        const st = starts[0]
        assert.match(st.ts, TS)
        assert.deepEqual([st.level, st.service, st.version, st.msg, st.port, st.data_dir_writable, st.log_level],
            ['info', 'instantshit', 'v9.8.7', 'Listening on http://localhost:12141', 12141, true, 'info'])
        assert.deepEqual(st.config, ['TITLE', 'DATA_DIR', 'APP_VERSION'])
        assert.ok(!JSON.stringify(st).includes(s.data) && !JSON.stringify(st).includes('secret-title-value'), 'no value in the startup line')

        const up = await upload(s.base, 'secret-file-name.txt', 'hello', {'x-forwarded-for': '203.0.113.77'})
        assert.equal(up.status, 200)
        assert.match(up.headers.get('x-request-id'), UUID)

        // a notepad edit, then SIGTERM before the 2 s save timer: the shutdown writes it
        const c = new PollClient(s.base)
        await c.connect()
        await c.emit('txt_update', {content: {ops: [{insert: 'secret paste text\n'}]}})
        await sleep(200)
        await c.close()
        assert.equal(fs.existsSync(path.join(s.data, 'currentText.json')), false, 'not saved yet (2 s timer)')
        s.proc.kill('SIGTERM')
        const exit = await s.exited
        assert.deepEqual(exit, {code: 0, signal: null})
        assert.deepEqual(JSON.parse(fs.readFileSync(path.join(s.data, 'currentText.json'))).content,
            {ops: [{insert: 'secret paste text\n'}]})

        const lines = s.lines()
        const fileLine = lines.filter(o => o.event === 'file_uploaded')
        assert.equal(fileLine.length, 1)
        assert.deepEqual([fileLine[0].level, fileLine[0].size], ['info', 5])
        const downs = lines.filter(o => o.event === 'shutdown')
        assert.equal(downs.length, 1)
        assert.deepEqual([downs[0].level, downs[0].signal, typeof downs[0].uptime_s], ['info', 'SIGTERM', 'number'])
        // at info: no request, healthz or socket line
        assert.deepEqual(lines.map(o => o.event), ['startup', 'file_uploaded', 'shutdown'])
        const all = s.out
        for (const x of ['secret-file-name', 'secret paste', '203.0.113', '127.0.0.1', 'secret-title-value']) assert.ok(!all.includes(x), x)
        assert.equal(s.err, '', 'nothing on stderr')
    } finally {
        await s.stop()
    }
})

test('server: a failed upload gives upload_failed (err, file name hidden) and request_failed (500); answer unchanged', async () => {
    // currentFile is a non-empty directory: moving the upload onto it fails
    const s = startServer(12142, {}, data => {
        fs.mkdirSync(path.join(data, 'currentFile', 'block'), {recursive: true})
    })
    try {
        await s.ready
        const r = await upload(s.base, 'secret-upload-name.bin', 'abc', {'x-request-id': 'req-up-1'})
        assert.equal(r.status, 500)
        assert.deepEqual(await r.json(), {status: false, message: 'Upload failed on the server, try again'})
        await sleep(100)
        const lines = s.lines()
        const up = lines.filter(o => o.event === 'upload_failed')
        assert.equal(up.length, 1, JSON.stringify(lines))
        assert.match(up[0].ts, TS)
        assert.deepEqual([up[0].level, up[0].service, up[0].version, up[0].msg], ['error', 'instantshit', 'dev', 'Upload failed'])
        assert.deepEqual([up[0].err.type, up[0].err.code], ['Error', 'EISDIR'])
        assert.match(up[0].err.message, /^EISDIR: illegal operation on a directory/)
        assert.equal(up[0].err.stack.split('\n')[0], 'Error: ' + up[0].err.message)
        const req = lines.filter(o => o.event === 'request_failed')
        assert.equal(req.length, 1, JSON.stringify(lines))
        assert.deepEqual([req[0].level, req[0].req_id, req[0].method, req[0].route, req[0].status],
            ['error', 'req-up-1', 'POST', '/newFile', 500])
        assert.equal(typeof req[0].dur_ms, 'number')
        assert.ok(!s.out.includes('secret-upload-name'), 'file name never logged')
        assert.match(up[0].err.message, /'<hidden>[^']*'/, 'the path is hidden, not dropped')
        hiddenEverywhere(s, ['secret-upload-name', 'tmp-'])
        assert.equal(s.err, '')
    } finally {
        await s.stop()
    }
})

test('server: unreadable saved state gives restore_failed error lines with err, then starts as before', async () => {
    const s = startServer(12143, {}, data => {
        fs.writeFileSync(path.join(data, 'meta.json'), '{not json')
        fs.writeFileSync(path.join(data, 'currentText.json'), '{not json either')
    })
    try {
        await s.ready
        const lines = s.lines()
        const rf = lines.filter(o => o.event === 'restore_failed')
        assert.deepEqual(rf.map(o => [o.level, o.what, o.msg]), [
            ['error', 'file_meta', 'Could not restore file metadata'],
            ['error', 'text', 'Could not restore notepad content'],
        ])
        for (const o of rf) {
            assert.match(o.ts, TS)
            assert.equal(o.err.type, 'SyntaxError')
            assert.match(o.err.stack, /^SyntaxError: .*\n\s+at /)
        }
        const all = await (await fetch(s.base + '/all')).json()
        assert.deepEqual(all, {txt: {time: all.txt.time, val: ''}, file: {time: 0, val: '', size: 0}})
    } finally {
        await s.stop()
    }
})

test('server: saved state the server may not read gives restore_failed with the fs error, never a path', async () => {
    const s = startServer(12152, {}, data => {
        for (const f of ['meta.json', 'currentText.json']) {
            fs.writeFileSync(path.join(data, f), '{}')
            fs.chmodSync(path.join(data, f), 0o000)
        }
        giveToNobody(data)
    }, nobody)
    try {
        await s.ready
        const rf = s.lines().filter(o => o.event === 'restore_failed')
        assert.deepEqual(rf.map(o => [o.level, o.what]), [['error', 'file_meta'], ['error', 'text']])
        for (const o of rf) {
            assert.deepEqual([o.err.type, o.err.code, o.err.message], ['Error', 'EACCES', "EACCES: permission denied, open '<hidden>'"])
            assert.equal(o.err.stack.split('\n')[0], 'Error: ' + o.err.message)
        }
        hiddenEverywhere(s)
        assert.equal(s.err, '')
    } finally {
        await s.stop()
    }
})

test('server: corrupted saved state never logs a piece of the paste or the file name (JSON.parse quotes its input)', async () => {
    const s = startServer(12153, {}, data => {
        fs.writeFileSync(path.join(data, 'currentText.json'), '{"content": my pin is 4242}')
        fs.writeFileSync(path.join(data, 'meta.json'), '{"name": secret-holiday.zip}')
    })
    let pos
    try {
        await s.ready
        const rf = s.lines().filter(o => o.event === 'restore_failed')
        assert.deepEqual(rf.map(o => [o.level, o.what]), [['error', 'file_meta'], ['error', 'text']])
        for (const o of rf) {
            assert.deepEqual([o.err.type, o.err.message], ['SyntaxError', 'invalid JSON'])
            assert.match(o.err.stack, /^SyntaxError: invalid JSON\n\s+at /)
        }
        for (const x of ['my pin', '4242', 'secret-hol', 'not valid JSON', 'Unexpected token']) {
            assert.ok(!s.out.includes(x), x)
            assert.ok(!s.err.includes(x), x)
        }
        assert.equal(s.err, '')
        // V8 errors that give a position keep it (and nothing else)
        pos = startServer(12154, {}, data => fs.writeFileSync(path.join(data, 'currentText.json'), '{"content":"my pin is 4242'))
        await pos.ready
        const t = pos.lines().find(o => o.event === 'restore_failed')
        assert.deepEqual([t.what, t.err.type], ['text', 'SyntaxError'])
        assert.match(t.err.message, /^invalid JSON at position \d+$/)
        assert.ok(!pos.out.includes('4242') && !pos.out.includes('Unterminated'), pos.out)
        assert.equal(pos.err, '')
    } finally {
        await s.stop()
        if (pos) await pos.stop()
    }
})

test('server: LOG_LEVEL=debug adds request, healthz and socket lines (never the path, socket id or IP)', async () => {
    const s = startServer(12144, {APP_LOG_LEVEL: 'debug'})
    try {
        await s.ready
        assert.equal(s.lines().find(o => o.event === 'startup').log_level, 'debug')
        await fetch(s.base + '/healthz')
        await fetch(s.base + '/secret-static-name.js?q=secret-query')
        // a bad JSON body: Express's own 400 page, as before, and nothing on stderr (env "test")
        const bad = await fetch(s.base + '/all', {method: 'POST', headers: {'content-type': 'application/json'}, body: '{bad'})
        assert.equal(bad.status, 400)
        assert.match(await bad.text(), /SyntaxError/)
        const c = new PollClient(s.base)
        await c.connect()
        const ids = [c.id, c.sid]
        await c.close()
        await sleep(300)
        const lines = s.lines()
        const hz = lines.find(o => o.event === 'healthz')
        assert.deepEqual([hz.level, hz.route, hz.status], ['debug', '/healthz', 200])
        const st = lines.find(o => o.event === 'request' && o.route === '/:file')
        assert.deepEqual([st.level, st.method, st.status], ['debug', 'GET', 404])
        assert.ok(lines.some(o => o.event === 'socket_connect' && o.level === 'debug'))
        assert.ok(lines.some(o => o.event === 'socket_disconnect' && o.level === 'debug' && typeof o.reason === 'string'))
        assert.ok(lines.some(o => o.event === 'config_loaded' && o.level === 'debug'))
        for (const x of ['secret-static-name', 'secret-query', '127.0.0.1', ...ids]) assert.ok(!s.out.includes(x), x)
        assert.equal(s.err, '', 'nothing on stderr')
    } finally {
        await s.stop()
    }
})

test('server: the startup line says data_dir_writable:false on a read-only data dir', async () => {
    // root writes everywhere: then the server runs as nobody (65534), as the image runs as a non-root uid
    const asRoot = typeof process.getuid === 'function' && process.getuid() === 0
    const s = startServer(12145, {}, data => {
        fs.mkdirSync(path.join(data, 'tmp'))
        fs.chmodSync(path.join(data, 'tmp'), 0o555)
        fs.chmodSync(data, 0o555)
    }, asRoot ? {uid: 65534, gid: 65534} : {})
    try {
        await s.ready
        const st = s.lines().find(o => o.event === 'startup')
        assert.equal(st.data_dir_writable, false)
        assert.equal(st.level, 'info')
    } finally {
        await s.stop()
    }
})

test('server: SIGTERM during a save (slow disk) loses nothing: notepad and file metadata are written whole', async () => {
    const preload = path.join(__dirname, 'slow-write-preload.js')
    const s = startServer(12146, {NODE_OPTIONS: `--require ${preload}`})
    let again
    try {
        await s.ready
        const c = new PollClient(s.base)
        await c.connect()
        await c.emit('txt_update', {content: {ops: [{insert: 'kept paste\n'}]}})
        await c.close()
        await sleep(2100) // the 2 s timer fired: the notepad save is being written (800 ms)
        assert.equal((await upload(s.base, 'kept-file.txt', 'hello')).status, 200) // the meta.json save starts
        await sleep(200)
        s.proc.kill('SIGTERM')
        assert.deepEqual(await s.exited, {code: 0, signal: null})
        assert.deepEqual(JSON.parse(fs.readFileSync(path.join(s.data, 'currentText.json'))).content, {ops: [{insert: 'kept paste\n'}]})
        assert.equal(JSON.parse(fs.readFileSync(path.join(s.data, 'meta.json'))).name, 'kept-file.txt')
        assert.ok(!s.lines().some(o => o.level === 'error'), s.out)

        // the restart restores both and clears what the cut-short saves left behind
        again = startServer(12147, {}, data => fs.cpSync(s.data, data, {recursive: true}))
        await again.ready
        const all = await (await fetch(again.base + '/all')).json()
        assert.deepEqual([all.txt.val, all.file.val, all.file.size], [{ops: [{insert: 'kept paste\n'}]}, 'kept-file.txt', 5])
        assert.ok(!again.lines().some(o => o.event === 'restore_failed'), again.out)
        assert.deepEqual(fs.readdirSync(again.data).filter(f => f.endsWith('.part')), [])
    } finally {
        await s.stop()
        if (again) await again.stop()
    }
})

test('server: a crash (SIGKILL) during a save (slow disk) keeps the previous save; the restart restores it, clears the .part', async () => {
    const preload = path.join(__dirname, 'slow-write-preload.js')
    const s = startServer(12155, {NODE_OPTIONS: `--require ${preload}`})
    const file = path.join(s.data, 'currentText.json')
    let again
    try {
        await s.ready
        const c = new PollClient(s.base)
        await c.connect()
        await c.emit('txt_update', {content: {ops: [{insert: 'version one\n'}]}})
        await sleep(3200) // 2 s timer + 800 ms slow write: v1 is saved
        assert.deepEqual(JSON.parse(fs.readFileSync(file)).content, {ops: [{insert: 'version one\n'}]})
        await c.emit('txt_update', {content: {ops: [{insert: 'version two\n'}]}})
        await c.close()
        await sleep(2300) // the v2 save is being written (empty for 800 ms)
        s.proc.kill('SIGKILL')
        assert.deepEqual(await s.exited, {code: null, signal: 'SIGKILL'})
        assert.deepEqual(JSON.parse(fs.readFileSync(file)).content, {ops: [{insert: 'version one\n'}]}, 'previous save intact')
        assert.equal(fs.readdirSync(s.data).filter(f => /^currentText\.json\.\d+-\d+\.part$/.test(f)).length, 1, 'the cut save is a .part')

        again = startServer(12156, {}, data => fs.cpSync(s.data, data, {recursive: true}))
        await again.ready
        const all = await (await fetch(again.base + '/all')).json()
        assert.deepEqual(all.txt.val, {ops: [{insert: 'version one\n'}]})
        assert.ok(!again.lines().some(o => o.level === 'error'), again.out)
        assert.deepEqual(fs.readdirSync(again.data).filter(f => f.endsWith('.part')), [])
    } finally {
        await s.stop()
        if (again) await again.stop()
    }
})

test('server: a shutdown save that fails mid-write (disk full) keeps the previous save and leaves no .part', async () => {
    const preload = path.join(__dirname, 'sync-enospc-preload.js')
    const s = startServer(12157, {NODE_OPTIONS: `--require ${preload}`})
    const file = path.join(s.data, 'currentText.json')
    try {
        await s.ready
        const c = new PollClient(s.base)
        await c.connect()
        await c.emit('txt_update', {content: {ops: [{insert: 'version one\n'}]}})
        await sleep(2400) // saved by the async save (fs.writeFile is not affected)
        assert.deepEqual(JSON.parse(fs.readFileSync(file)).content, {ops: [{insert: 'version one\n'}]})
        await c.emit('txt_update', {content: {ops: [{insert: 'secret version two\n'}]}})
        await c.close()
        await sleep(200)
        s.proc.kill('SIGTERM') // the shutdown writes v2 synchronously: the disk fills up
        assert.deepEqual(await s.exited, {code: 0, signal: null})
        assert.deepEqual(JSON.parse(fs.readFileSync(file)).content, {ops: [{insert: 'version one\n'}]}, 'previous save intact')
        assert.deepEqual(fs.readdirSync(s.data).filter(f => f.endsWith('.part')), [])
        const lines = s.lines()
        assert.deepEqual(lines.map(o => o.event), ['startup', 'persist_failed', 'shutdown'])
        assert.deepEqual([lines[1].what, lines[1].err.code], ['text', 'ENOSPC'])
        hiddenEverywhere(s, ['secret version'])
        assert.equal(s.err, '')
    } finally {
        await s.stop()
    }
})

test('server: a save that fails gives persist_failed (text and file_meta) with err, never a path, file name or paste', async () => {
    const s = startServer(12148)
    try {
        await s.ready
        // the targets become non-empty directories: renaming a save over them fails
        for (const f of ['meta.json', 'currentText.json']) fs.mkdirSync(path.join(s.data, f, 'block'), {recursive: true})
        assert.equal((await upload(s.base, 'secret-upload.txt', 'abc')).status, 200)
        const c = new PollClient(s.base)
        await c.connect()
        await c.emit('txt_update', {content: {ops: [{insert: 'secret paste text\n'}]}})
        await c.close()
        await sleep(2600)
        const pf = s.lines().filter(o => o.event === 'persist_failed')
        assert.deepEqual(pf.map(o => [o.level, o.what, o.msg]).sort(), [
            ['error', 'file_meta', 'Could not persist file metadata'],
            ['error', 'text', 'Could not persist notepad content'],
        ])
        for (const o of pf) {
            assert.match(o.ts, TS)
            assert.deepEqual([o.err.type, o.err.code], ['Error', 'EISDIR'])
            assert.match(o.err.message, /^EISDIR: illegal operation on a directory, rename '<hidden>\.\d+-\d+\.part' -> '<hidden>'$/)
            assert.equal(o.err.stack.split('\n')[0], 'Error: ' + o.err.message)
        }
        hiddenEverywhere(s, ['secret-upload', 'secret paste'])
        assert.deepEqual(fs.readdirSync(s.data).filter(f => f.endsWith('.part')), [], 'a failed save leaves no .part')
        assert.equal(s.err, '')
    } finally {
        await s.stop()
    }
})

test('server: a save that fails on shutdown gives persist_failed (text) with err, then the shutdown line, exit 0', async () => {
    const s = startServer(12149)
    try {
        await s.ready
        fs.mkdirSync(path.join(s.data, 'currentText.json', 'block'), {recursive: true})
        const c = new PollClient(s.base)
        await c.connect()
        await c.emit('txt_update', {content: {ops: [{insert: 'secret paste text\n'}]}})
        await c.close()
        await sleep(200)
        s.proc.kill('SIGTERM')
        assert.deepEqual(await s.exited, {code: 0, signal: null})
        const lines = s.lines()
        assert.deepEqual(lines.map(o => o.event), ['startup', 'persist_failed', 'shutdown'])
        const pf = lines[1]
        assert.deepEqual([pf.level, pf.what, pf.err.type, pf.err.code], ['error', 'text', 'Error', 'EISDIR'])
        assert.match(pf.err.stack, /^Error: EISDIR: .*\n\s+at /)
        hiddenEverywhere(s, ['secret paste'])
        assert.deepEqual(fs.readdirSync(s.data).filter(f => f.endsWith('.part')), [], 'a failed save leaves no .part')
    } finally {
        await s.stop()
    }
})

test('server: /healthz on an unwritable data dir answers 503 and logs healthz_failed with its code, no path', async () => {
    const s = startServer(12150, {}, giveToNobody, nobody)
    try {
        await s.ready
        assert.equal((await fetch(s.base + '/healthz')).status, 200)
        fs.chmodSync(s.data, 0o555)
        const r = await fetch(s.base + '/healthz')
        assert.equal(r.status, 503)
        assert.deepEqual(await r.json(), {status: 'error', dataWritable: false, error: 'EACCES'})
        await sleep(100)
        const hf = s.lines().filter(o => o.event === 'healthz_failed')
        assert.equal(hf.length, 1, s.out)
        assert.match(hf[0].ts, TS)
        assert.deepEqual([hf[0].level, hf[0].msg, hf[0].code], ['error', 'healthz failed', 'EACCES'])
        hiddenEverywhere(s)
    } finally {
        await s.stop()
    }
})

test('server: an error Express answers itself (unreadable file download, 500) is one request_failed line with err', async () => {
    const s = startServer(12151, {}, data => {
        fs.writeFileSync(path.join(data, 'meta.json'), JSON.stringify({name: 'secret-dl-name.txt', size: 3, mimetype: 'text/plain', time: 1}))
        fs.writeFileSync(path.join(data, 'currentFile'), 'abc')
        fs.chmodSync(path.join(data, 'currentFile'), 0o000)
        giveToNobody(data)
    }, nobody)
    try {
        await s.ready
        const r = await fetch(s.base + '/file', {headers: {'x-request-id': 'req-dl-1'}})
        assert.equal(r.status, 500)
        await sleep(100)
        const rf = s.lines().filter(o => o.event === 'request_failed')
        assert.equal(rf.length, 1, s.out)
        assert.deepEqual([rf[0].level, rf[0].req_id, rf[0].method, rf[0].route, rf[0].status],
            ['error', 'req-dl-1', 'GET', '/file', 500])
        assert.deepEqual([rf[0].err.type, rf[0].err.code, rf[0].err.message],
            ['Error', 'EACCES', "EACCES: permission denied, open '<hidden>'"])
        assert.equal(rf[0].err.stack.split('\n')[0], 'Error: ' + rf[0].err.message)
        hiddenEverywhere(s, ['secret-dl-name'])
        assert.equal(s.err, '')
    } finally {
        await s.stop()
    }
})
