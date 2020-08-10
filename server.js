const app = require("express")();
const server = require('http').createServer(app);
const fileUpload = require('express-fileupload');
const cors = require('cors');
const bodyParser = require('body-parser');
const morgan = require('morgan');
const _ = require('lodash');

var fs = require('fs');

// Chargement de socket.io
var io = require('socket.io').listen(server);


// enable files upload
app.use(fileUpload({
    createParentPath: true
}));
//add other middleware
app.use(cors());
app.use(bodyParser.json());
app.use(bodyParser.urlencoded({ extended: true }));
app.use(morgan('dev'));


// Quand un client se connecte, on le note dans la console
io.sockets.on('connection', function (socket) {
    console.log('Client connected');
    socket.emit("my-id",socket.id);
    socket.join("global_room");

    socket.on('txt_update', function (txt) {
        if (JSON.stringify(txt).length > 1000000){
            io.to("global_room").emit('new_text', { from : socket.id, time: lastTextUpdate, val: "Text is too big !" })
            return
        };
    
        currentText = txt;
        lastTextUpdate = Date.now();
        io.to("global_room").emit('new_text', { from : socket.id, time: lastTextUpdate, val: currentText })
    });
});

var currentText = "";
var currentFileName = "";
var lastTextUpdate = Date.now();
var lastFileUpdate = Date.now();

app.get('/', (req, res) => res.sendFile(__dirname+'/client.html'))

app.get('/all', (req, res) => res.send(
    {
        txt: {
            time: lastTextUpdate,
            val: currentText
        },
        file: {
            time: lastFileUpdate,
            val: currentFileName
        }
    }))

app.get('/file', (req, res) => res.download("./currentFile", currentFileName))

app.post('/newFile', async (req, res) => {
    try {
        if (!req.files) {
            res.send({
                status: false,
                message: 'No file uploaded'
            });
        } else {
            //Use the name of the input field (i.e. "avatar") to retrieve the uploaded file
            let file = req.files.newFile;
            if (file.size > 100000) {
                return res.send({
                    status: false,
                    message: 'File too big ' + file.size
                });
            }

            //Use the mv() method to place the file in upload directory (i.e. "uploads")
            file.mv('./currentFile');

            //notify everyone
            currentFileName = file.name;
            lastFileUpdate = Date.now();
            io.to("global_room").emit('new_file', currentFileName)

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
        res.status(500).send(err);
    }
});

server.listen(9393, () => {
    console.log('Listening on 9393')
});