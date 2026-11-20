// Preload for test/log.test.js (node --require): fs.writeFileSync on a notepad save (any path that contains
// "currentText.json") behaves like a disk that fills up mid-write: the file is opened (so emptied) and the
// write fails with ENOSPC. The shutdown save must then keep the previous save. Node built-ins only.
'use strict'
const fs = require('node:fs')
const writeFileSync = fs.writeFileSync
fs.writeFileSync = function (file, ...rest) {
    if (!String(file).includes('currentText.json')) return writeFileSync.call(fs, file, ...rest)
    fs.closeSync(fs.openSync(file, 'w'))
    throw Object.assign(new Error(`ENOSPC: no space left on device, write '${file}'`),
        {code: 'ENOSPC', errno: -28, syscall: 'write', path: String(file)})
}
