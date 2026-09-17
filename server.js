const config = require('./config.js')('./config.json')
const express = require("express")
const app = express();
const path = require("path")
const server = require('http').createServer(app);
const fileUpload = require('express-fileupload');
const rateLimit = require('express-rate-limit');
const cors = require('cors');
const bodyParser = require('body-parser');
const morgan = require('morgan');
var fs = require('fs');

// maxHttpBufferSize caps a single socket message, so a huge payload
// can't blow up memory before the text-size check runs
var io = require('socket.io')(server, {maxHttpBufferSize: 1e6});

const MAX_FILE_SIZE = config("MAX_FILE_SIZE")
const MAX_TEXT_SIZE = config("MAX_TEXT_SIZE")
const maxFileSizeMo = Math.round(MAX_FILE_SIZE / (1024 * 1024))

let port = config('PORT', 80)
let name = config('NAME', "Instant Shit")
let dataDirectory = process.env.DATA_DIR || 'data'
const currentFilePath = path.join(dataDirectory, 'currentFile')
const metaFilePath = path.join(dataDirectory, 'meta.json')
const textFilePath = path.join(dataDirectory, 'currentText.json')
const tmpDirectory = path.join(dataDirectory, 'tmp')

if (process.argv.includes('-p')) {
    port = process.argv[process.argv.findIndex(e => e === '-p') + 1]
}

if (process.argv.includes('-t')) {
    name = process.argv[process.argv.findIndex(e => e === '-t') + 1]
}

if (!fs.existsSync(dataDirectory)) {
    fs.mkdirSync(dataDirectory, {recursive: true});
}
if (!fs.existsSync(tmpDirectory)) {
    fs.mkdirSync(tmpDirectory, {recursive: true});
}
// clear aborted uploads left over from a previous run
for (const leftover of fs.readdirSync(tmpDirectory)) {
    try { fs.unlinkSync(path.join(tmpDirectory, leftover)) } catch (e) { /* ignore */ }
}

// ---- persisted state: survives container restarts ----------------------------
var currentQuillObj = "";
var currentFileMeta = {name: "", size: 0, mimetype: "", time: 0};
var lastTextUpdate = Date.now();

try {
    if (fs.existsSync(metaFilePath)) {
        currentFileMeta = JSON.parse(fs.readFileSync(metaFilePath))
    } else if (fs.existsSync(currentFilePath)) {
        // file uploaded by an older version of the app: name is lost but the file isn't
        const stat = fs.statSync(currentFilePath)
        currentFileMeta = {name: "restored-file", size: stat.size, mimetype: "application/octet-stream", time: stat.mtimeMs}
    }
} catch (err) {
    console.error("Could not restore file metadata", err)
}

try {
    if (fs.existsSync(textFilePath)) {
        const saved = JSON.parse(fs.readFileSync(textFilePath))
        currentQuillObj = saved.content
        lastTextUpdate = saved.time
    }
} catch (err) {
    console.error("Could not restore notepad content", err)
}

function persistMeta() {
    fs.writeFile(metaFilePath, JSON.stringify(currentFileMeta), err => {
        if (err) console.error("Could not persist file metadata", err)
    })
}

let textSaveTimer = null
function persistTextSoon() {
    if (textSaveTimer) return
    textSaveTimer = setTimeout(() => {
        textSaveTimer = null
        fs.writeFile(textFilePath, JSON.stringify({content: currentQuillObj, time: lastTextUpdate}), err => {
            if (err) console.error("Could not persist notepad content", err)
        })
    }, 2000)
}

// ---- middlewares -------------------------------------------------------------
app.set('trust proxy', 1) // behind traefik: rate-limit on the real client IP

// reject oversize uploads before reading the body at all
app.use('/newFile', (req, res, next) => {
    const announced = parseInt(req.headers['content-length'], 10)
    // small margin for the multipart envelope around the file itself
    if (!isNaN(announced) && announced > MAX_FILE_SIZE + 1024 * 1024) {
        return res.status(413).send({
            status: false,
            message: `File too big, max is ${maxFileSizeMo} Mo`
        });
    }
    next()
})

const uploadLimiter = rateLimit({
    windowMs: 10 * 60 * 1000,
    max: 15, // uploads per IP per 10 minutes
    standardHeaders: true,
    legacyHeaders: false,
    message: {status: false, message: "Too many uploads, try again in a few minutes"}
})
// rate-limit before the body is even read, so spam costs nothing
app.use('/newFile', uploadLimiter)

// uploads stream to disk (inside the data volume), never buffered in RAM
app.use(fileUpload({
    createParentPath: true,
    useTempFiles: true,
    tempFileDir: tmpDirectory,
    limits: {fileSize: MAX_FILE_SIZE},
    abortOnLimit: true,
    responseOnLimit: `File too big, max is ${maxFileSizeMo} Mo`
}));

const downloadLimiter = rateLimit({
    windowMs: 60 * 1000,
    max: 30, // downloads per IP per minute
    standardHeaders: true,
    legacyHeaders: false,
    message: {status: false, message: "Too many downloads, slow down"}
})

app.use(cors(config('CORS')));
app.use(bodyParser.json());
app.use(bodyParser.urlencoded({extended: true}));
app.use(morgan('combined'));

app.use('/', express.static(path.join(__dirname, "www")));

// ---- notepad sync, throttled per client --------------------------------------
// token bucket: fast typing passes, a flood of programmatic updates doesn't
const TXT_BUCKET_CAPACITY = 40
const TXT_BUCKET_REFILL_PER_S = 15
let roomNeedsResync = false

io.sockets.on('connection', function (socket) {
    console.log('Client connected');

    let tokens = TXT_BUCKET_CAPACITY
    let lastRefill = Date.now()

    socket.emit("my-id", socket.id);
    socket.join("global_room");

    socket.on('txt_update', function (data) {
        if (!data || typeof data !== 'object') return

        const now = Date.now()
        tokens = Math.min(TXT_BUCKET_CAPACITY, tokens + (now - lastRefill) / 1000 * TXT_BUCKET_REFILL_PER_S)
        lastRefill = now
        if (tokens < 1) {
            // dropped: everyone will need the full content on the next accepted update
            roomNeedsResync = true
            socket.emit('new_text', {from: socket.id, time: lastTextUpdate, error: "Slow down ! Too many edits at once."})
            return
        }
        tokens -= 1

        const content = data.content
        const contentSize = JSON.stringify(content || "").length
        if (contentSize > MAX_TEXT_SIZE) {
            socket.emit('new_text', {from: socket.id, time: lastTextUpdate, error: `Text is too big ! Maximum length is ${MAX_TEXT_SIZE}, yours is ${contentSize}`})
            return
        }
        currentQuillObj = content

        lastTextUpdate = now;
        persistTextSoon()
        const resync = roomNeedsResync
        roomNeedsResync = false
        io.to("global_room").emit('new_text', {from: socket.id, time: lastTextUpdate, val: data, resync})
    });

    socket.on('disconnect', () => {
        console.log(`${socket.conn.remoteAddress} disconnected`);
    });
});

// ---- routes ------------------------------------------------------------------
app.get('/title', (req, res) => {
    res.send(name)
})

app.get('/limits', (req, res) => res.send({maxFileSize: MAX_FILE_SIZE, maxTextSize: MAX_TEXT_SIZE}))

app.get('/all', (req, res) => res.send(
    {
        txt: {
            time: lastTextUpdate,
            val: currentQuillObj
        },
        file: {
            time: currentFileMeta.time,
            val: currentFileMeta.name,
            size: currentFileMeta.size
        }
    })
)

app.get('/file', downloadLimiter, (req, res) => {
    if (!currentFileMeta.name || !fs.existsSync(currentFilePath)) {
        return res.status(404).send({status: false, message: "No file has been uploaded yet"})
    }
    res.download(currentFilePath, currentFileMeta.name)
})

app.post('/newFile', async (req, res) => {
    try {
        if (!req.files || !req.files.newFile) {
            return res.status(400).send({
                status: false,
                message: 'No file uploaded'
            });
        }

        let newFile = req.files.newFile;
        if (Array.isArray(newFile)) newFile = newFile[0]
        console.log("New file size : ", newFile.size, " octets")
        if (newFile.size > MAX_FILE_SIZE) {
            return res.status(413).send({
                status: false,
                message: `File too big, max is ${maxFileSizeMo} Mo, yours is ${Math.round(newFile.size / (1024 * 1024))} Mo`
            });
        }

        await newFile.mv(currentFilePath);

        currentFileMeta = {
            name: newFile.name || "unnamed-file",
            size: newFile.size,
            mimetype: newFile.mimetype,
            time: Date.now()
        }
        persistMeta()
        io.to("global_room").emit('new_file', {time: currentFileMeta.time, val: currentFileMeta.name, size: currentFileMeta.size})

        res.send({
            status: true,
            message: 'File is uploaded',
            data: {
                name: currentFileMeta.name,
                mimetype: currentFileMeta.mimetype,
                size: currentFileMeta.size
            }
        });
    } catch (err) {
        console.error(err)
        res.status(500).send({status: false, message: "Upload failed on the server, try again"});
    }
});

server.listen(port, () => {
    console.log('Listening on http://localhost:' + port)
});
