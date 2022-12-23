const config = require('./config.js')('./config.json')
const express = require("express")
const app = express();
const path = require("path")
const server = require('http').createServer(app);
const fileUpload = require('express-fileupload');
const cors = require('cors');
const bodyParser = require('body-parser');
const morgan = require('morgan');
const _ = require('lodash');
var fs = require('fs');

var io = require('socket.io').listen(server);


// enable files upload
app.use(fileUpload({
    createParentPath: true,
    limits: {fileSize: config("MAX_FILE_SIZE")},
    abortOnLimit: true,
    responseOnLimit: `File too big, max is ${Math.round(config("MAX_FILE_SIZE") / (1024 * 1024))} Mo`
}));
//add other middleware
app.use(cors(config('CORS')));
app.use(bodyParser.json());
app.use(bodyParser.urlencoded({extended: true}));
app.use(morgan('combined'));

app.use('/', express.static(path.join(__dirname, "www")));

let port = config('PORT',80)
let name = config('NAME',"Instant Shit") 
let dataDirectory = 'data'

if (process.argv.includes('-p')) {
    port = process.argv[process.argv.findIndex(e => e === '-p') + 1]
}

if (process.argv.includes('-t')) {
    name = process.argv[process.argv.findIndex(e => e === '-t') + 1]
}

//create data directory if it doesn't exist
if (!fs.existsSync(dataDirectory)) {
    fs.mkdirSync(dataDirectory);
}

// Quand un client se connecte, on le note dans la console
io.sockets.on('connection', function (socket) {
    console.log('Client connected');

    socket.on('disconnect', () => {
        console.log(`${socket.conn.remoteAddress} connected`);
    });
    socket.emit("my-id", socket.id);
    socket.join("global_room");

    socket.on('txt_update', function (data) {
        const content = data.content
        
        if (content.length > config("MAX_TEXT_SIZE")) {
            io.to("global_room").emit('new_text', {from: socket.id, time: lastTextUpdate, error: `Text is too big ! Maximum length is ${config("MAX_TEXT_SIZE")}, yours is ${content.length}`})
            return
        }
        currentQuillObj = content
        
        lastTextUpdate = Date.now();
        io.to("global_room").emit('new_text', {from: socket.id, time: lastTextUpdate, val: data})
    });


    socket.on('disconnect', () => {
        console.log(`${socket.conn.remoteAddress} disconnected`);
    });
});

var currentQuillObj = "";
var currentFileName = "";
var lastTextUpdate = Date.now();
var lastFileUpdate = Date.now();

app.get('/title', (req, res, next) => {
    res.send(name)
})

app.get('/all', (req, res) => res.send(
    {
        txt: {
            time: lastTextUpdate,
            val: currentQuillObj
        },
        file: {
            time: lastFileUpdate,
            val: currentFileName
        }
    })
)

app.get('/file', (req, res) => res.download("./data/currentFile", currentFileName))
app.post('/newFile', async (req, res) => {
    try {
        if (!req.files) {
            res.send({
                status: false,
                message: 'No file uploaded'
            });
        } else {
            //Use the name of the input field (i.e. "avatar") to retrieve the uploaded file
            let newFile = req.files.newFile;
            console.log("New file size : ",newFile.size," octets")
            if (newFile.size > config("MAX_FILE_SIZE")) {
                return res.send({
                    status: false,
                    message: `File too big, max is ${Math.round(config("MAX_FILE_SIZE") / (1024 * 1024))} Mo, yours is ${Math.round(newFile.size / (1024 * 1024))} Mo`
                });
            }

            //Use the mv() method to place the file in upload directory (i.e. "uploads")
            newFile.mv('./data/currentFile');

            //notify everyone
            currentFileName = newFile.name;
            lastFileUpdate = Date.now();
            io.to("global_room").emit('new_file', {time: lastFileUpdate, val: currentFileName})

            //send response
            res.send({
                status: true,
                message: 'File is uploaded',
                data: {
                    name: newFile,
                    mimetype: newFile.mimetype,
                    size: newFile.size
                }
            });
        }
    } catch (err) {
        console.error(err)
        res.status(500).send(err);
    }
});

server.listen(port, () => {
    console.log('Listening on http://localhost:' + port)
});