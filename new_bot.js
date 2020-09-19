// Discord Modules
const discordIO = require('discord.io');
const discordJS = require('discord.js');

// Configuration object
const config = require('./api-config.json');

// Console input modules
const readline = require('readline');

// Webserver modules for IO
const express = require('express');
const app = express();

const http = require('http').Server(app);
const io = require('socket.io')(http);

// These modules will be used for verification of users
const mysql = require('mysql');
const crypto = require('crypto');

const pool = mysql.createPool(config.mysql);

pool.query("CREATE TABLE IF NOT EXISTS `servers`(" +
    "`id` INT(11) UNSIGNED NOT NULL AUTO_INCREMENT," +
    "`serverID` VARCHAR(36) NOT NULL," +
    "`token` VARCHAR(127) NOT NULL," +
    "PRIMARY KEY(`id`)," +
    "UNIQUE(`serverID`));"
);

pool.query(
    "CREATE TABLE IF NOT EXISTS `users`(" +
    "`id` INT(11) NOT NULL AUTO_INCREMENT," +
    "`user` VARCHAR(255) NOT NULL," +
    "`userID` VARCHAR(36) NOT NULL," +
    "`roleID` VARCHAR(36) NOT NULL," +
    "`serverID` VARCHAR(36) NOT NULL," +
    "`username` VARCHAR(16) NOT NULL," +
    "`uuid` VARCHAR(36) NOT NULL," +
    "PRIMARY KEY(`id`));",
(err)=> {
        if(err) throw err;
});

pool.query(
    "CREATE TABLE IF NOT EXISTS `verification`(" +
    "`user` VARCHAR(255) NOT NULL," +
    "`userID` VARCHAR(36) NOT NULL," +
    "`serverID` VARCHAR(36) NOT NULL," +
    "`channelID` VARCHAR(36) NOT NULL," +
    "`uuid` VARCHAR(36) NOT NULL," +
    "`code` VARCHAR(32) NOT NULL);",
(err)=> {
    if (err) throw err;
});

const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout
});

// initialize bot
const bot = new discordIO.Client({
    token: config.clientToken,
    autorun: true
});

bot.on('ready', (event)=> {
    console.info("Logged in as: " + bot.username + ' - (' + bot.id + ')');
});

bot.on('disconnect', ()=> {
    bot.connect();
});

/**
Structure:
{
    "serverID": string,
    "channels": [{
        "channelID": string,
        "webhookID": string,
        "webhookToken": string,
        "chat": boolean,
        "deathMessages": boolean,
        "joinQuitMessages": boolean,
        "requireVerification": boolean,
        "adminCommands": boolean
    }]
}
**/

class Channel {
    constructor(webhookID, webhookToken, chat, info, requireVerification, adminCommands) {
        this.webhookClient = new discordJS.WebhookClient(webhookID, webhookToken);
        this.chat = chat;
        this.requireVerification = requireVerification;
        this.adminCommands = adminCommands;
        this.info = info;
    }

    sendMessage(username, uuid, message) {
        this.webhookClient.send(message, {
            username: username,
            avatarURL: `https://minotar.net/cube/${uuid}/128.png`
        });
    }
}

class Server {
    constructor(serverID, channels, defaultRole, enforceNickname, socket) {
        this.serverID = serverID;
        this.channels = channels;
        this.socket = socket;
        this.defaultRole = defaultRole;
        this.enforceNickname = enforceNickname;

        // When an info is sent
        socket.on("info", (data) => {
            let message = data.message;

            for(let[channelID, channel] of Object.entries(channels)) {
                if(channel.info) {
                    // Send the message to the webhook with the console Icon
                    channel.webhookClient.send(message, {
                        username: 'Console',
                        avatarURL: 'https://icons-for-free.com/iconfiles/png/128/command+line+console+icon-1320183824883548925.png',
                    });
                }
            }
        });

        // Bot event
        socket.on("bot", (data) => {
            let message = data.message;
            let channelID = data.channelID;

            bot.sendMessage({
                to: channelID,
                message: message
            });
        });

        // When a chat is sent
        socket.on("chat", (data) => {
            let message = data.message;
            let username = data.username;
            let uuid = data.uuid;

            let tags = message.toLowerCase().match(/(@\w+)/g);
            let taglist = "";
            if(tags != null) {
                for(let tag of tags) {
                    taglist += tag.substring(1) + ',';
                }
                taglist = taglist.substring(0, taglist.length - 1);

                pool.query(
                    "SELECT `username`, `userID` FROM `users` WHERE FIND_IN_SET(LOWER(`username`), ?) > 0;",
                    [taglist],
                    (err, res) => {
                        if(err) throw err;

                        for(let row of res) {
                            let username = row.username;
                            let userID = row.userID;

                            let regex = new RegExp(`@${username}`, 'ig');

                            message = message.replace(regex, `<@!${userID}>`);
                        }
                        this.sendMessage(username, uuid, message);
                    }
                );
            } else {
                this.sendMessage(username, uuid, message);
            }
        });

        // Command not found event
        socket.on("cnf", (data) => {
            let channelID = data.channelID;
            let user = data.user;
            let userID = data.userID;
            let cmd = data.command;

            bot.sendMessage({
                to: channelID,
                message: '`!'+ cmd + '` is not a valid command!'
            });
        });

        socket.on('disconnect', () => {
            console.log("Disconnected from client!");
        });

        // Verification call back
        socket.on('vcb', (data) => {
            let user = data.user;
            let userID = data.userID;
            let channelID = data.channelID;
            let uuid = data.uuid;
            let code = data.code;

            // error occurs when the user is not found or is not in game
            if(!data.error) {
                pool.query(
                    "INSERT INTO `verification` SET ?;",
                    {
                        user: user,
                        userID: userID,
                        channelID: channelID,
                        serverID: serverID,
                        uuid: uuid,
                        code: code
                    },
                    (err) => {
                        if (err) throw err;
                        bot.sendMessage({
                            to: channelID,
                            message: "Verification request sent! Please complete verification process in game!"
                        });
                    }
                );
            } else {
                bot.sendMessage({
                    to: channelID,
                    message: "That username doesn't exist or the player is not in game! " +
                        "Please make sure you are logged into the server and the username matches!"
                });
            }
        });

        socket.on('verify', (data) => {
            let uuid = data.uuid;
            let username = data.username;
            let code = data.code;

            // Check if the token is valid for the user
            pool.query("SELECT * FROM `verification` WHERE `uuid` = ? AND `code` = ? AND `serverID` =?;", [uuid, code, serverID], (err, res)=> {
                if(err) throw err;
                if(res.length === 1) {
                    let row = res[0];
                    // Check that the user doesn't exist already
                    pool.query(
                        "SELECT * FROM `users` WHERE `uuid` = ? AND `serverID` = ?;",
                        [uuid, serverID],
                        (err, res) => {
                            if(err) throw err;
                            if(res.length === 0) {
                                // Add the user to the table completing the verification process
                                pool.query(
                                    "INSERT INTO `users`(`user`, `userID`, `roleID`, `serverID`, `username`, `uuid`) VALUES(?, ?, ?, ?, ?, ?);",
                                    [
                                        row.user,
                                        row.userID,
                                        this.defaultRole,
                                        serverID,
                                        username,
                                        uuid
                                    ],
                                    (err) => {
                                        if(err) throw err;
                                        // delete the verification row
                                        pool.query("DELETE FROM `verification` WHERE `serverID` = ?;", [row.serverID], (err)=> {
                                            if(err) throw err;
                                        });
                                        bot.sendMessage({
                                            to: row.channelID,
                                            message: `<@${row.userID}> Your Discord account is now linked to Minecraft player ${username}!`
                                        });
                                        bot.addToRole({
                                            userID: row.userID,
                                            serverID: serverID,
                                            role: defaultRole
                                        });
                                        if(enforceNickname) {
                                            bot.editNickname({
                                                userID: row.userID,
                                                serverID: serverID,
                                                nick: username
                                            });
                                        }
                                        socket.emit('vcb', {
                                            user: row.user,
                                            userID: row.userID,
                                            uuid: uuid
                                        });
                                    }
                                );
                            }
                        }
                    );
                }
            });
        });

        socket.on('unlink', (data) => {

            let uuid = data.uuid;

            pool.query(
                "DELETE FROM `users` WHERE `uuid` = ? AND `serverID` = ?;",
                [uuid, serverID],
                (err, res) => {
                    if(err) throw err;
                    socket.emit('unlinkcb', {
                        uuid: uuid,
                        success: res.affectedRows >= 1
                    });
                }
            );
        });

        socket.on('addrole', (data) => {
            let uuid = data.uuid;
            let roleID = data.role;

            // Get the discord userID of the player
            pool.query(
                "SELECT `userID` FROM `users` WHERE `uuid` = ? AND `serverID` = ?;",
                [uuid, serverID],
                (err, res) => {
                    if(err) throw err;

                    if(res.length === 1) {
                        let userID = res[0].userID;
                        // Add the user to the role
                        bot.addToRole({
                            userID: userID,
                            serverID: serverID,
                            role: roleID
                        }, (err) => {
                            if(err) throw err;
                            socket.emit('addrolecb', {
                                uuid: uuid,
                                roleID: roleID,
                                success: true
                            });
                        });
                    } else {
                        socket.emit('addrolecb', {
                            uuid: uuid,
                            roleID: roleID,
                            success: false
                        });
                    }
                }
            );
        });

        socket.on('removerole', (data) => {
            let uuid = data.uuid;
            let roleID = data.roleID;

            // Get the discord userID from the player
            pool.query(
                "SELECT `userID` FROM `users` WHERE `uuid` = ? AND `serverID` = ?;",
                [uuid, serverID],
                (err, res) => {
                    if(err) throw err;

                    // If the user is verified
                    if(res.length >= 1) {
                        let userID = res[0].userID;

                        bot.addToRole({
                            userID: userID,
                            serverID: serverID,
                            role: roleID
                        }, (err) => {
                            if(err) throw err;

                            socket.emit('removerolecb', {
                                uuid: uuid,
                                roleID: roleID,
                                success: true
                            });
                        });
                    } else {
                        socket.emit('removerolecb', {
                            uuid: uuid,
                            roleID: roleID,
                            success: false
                        });
                    }
                }
            );
        });

        socket.on('getuser', (data) => {
            let username = data.req;
            pool.query(
            "SELECT * FROM `users` WHERE `username`= ? AND `serverID` = ?;",
            [username, serverID],
            (err, res) => {
                if(err) throw err;

                socket.emit('usercb', {
                    req: username,
                    res: res
                });
            });
        });

        socket.on('request', (data) => {
            let type = data.type;
            let id = data.id;
            switch(type) {
                case 'user':
                    this.getUser(data.username, (err, res) => {
                        if(err) throw err;
                        // send the user object back
                        socket.emit('callback', {
                            id: id,
                            error: false,
                            user: res[0]
                        });
                    });
                    break;
                case 'dm':
                    let embed = data.embed;
                    if(data.userID != null) {
                        // Create a DM channel with the userID
                        bot.createDMChannel(data.userID, (err, res) => {
                            if(err) throw err;
                            let channelID = res.id;
                            if(embed != null) {
                                bot.sendMessage({
                                    to: channelID,
                                    message: data.message,
                                    embed: embed
                                }, (err, res) => {
                                    if (err) throw err;
                                    socket.emit('callback', {
                                        id: id,
                                        res: res,
                                        error: false,
                                        message: "Success!"
                                    });
                                });
                            } else {
                                bot.sendMessage({
                                    to: channelID,
                                    message: data.message,
                                }, (err, res)=> {
                                    if(err) throw err;
                                    socket.emit('callback', {
                                        id: id,
                                        res: res,
                                        error: false,
                                        message: "Success!"
                                    });
                                });
                            }
                        });
                    } else if(data.username != null) {
                        // Get the user from the username
                        this.getUser(data.username, (err, res) => {
                            if(err) throw err;
                            // Make sure the user exists
                            if(res.length >= 1) {
                                let userID = res[0].userID;
                                let username = res[0].username;
                                bot.createDMChannel(userID, (err, res) => {
                                    if(err) throw err;
                                    let channelID = res.id;
                                    if(embed != null) {
                                        bot.sendMessage({
                                            to: channelID,
                                            message: data.message
                                        }, (err, res) => {
                                            if (err) throw err;
                                            socket.emit('callback', {
                                                id: id,
                                                res: res,
                                                error: false,
                                                username: username,
                                                message: "Success!"
                                            });
                                        });
                                    } else {
                                        bot.sendMessage({
                                            to: channelID,
                                            message: data.message
                                        }, (err, res) => {
                                            if (err) throw err;
                                            socket.emit('callback', {
                                                id: id,
                                                res: res,
                                                error: false,
                                                username: username,
                                                message: "Success!"
                                            });
                                        });
                                    }
                                });
                            } else {
                                socket.emit('callback', {
                                    id: id,
                                    error: true,
                                    message: "No user found!"
                                });
                            }
                        });
                    }
                    break;
                case 'verify':
                    pool.query("SELECT * FROM `verification` WHERE `uuid` = ? AND `code` = ? AND `serverID` = ?;",
                        [data.uuid, data.code, serverID],
                    (err, res) => {
                        if(err) throw err;
                        // Check if there is a user that matches the verification code
                        if(res.length === 1) {
                            let row = res[0];
                            // Check that a user doesn't exist already
                            pool.query(
                            "SELECT * FROM `users` WHERE `uuid` = ? AND `serverID` = ?;",
                            [data.uuid, serverID],
                            (err, res) => {
                                if(err) throw err;
                                if(res.length === 0) {
                                    // Add the user to the table completing the verification process
                                    pool.query(
                                        "INSERT INTO `users`(`user`, `userID`, `roleID`, `serverID`, `username`, `uuid`) VALUES(?, ?, ?, ?, ?, ?);",
                                        [
                                            row.user,
                                            row.userID,
                                            this.defaultRole,
                                            serverID,
                                            data.username,
                                            data.uuid
                                        ],
                                        (err) => {
                                            if(err) throw err;
                                            // delete the verification row
                                            pool.query("DELETE FROM `verification` WHERE `serverID` = ?;", [serverID], (err)=> {
                                                if(err) throw err;
                                            });
                                            bot.sendMessage({
                                                to: row.channelID,
                                                message: `<@${row.userID}> Your Discord account is now linked to Minecraft player ${data.username}!`
                                            });
                                            bot.addToRole({
                                                userID: row.userID,
                                                serverID: serverID,
                                                role: defaultRole
                                            });
                                            // Change the nickname of the user in discord if it's enforced
                                            if(enforceNickname) {
                                                bot.editNickname({
                                                    userID: row.userID,
                                                    serverID: serverID,
                                                    nick: data.username
                                                });
                                            }
                                            // Send a callback
                                            socket.emit('callback', {
                                               id: id,
                                               error: false,
                                               message: "Success!"
                                            });
                                        }
                                    );
                                } else {
                                    socket.emit('callback', {
                                        id: id,
                                        error: true,
                                        message: 'User already exists!'
                                    });
                                }
                            });
                        } else {
                            socket.emit('callback', {
                                id: id,
                                error: true,
                                message: "No user to be verified!"
                            });
                        }
                    });
                    break;
                case 'embed':
                    bot.sendMessage({
                        to: data.channelID,
                        message: data.message,
                        embed: data.embed
                    }, ((err, res) => {
                        if(err) throw err;
                        socket.emit('callback', {
                            id: id,
                            messageID: res.id,
                            channelID: res.channel_id,
                            error: false,
                            message: "Success!"
                        });
                    }));
                    break;
                case 'react':
                    bot.addReaction({
                        channelID: data.channelID,
                        messageID: data.messageID,
                        reaction: data.reaction
                    }, (err, res) => {
                        if(!err) {
                            socket.emit('callback', {
                                id: id,
                                error: false,
                                message: "Success!"
                            });
                        } else {
                            socket.emit('callback', {
                                id: id,
                                error: true,
                                message: err
                            });
                        }
                    });
                    break;
                case 'delete':
                    bot.deleteMessage({
                        messageID: data.messageID,
                        channelID: data.channelID
                    }, (err)=> {
                        if(err) throw err;
                        socket.emit('callback', {
                            id: id,
                            error: false,
                            message: "deleted message!"
                        });
                    });
                    break;
                default:
                    console.log(data);
                    socket.emit('callback', {
                        id: id,
                        error: true,
                        message: "Invalid request type!",
                        type: type
                    });
                    break;
            }
        });

    }

    sendMessage(username, uuid, message) {
        for(let [channelID, channel] of Object.entries(this.channels)) {
            if(channel.chat) {
                channel.sendMessage(username, uuid, message);
            }
        }
    }

    getUser(username, cb) {
        pool.query(
            "SELECT * FROM `users` WHERE `username` = ? AND `serverID` = ?;",
            [username, this.serverID], cb
        );
    }
}

// Key: Server ID, Value: Server
const servers = {};

io.on('connection', (socket) => {

    let server;

    // Add the options and the server information for each socket
    socket.on("options", (data) => {
        let serverID = data.serverID;
        let enforceNickname = data.enforceNickname;
        let token = data.token;
        let defaultRole = data.defaultRole;

        // Make sure server has authentication token to connect
        if(token != null) {
            pool.query("SELECT * FROM `servers` WHERE `serverID` = ? AND `token` = ?;",
                [serverID, token],
                (err, res) => {
                    if(err) throw err;
                    // This means there is a match
                    if(res.length === 1) {
                        server = servers[serverID];
                        if(server != null) server.socket.disconnect();

                        let channels = {};

                        for(let channel of data.channels) {
                            channels[channel.channelID] = new Channel(
                                channel.webhookID,
                                channel.webhookToken,
                                channel.chat,
                                channel.info,
                                channel.requireVerification,
                                channel.adminCommands
                            );
                        }

                        server = new Server(serverID, channels, defaultRole, enforceNickname, socket);
                        servers[serverID] = server;

                        console.log("Connected to client!");
                    } else {
                        socket.disconnect();
                    }
                }
            );
        } else {
            // Server does not have proper authentication, disconnect
            console.log(socket + ": Failed authentication!");
            socket.disconnect();
        }
    });

});

/**
 * This is called when a user sends a message
 * It will forward the message to the sockets if it is a command
 * or a chat
 */
bot.on('message', (user, userID, channelID, message, event) => {
    // Get the server from the channel ID
    // let serverID = serverChannels[channelID];
    let serverID = event.d.guild_id;
    let server = servers[serverID];

    // Check if there is a server connected with that channelID
    if(server != null) {
        let socket = server.socket;
        let channel = server.channels[channelID];
        if(channel != null) {
            if (userID !== bot.id && userID !== channel.webhookClient.id) {
                // Check if the message is a command
                if (message.substring(0, 1) === '!') {
                    // The arguments is the string split by the
                    let args = message.substring(1).split(' ');
                    let cmd = args[0].toLowerCase();
                    // Remove the command name from the arguments
                    args = args.splice(1);
                    // This is the one command that is dedicated to the API
                    if (cmd === "verify") {
                        if (args.length === 1) {
                            // Check if the user is already verified
                            let username = args[0].replace(/[^a-zA-Z0-9_]/g, "");
                            username = username.replace(/[_]/g, "!_").toLowerCase();
                            pool.query(
                                "SELECT * FROM `users` WHERE `username` LIKE '" + username + "%' AND `serverID` = ?;",
                                [serverID],
                                (err, res) => {
                                    if (err) throw err;
                                    if (res.length === 0) {
                                        crypto.randomBytes(16, (err, buf) => {
                                            if (err) throw err;
                                            // Attempt to send the verification message to the user in game
                                            socket.emit("verify", {
                                                discord: {
                                                    username: event.d.author.username,
                                                    discriminator: event.d.author.discriminator
                                                },
                                                user: user,
                                                userID: userID,
                                                channelID: channelID,
                                                username: args[0],
                                                code: buf.toString('hex')
                                            });
                                        });
                                    } else {
                                        bot.sendMessage({
                                            to: channelID,
                                            message: "That player is already verified!"
                                        });
                                    }
                                }
                            );
                        } else {
                            bot.sendMessage({
                                to: channelID,
                                message: "Usage: !verify <username>"
                            });
                        }
                    } else if (cmd === 'unlink') {
                        pool.query(
                            "DELETE FROM `users` WHERE `userID` = ? AND `serverID` = ?;",
                            [userID, serverID],
                            (err, res) => {
                                if (err) throw err;
                                if (res.affectedRows >= 1) {
                                    bot.sendMessage({
                                        to: channelID,
                                        message: "Sucessfully unlinked your account!"
                                    });
                                } else {
                                    bot.sendMessage({
                                        to: channelID,
                                        message: "Cannot unlink account. You are not verified!"
                                    });
                                }
                            }
                        );
                    } else {
                        pool.query(
                            "SELECT * FROM `users` WHERE `userID` = ? AND `serverID` = ?;",
                            [userID, serverID],
                            (err, res) => {
                                if (err) throw err;

                                let username = null;
                                let uuid = null;

                                if (res.length === 1) {
                                    username = res[0].username;
                                    uuid = res[0].uuid;
                                }
                                console.log(username, uuid, cmd, channelID, event);
                                // Send the command to the minecraft server
                                socket.emit("command", {
                                    sender: {
                                        username: username,
                                        user: user,
                                        userID: userID,
                                        uuid: uuid
                                    },
                                    author: event.d.author,
                                    command: cmd,
                                    channelID: channelID,
                                    messageID: event.d.id,
                                    args: args
                                });
                            }
                        );
                    }
                    // This means that the message sent is to go towards chat
                } else {
                    // Get the channel settings for the channel the message is sent in
                    let channel = server.channels[channelID];
                    // If the channel allows for admin commands
                    if (channel.chat) {
                        // Send a chat message event to the server
                        if (channel.requireVerification) {
                            pool.query(
                                "SELECT * FROM `users` WHERE `userID` = ? AND `serverID` = ?;",
                                [userID, serverID],
                                (err, res) => {
                                    if (err) throw err;
                                    if (res.length === 1) {
                                        let row = res[0];
                                        // get info from the user
                                        let username = row.username;
                                        // send the message
                                        socket.emit("message", {
                                            sender: {
                                                user: user,
                                                userID: userID,
                                                username: username,
                                                uuid: row.uuid
                                            },
                                            message: message,
                                            channelID: channelID
                                        });
                                    } else {
                                        bot.deleteMessage({
                                            channelID: channelID,
                                            messageID: event.d.id
                                        });
                                        bot.sendMessage({
                                            to: channelID,
                                            message: "You must first verify your account before you can send messages here!"
                                        });
                                    }
                                }
                            );
                        } else {
                            socket.emit("message", {
                                sender: {
                                    user: user,
                                    userID: userID,
                                    username: null,
                                },
                                message: message,
                                channelID: channelID
                            });
                        }
                    }
                }
            }
        }
    }
});

bot.on('any', event => {
    if(event.t === 'MESSAGE_REACTION_ADD' || event.t === 'MESSAGE_REACTION_REMOVE') {
        let d = event.d;
        let serverID = d.guild_id;
        let messageID = d.message_id;
        let channelID = d.channel_id;
        let userID = d.user_id;
        let emoji = d.emoji;

        // AKA a Direct Message
        if(serverID == null) {
            pool.query(
                "SELECT * FROM `users` WHERE `userID` = ?;",
                [userID],
                (err, res) => {
                    if(err) throw err;
                    for(let row of res) {
                        let server = servers[row.serverID];
                        if(server != null) {
                            server.socket.emit('reactionEvent', {
                                user: {
                                    verified: true,
                                    user: row.user,
                                    userID: row.userID,
                                    username: row.username,
                                    uuid: row.uuid
                                },
                                messageID: messageID,
                                channelID: channelID,
                                emoji: emoji,
                                type: event.t
                            });
                        }
                    }
                }
            )
        }

        let server = servers[serverID];
        if(server != null) {
            // Try to find a user with that userID
            pool.query(
            "SELECT * FROM `users` WHERE `userID` = ? AND `serverID` = ?;",
            [userID, serverID],
            (err, res) => {
                if(err) throw err;

                if(res.length >= 1) {
                    let row = res[0];
                    server.socket.emit('reactionEvent', {
                        user: {
                            verified: true,
                            user: row.user,
                            userID: row.userID,
                            username: row.username,
                            uuid: row.uuid
                        },
                        messageID: messageID,
                        channelID: channelID,
                        emoji: emoji,
                        type: event.t
                    });
                } else {
                    server.socket.emit('reactionEvent', {
                        user: {
                            verified: false,
                            userID: userID
                        },
                        messageID: messageID,
                        channelID: channelID,
                        emoji: emoji,
                        type: event.t
                    });
                }
            });
        }
    }
});

rl.on('line', (input) => {
    if(input !== '') {
        let args = input.split(' ');
        let cmd = args[0].toLowerCase();
        args = args.splice(1);

        switch(cmd) {
            case 'register':
                // Force register a new server (Waves subscription fee)
                if (args.length === 1) {
                    let serverID = args[0];
                    // Check if a server with that ID is already registered
                    pool.query("SELECT * FROM `servers` WHERE `serverID` = ?;", serverID, (err, res) => {
                        if(err) throw err;
                        if(res.length === 0) {
                            let bytes = crypto.randomBytes(32);
                            let token = bytes.toString("base64");
                            // Insert the server into the database
                            pool.query("INSERT INTO `servers`(`serverID`, `token`) VALUES(?, ?);",
                                [serverID, token],
                                (err) => {
                                    if(err) throw err;
                                    // Print out a confirmation message
                                    console.info(`The token for server '${serverID}' is '${token}'`);
                                }
                            );
                        } else {
                            console.info("That server is already registered!");
                        }
                    });
                } else {
                    console.info("register <serverID>");
                }
                break;
            case 'exit':
                // Exit the program
                process.exit(22);
                break;
            default:
                console.info("Invalid command!");
        }
    }
});

http.listen(8080, ()=> {
    console.log('listening on *:8080');
});