// Logging standard (pazka/hosh-management AGENTS.md section 11): stdout only, one JSON object per line with
// ts, level, service, version, event (stable snake_case name, the thing to count), msg, then the line's own
// fields. Never a raw path, query string, body, paste text, file name, socket id, cookie, user agent or IP.
'use strict'

const crypto = require('crypto')
const {performance} = require('perf_hooks')

const LEVELS = {debug: 10, info: 20, warn: 30, error: 40}
const SERVICE = 'instantshit'
// a request slower than this is logged at warn
const SLOW_MS = 1000
// the variables the server reads: the startup line lists the ones that are set, never their values
const CONFIG_NAMES = ['PORT', 'TITLE', 'DATA_DIR', 'LOG_LEVEL', 'APP_LOG_LEVEL', 'APP_VERSION']

// level: debug | info | warn | error (anything else: info)
function createLogger(level, out, version) {
    const name = LEVELS[level] ? level : 'info'
    const min = LEVELS[name]
    const emit = lvl => (event, msg, fields = {}) => {
        if (LEVELS[lvl] < min) return
        out.write(JSON.stringify({
            ts: new Date().toISOString(), level: lvl, service: SERVICE, version, event, msg, ...fields,
        }) + '\n')
    }
    return {level: name, debug: emit('debug'), info: emit('info'), warn: emit('warn'), error: emit('error')}
}

// LOG_LEVEL, or APP_LOG_LEVEL (the name the box template passes), default info
function levelFromEnv(env = process.env) {
    return env.LOG_LEVEL || env.APP_LOG_LEVEL || 'info'
}

const log = createLogger(levelFromEnv(), process.stdout, process.env.APP_VERSION || 'dev')

function configNamesSet(env = process.env) {
    return CONFIG_NAMES.filter(n => env[n] !== undefined && env[n] !== '')
}

// The `err` field of an error line: type, message, code, and the stack's "at ..." frames under the message.
// Each string of `hide` (a file name, a path...) is replaced by "<hidden>" so user data never reaches the log.
function errField(e, hide = []) {
    const secrets = hide.filter(h => typeof h === 'string' && h.length > 1).sort((a, b) => b.length - a.length)
    const clean = s => secrets.reduce((t, h) => t.split(h).join('<hidden>'), String(s))
    if (e instanceof Error) {
        const type = e.name || 'Error'
        const message = clean(e.message)
        const frames = String(e.stack || '').split('\n').filter(l => /^\s+at /.test(l)).map(clean)
        const err = {type, message, stack: [`${type}: ${message}`, ...frames].join('\n')}
        if (e.code) err.code = String(e.code)
        return {err}
    }
    return {err: {type: typeof e, message: clean(e)}}
}

// The edge's X-Request-Id when it is a plain token of at most 64 characters, else a new one.
function requestId(header) {
    const v = Array.isArray(header) ? header[0] : header
    return typeof v === 'string' && /^[A-Za-z0-9._:-]{1,64}$/.test(v) ? v : crypto.randomUUID()
}

// The route template of a request: never the raw path or its query string.
// Express routes are case-insensitive with an optional trailing slash, so the template is too.
function routeOf(url) {
    const p = String(url || '').split('?')[0]
    const named = ['healthz', 'title', 'limits', 'all', 'file', 'newFile']
    for (const n of named) if (new RegExp(`^/${n}/?$`, 'i').test(p)) return '/' + n
    if (p === '/') return '/'
    if (/^\/socket\.io\//.test(p)) return '/socket.io/*'
    if (/^\/[^/]+$/.test(p)) return '/:file'
    return '(other)'
}

const failures = new WeakMap()

// Remembers the error of a request so its request line carries `err` (the answer itself is unchanged).
function recordError(res, err) {
    failures.set(res, err)
}

// First middleware: X-Request-Id on every answer, then one line when the answer is done, only if it matters:
// a 5xx (error, with `err`), a slow answer (warn); anything else at debug; /healthz never above debug.
function requestLogger(logger = log, now = () => performance.now(), hide = []) {
    return (req, res, next) => {
        const start = now()
        const reqId = requestId(req.headers['x-request-id'])
        res.setHeader('X-Request-Id', reqId)
        const url = req.originalUrl || req.url
        // "close" also fires when an answer is cut short, which "finish" never sees
        res.on('close', () => {
            const route = routeOf(url)
            const fields = {req_id: reqId, method: req.method, route, status: res.statusCode, dur_ms: Math.round(now() - start)}
            if (!res.writableFinished) fields.aborted = true
            const failure = failures.get(res)
            if (route === '/healthz') logger.debug('healthz', 'healthz', fields)
            else if (res.statusCode >= 500) logger.error('request_failed', 'server error',
                failure === undefined ? fields : {...fields, ...errField(failure, [url, url.split('?')[0], ...hide])})
            else if (fields.dur_ms > SLOW_MS) logger.warn('request_slow', 'slow request', fields)
            else logger.debug('request', 'request', fields)
        })
        next()
    }
}

// Error middleware: remembers the error for the request line, then lets Express answer exactly as before.
function errorRecorder(err, req, res, next) {
    recordError(res, err)
    next(err)
}

module.exports = {
    LEVELS, SERVICE, SLOW_MS, CONFIG_NAMES,
    createLogger, levelFromEnv, log, configNamesSet, errField, requestId, routeOf,
    recordError, requestLogger, errorRecorder,
}
