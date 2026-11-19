// Preload for test/log.test.js (node --require): fs.writeFile empties its file at once and writes the data
// 800 ms later, like a slow disk, so a stop that lands during a save can be reproduced. Node built-ins only.
'use strict'
const fs = require('node:fs')
const writeFile = fs.writeFile
fs.writeFile = function (file, data, ...rest) {
    const cb = rest[rest.length - 1]
    try { fs.writeFileSync(file, '') } catch (e) { return process.nextTick(cb, e) }
    setTimeout(() => writeFile.call(fs, file, data, ...rest), 800)
}
