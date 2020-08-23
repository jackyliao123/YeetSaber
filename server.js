"use strict";

const fs = require("fs");
const express = require("express");
const bodyParser = require("body-parser");
const nunjucks = require("nunjucks");
const expressWs = require('express-ws');
const adm_zip = require('adm-zip');

const app = express();

app.disable("x-powered-by");
app.use(express.static("public"));
app.use(bodyParser.urlencoded({ extended: false }));
app.use(bodyParser.json());
expressWs(app);
nunjucks.configure("views", {
    autoescape: true,
    express: app,
    noCache: true
});

// // Firebase App (the core Firebase SDK) is always required and
// // must be listed before other Firebase SDKs
// const firebase = require("firebase/app");

// // Add the Firebase products that you want to use
// require('firebase/database');
// require("firebase/firestore");
//   // Your web app's Firebase configuration
//   var firebaseConfig = {
//     apiKey: "AIzaSyB6OzujrjTqgf7L1ctx1sI8nd1FGpyQdVg",
//     authDomain: "yeet-a550f.firebaseapp.com",
//     databaseURL: "https://yeet-a550f.firebaseio.com",
//     projectId: "yeet-a550f",
//     storageBucket: "yeet-a550f.appspot.com",
//     messagingSenderId: "436838484050",
//     appId: "1:436838484050:web:11435dda9d9f33850e778b"
//   };
//   // Initialize Firebase
//   firebase.initializeApp(firebaseConfig);
//   var db = firebase.database();
// Rooms
// Each room has players
// Each player has controller(s)

// Each room needs an ID (RoomCode)
// Each player needs an ID (hidden from end user)
// Controllers don't have IDs, attached to player

let rooms = {}; // ID to room structure mapping
/* Room structure: 
{
    id: ...
    host: host player ID
    players: [.., .., ..]
    properties... (game started? current song? ...)
}
*/

let players = {}; // ID to player structure mapping
/* Player structure:
{
    id: ...
    secretId: ...
    name: ...
    roomId: ....
    ws: ws object
    controllerWs: ws object
    lastSeen: (number of ms since last ping)
}
*/

let secretId2Id = {};

function generateRandomId(l) {
    var s = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";
    var t = ""
    for (var i = 0; i < l; i++) {
        t += s[Math.floor(Math.random() * s.length)];
    }
    return t;
}

function generateRoomCode() {
    return generateRandomId(8);
}

function generatePlayerId() {
    let pid = generateRandomId(8);
    let sid = generateRandomId(8);
    return [pid, sid];
}

function getTime() {
    return new Date().getTime();
}

app.get("/", async(req, res) => {
    res.render("index.html");
});

app.get("/c", async(req, res) => {
    res.render("controller.html");
});

// Client to server
// 1. player connect (secretId), returns secretId, roomId
//        (reconnectSuccess, room id)
//        (connectSuccess, secret id)
// 2. player create room (), returns room id
// 3. player join room (room Id). (If player reconnect, rejoin the same room). 
//    this subscribes the player to events that happen in the room
// 4. player sends setName, returns name

function broadcastInRoom(roomId, data, excludePlayerId) {
    rooms[roomId].players.forEach(id => {
        if (id !== excludePlayerId && players[id].ws) {
            players[id].ws.sendJSON(data);
        }
    });
}

function broadcastPlayerListUpdate(roomId, excludePlayerId) {
    let playerList = [];
    rooms[roomId].players.forEach(id => {
       if(players[id]) playerList.push({ id: id, name: players[id].name, connected: !!players[id].ws, isHost: rooms[roomId].host == id });
    });
    broadcastInRoom(roomId, { op: "playerListUpdate", val: playerList }, excludePlayerId);
}

function updatePlayerControllerStatus(playerId) {
    let player = players[playerId];
    if (player && player.ws) {
        player.ws.sendJSON({ op: "controllerStatus", val: !!player.controllerWs });
    }
}

function disconnect(player) {
    console.log("Disconnecting " + player.id);
    if (player.controllerWs) {
        player.controllerWs.close();
    }
    if (rooms[player.roomId]) {
        rooms[player.roomId].players = rooms[player.roomId].players.filter(id => id != player.id);
        if (rooms[player.roomId].players.length == 0) {
            delete rooms[player.roomId];
        }
        else {
            if (rooms[player.roomId].host == player.id) {
                rooms[player.roomId].host = rooms[player.roomId].players[0];
            }
            broadcastPlayerListUpdate(player.roomId);
        }
    }
    if(player.ws) {
        player.ws.close();
    }
    delete secretId2Id[player.secretId];
    delete players[player.id];
}

// Player disconnection timeout
setInterval(() => {
    let curTime = getTime();
    Object.keys(players).forEach((k) => {
        if (curTime - players[k].lastSeen > 10000) {
            disconnect(players[k]);
        }
    });
}, 1000);

app.ws("/play", (ws, req) => {
    ws.sendJSON = (json) => ws.send(JSON.stringify(json));
    console.log("Client connected");
    let player = undefined;
    ws.on("message", (msg) => {
        if (player !== undefined) {
            player.lastSeen = getTime();
        }
        try {
            msg = JSON.parse(msg);
        } catch(err) {
            if (player.roomId !== undefined) {
     
                let room = rooms[player.roomId];
                console.log(room);
                if (room.host == player.id) { // FORCES HOST
                    try {
                        console.log("New zip file!");
                        var zip = new adm_zip(Buffer.from(msg, "binary"));
                        var zipEntries = zip.getEntries();
                        console.log(zipEntries.length);
                        var findFile = (name) => zipEntries.filter(entry => entry.name === name)[0];
                        var info = JSON.parse(zip.readAsText(findFile("info.dat")));
                        room.bpm = info["_beatsPerMinute"];
                        var songContent = zip.readFile(findFile(info["_songFilename"]));
  
                        
                        let songTitle = info["_songFilename"].split(".")[0].replace(/ /g, "_");
                        
                       // room.fbBeatmapDict = {};
                        info["_difficultyBeatmapSets"][0]["_difficultyBeatmaps"].forEach(e => {
                            room.beatmaps[songTitle+"_"+e["_difficulty"]] = JSON.parse(zip.readAsText(findFile(e["_beatmapFilename"])))["_notes"];
                            room.beatmaps[songTitle+"_"+e["_difficulty"]].forEach(e => { // why did you name this also e lmaooo
                                e["_time"] = e["_time"] / (room.bpm / 60);
                                
                            });
                            
                            room.songs[songTitle+"_"+e["_difficulty"]] = songContent;
                            
                            // firebase name
                            // let fbPath = info["_songFilename"].split(".")[0].replace(/ /g, "_") + "_"+e["_difficulty"];
                            // db.ref(info["_songFilename"].split(".")[0].replace(/ /g, "_") + "_"+e["_difficulty"]).set(room.beatmaps[e["_difficulty"]]);
                            // room.fbBeatmapDict[fbPath] = room.beatmaps[e["_difficulty"]];
                            // })
                        });
                        ws.sendJSON({op: "uploadSuccess", val: Object.keys(room.beatmaps)});
                    } catch(err) {
                        ws.sendJSON({op: "uploadFail"});
                        console.log(err);
                        console.log("Zip file upload failed");
                    }
                }
            }
        }
        //console.log(msg);
        if (msg.op !== "connect" && player === undefined) {
            console.log("Player attempted to play without connecting first");
            return;
        }
        switch (msg.op) {
            case "connect": // val should be secretId
                if (secretId2Id[msg.val] !== undefined) {
                    player = players[secretId2Id[msg.val]];
                    player.ws = ws;
                    player.lastSeen = getTime();
                    ws.sendJSON({ "op": "reconnectSuccess", "val": { room: player.roomId, name: player.name, id: player.id} });
                    console.log("player reconnect, secret id " + msg.val);
                }
                else {
                    let [pid, sid] = generatePlayerId();
                    secretId2Id[sid] = pid;
                    player = {
                        secretId: sid,
                        ws: ws,
                        id: pid,
                        lastSeen: getTime()
                    };
                    players[pid] = player;
                    ws.sendJSON({ op: "connectSuccess", val: player.secretId, id: player.id });
                    console.log("player connect, secret id " + msg.val);
                }
                updatePlayerControllerStatus(player.id);
                break;
            case "createRoom": // val doesn't matter
                var roomCode = generateRoomCode();
                console.log("create room, id " + roomCode);
                player.roomId = roomCode;
                rooms[roomCode] = {
                    id: roomCode,
                    players: [player.id],
                    host: player.id,
                    beatmaps: {},
                    songs: {}
                };
                ws.sendJSON({ op: "createRoomSuccess", val: roomCode });
                break;
            case "joinRoom": // val should be room id
                console.log("join room, msg val = " + msg.val);
                var room = rooms[msg.val];
                if (room !== undefined) {
                    player.roomId = msg.val;
                    if (!room.players.includes(player.id)) {
                        room.players.push(player.id);
                    }
                    broadcastPlayerListUpdate(msg.val);
                    ws.sendJSON({ op: "joinRoomSuccess", val: msg.val, isHost: room.host == player.id });
                    
                    
                    if(room.beatmap !== undefined) {
                        ws.sendJSON({op: "map", map: room.beatmaps[room.beatmap], audio: room.songs[room.beatmap].toString('base64')});
                    }
                    if(room.beatmaps !== undefined){
                        let beatmapKeys = (Object.keys(room.beatmaps));
                        if(beatmapKeys.length > 0)  ws.sendJSON({op: "uploadSuccess", val:beatmapKeys});
                    }
                    
                    // // FIREBASE TEST
                    // db.ref().once("value").then(function(snapshot){
                    //   snapshot.forEach(x => console.log(x));
                    // });
                    
                }
                else {ws.sendJSON({ op: "joinRoomFail" }); console.log("join room fail!!!");}
                break;
            case "setName": // val should be name
                console.log("set name " + msg.val);
                player.name = msg.val;
                if (player.roomId !== undefined) {
                    broadcastPlayerListUpdate(player.roomId);
                }
                ws.sendJSON({ op: "setNameSuccess", val: msg.val });
                break;
            case "disconnectPlayer":
                console.log("disconnect player " + msg.val);

                disconnect(player);

                break;
            case "vibrate":
                if(player.controllerWs && player.controllerWs.readyState == 1) {
                    player.controllerWs.sendJSON(msg);
                }
                break;
            case "chooseMap":
                if(player.roomId !== undefined) {
                    let room = rooms[player.roomId];
                    if(room.host === player.id) { // FORCES HOST
                       // room.beatmap = room.beatmaps[msg.val];
                        room.beatmap = msg.val;
                        broadcastInRoom(room.id, {op: "map", map: room.beatmaps[room.beatmap], audio: room.songs[room.beatmap].toString('base64')});
                    }
                }
                break;
            case "scoreChange":
                if(player.roomId !== undefined) {
                    let room = rooms[player.roomId];
                    broadcastInRoom(room.id, {op: "scoreChange", val: msg.val, id: player.id});
                }
                break;
            case "start":
                if(player.roomId !== undefined) {
                    let room = rooms[player.roomId];
                    if(room.host === player.id) { // FORCES HOST
                        broadcastInRoom(room.id, {op: "start"});
                    }
                }
                break;
            case "stop":
                if(player.roomId !== undefined) {
                    let room = rooms[player.roomId];
                    if(room.host === player.id) { // FORCES HOST
                        broadcastInRoom(room.id, {op: "stop"});
                    }
                }
                break;
        }
    });
    ws.on("close", () => {
        if (player) {
            player.ws = undefined;
            if (rooms[player.roomId]) {
                broadcastPlayerListUpdate(player.roomId, player.id);
            }
        }
    });
});
// Controller connect
app.ws("/controller/:id", (ws, req) => {
    ws.sendJSON = (json) => ws.send(JSON.stringify(json));
    let requestId = req.params.id;
    let showMessage = (errMsg, close = false) => {
        if (ws && ws.readyState == 1) {
            ws.sendJSON({ op: "err", val: errMsg });
        }
        if (close) {
            ws.close();
        }
    }
    if (secretId2Id[requestId] === undefined) {
        console.log("Invalid id received: " + requestId);
        showMessage("Player ID is invalid", true);
        return;
    }
    let player = players[secretId2Id[requestId]];
    if (player.controllerWs !== undefined) {
        console.log("Disconnected previous controller");
        player.controllerWs.close();
    }
    player.controllerWs = ws;
    let noPlayer = false;

    let sendIfPlayerExists = (data) => {
        if (player.ws && player.ws.readyState == 1) {
            player.ws.sendJSON(data);
            if (noPlayer) {
                showMessage("");
                noPlayer = false;
            }
        }
        else {
            console.log("Send attempt while player is disconnected");
            if (!noPlayer) {
                showMessage("Player is disconnected");
                noPlayer = true;
            }
        }
    };

    console.log("New controller connected: " + req.socket.remoteAddress);
    updatePlayerControllerStatus(player.id);
    ws.on("message", (msg) => {
        msg = JSON.parse(msg);
        //console.log(msg);
        sendIfPlayerExists({ "op": "controller", "val": msg });
    });
    ws.on("close", (msg) => {
        player.controllerWs = undefined;
        updatePlayerControllerStatus(player.id);
    });
});

app.use(function(err, req, res, next) {
    console.error(err);
    console.error(err.stack);
    res.status(500).send("Internal Server Error");
});

const port = process.env.PORT || 8081;

app.listen(port, () => {
    console.log("Listening on " + port);
});
