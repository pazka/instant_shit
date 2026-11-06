// POST_DEPLOY capability check (deploy/hosh-deploy.conf), run by hosh-deploy INSIDE the container after
// each deploy:  node /checks/postdeploy.js http://127.0.0.1:8000   (non-zero exit => automatic rollback)
// READ-ONLY on purpose: it must never replace the live pad or file. Checks: /healthz (data dir writable),
// page + Socket.IO client script, title, limits, state endpoint shape, Socket.IO handshake and namespace
// connect (my-id) over long-polling. Node built-ins only.
'use strict'
const base = (process.argv[2] || 'http://127.0.0.1:8000').replace(/\/$/, '')
const SEP = '\x1e'

function check(cond, what) {
    if (!cond) throw new Error(what)
    console.log('ok  ' + what)
}

async function get(p) {
    const r = await fetch(base + p, {signal: AbortSignal.timeout(5000)})
    return {status: r.status, type: r.headers.get('content-type') || '', text: await r.text()}
}

async function main() {
    const h = await get('/healthz')
    const health = JSON.parse(h.text)
    check(h.status === 200 && health.status === 'ok' && health.dataWritable === true, 'GET /healthz: ok, data dir writable')

    const page = await get('/')
    check(page.status === 200 && page.text.includes('/socket.io/socket.io.js'), 'GET /: page loads the Socket.IO client')
    check((await get('/socket.io/socket.io.js')).status === 200, 'GET /socket.io/socket.io.js')
    const title = await get('/title')
    check(title.status === 200 && title.text.length > 0, `GET /title: "${title.text}"`)
    const limits = JSON.parse((await get('/limits')).text)
    check(limits.maxFileSize > 0 && limits.maxTextSize > 0, `GET /limits: file ${limits.maxFileSize} B, text ${limits.maxTextSize}`)
    const all = JSON.parse((await get('/all')).text)
    check(all.txt && 'time' in all.txt && all.file && 'size' in all.file, 'GET /all: {txt, file}')

    // Socket.IO v4 over long-polling: open, connect to "/", receive my-id, close (no event emitted)
    const open = await get('/socket.io/?EIO=4&transport=polling')
    check(open.status === 200 && open.text[0] === '0', 'engine.io handshake')
    const sid = JSON.parse(open.text.slice(1)).sid
    const url = `${base}/socket.io/?EIO=4&transport=polling&sid=${encodeURIComponent(sid)}`
    const post = body => fetch(url, {method: 'POST', body, headers: {'content-type': 'text/plain;charset=UTF-8'}, signal: AbortSignal.timeout(5000)})
    check((await (await post('40')).text()) === 'ok', 'socket.io namespace connect sent')
    let packets = []
    for (let i = 0; i < 3 && !packets.some(p => p.startsWith('42["my-id"')); i++) {
        packets = packets.concat((await (await fetch(url, {signal: AbortSignal.timeout(30000)})).text()).split(SEP))
    }
    check(packets.some(p => p.startsWith('40')) && packets.some(p => p.startsWith('42["my-id"')), 'socket.io connected, my-id received')
    await post('1').catch(() => {})
    console.log('POSTDEPLOY OK')
}

main().catch(e => { console.error('POSTDEPLOY FAIL: ' + e.message); process.exit(1) })
