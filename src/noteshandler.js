/* eslint-disable node/no-callback-literal */
/*
    Fails Components (Fancy Automated Internet Lecture System - Components)
    Copyright (C)  2015-2017 (original FAILS), 
                   2021- (FAILS Components)  Marten Richter <marten.richter@freenet.de>

    This program is free software: you can redistribute it and/or modify
    it under the terms of the GNU Affero General Public License as
    published by the Free Software Foundation, either version 3 of the
    License, or (at your option) any later version.

    This program is distributed in the hope that it will be useful,
    but WITHOUT ANY WARRANTY; without even the implied warranty of
    MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
    GNU Affero General Public License for more details.

    You should have received a copy of the GNU Affero General Public License
    along with this program.  If not, see <https://www.gnu.org/licenses/>.
*/
import { createHash } from 'crypto'
import { CommonConnection } from './commonhandler.js'

export class NotesConnection extends CommonConnection {
  constructor(args) {
    super(args)
    this.redis = args.redis
    this.mongo = args.mongo
    this.notesio = args.notesio
    this.notepadio = args.notepadio
    this.getFileURL = args.getFileURL

    this.noteshandlerURL = args.noteshandlerURL

    this.signNotesJwt = args.signNotesJwt

    this.SocketHandlerNotes = this.SocketHandlerNotes.bind(this)
  }

  async SocketHandlerNotes(socket) {
    const address = socket.handshake.headers['x-forwarded-for']
      .split(',')
      .map((el) => el.trim()) || [socket.client.conn.remoteAddress]
    console.log('Notes %s with ip %s  connected', socket.id, address)
    console.log('Notes name', socket.decoded_token.name)
    console.log('Notes lecture uuid', socket.decoded_token.lectureuuid)

    const purenotes = {
      socketid: socket.id,
      lectureuuid: socket.decoded_token.lectureuuid,
      name: socket.decoded_token.name,
      displayname: socket.decoded_token.user.displayname,
      appversion: socket.decoded_token.appversion,
      purpose: 'notes'
    }

    let curtoken = socket.decoded_token

    // console.log('notes connected')

    this.getLectDetail(purenotes, socket)

    // console.log('notes send board data')
    this.sendBoardsToSocket(purenotes.lectureuuid, socket)
    purenotes.roomname = this.getRoomName(purenotes.lectureuuid)
    {
      const messagehash = createHash('sha256')
      const useruuid = socket.decoded_token.user.useruuid
      // now we create a hash that can be used to identify a user, if and only if,
      // access to this database is available and not between lectures!
      messagehash.update(useruuid + purenotes.lectureuuid)
      purenotes.userhash = messagehash.digest('hex')
    }
    // console.log('notes is connected to notepad, join room', purenotes.roomname)
    socket.join(purenotes.roomname)

    {
      const token = await this.getNotesToken(curtoken)
      curtoken = token.decoded
      socket.emit('authtoken', { token: token.token })
    }

    {
      const presinfo = this.getPresentationinfo(purenotes)
      const readypresinfo = await presinfo
      socket.emit('presinfo', readypresinfo)
    }

    this.emitAVOffers(socket, purenotes)

    socket.on(
      'reauthor',
      async function () {
        // we use the information from the already present authtoken
        this.addUpdateCryptoIdent(purenotes)
        const token = await this.getNotesToken(curtoken)
        curtoken = token.decoded
        socket.emit('authtoken', { token: token.token })
      }.bind(this)
    )

    socket.on('chatquestion', (cmd) => {
      if (cmd.text) {
        const displayname = socket.decoded_token.user.displayname
        const userhash = purenotes.userhash

        this.notepadio.to(purenotes.roomname).emit('chatquestion', {
          displayname: displayname,
          text: cmd.text,
          userhash: userhash
        })

        // console.log("chat send", cmd.text,socket.decoded_token);
      }
      // console.log("chatquestion",cmd);
    })

    socket.on(
      'castvote',
      async function (data, callback) {
        // console.log('db cv data', data)
        // console.log('db cv callback', callback)
        /* console.log("db cv1", data.pollid && data.pollid.match(/^[0-9a-zA-Z]{9}$/.test));
      console.log("db cv2",data.selection && ((data.selection && typeof data.selection=="string" && data.selection.match(/^[0-9a-zA-Z]{9}$/))));
      console.log("db cv3",(( typeof data.selection=="string" && data.selection.match(/^[0-9a-zA-Z]{9}$/))));
      console.log("db cv3",( Array.isArray(data.selection) && data.selection.filter((el)=>(el.match(/^[0-9a-zA-Z]{9}$/))).length>0)); */
        if (
          data.pollid &&
          /^[0-9a-zA-Z]{9}$/.test(data.pollid) &&
          data.selection &&
          ((typeof data.selection === 'string' &&
            /^[0-9a-zA-Z]{9}$/.test(data.selection)) ||
            (Array.isArray(data.selection) &&
              data.selection.filter((el) => /^[0-9a-zA-Z]{9}$/.test(el))
                .length > 0))
        ) {
          const useruuid = socket.decoded_token.user.useruuid
          try {
            const ballothash = createHash('sha256')
            ballothash.update(useruuid + data.pollid)

            const salt = await this.redis.get(
              'pollsalt:lecture:' +
                purenotes.lectureuuid +
                ':poll:' +
                data.pollid
            )
            ballothash.update(salt)
            const ballotid = ballothash.digest('hex')
            this.notepadio.to(purenotes.roomname).emit('castvote', {
              ballotid: ballotid,
              vote: data.selection,
              pollid: data.pollid
            })
            callback({ ballot: ballotid })
          } catch (err) {
            console.log('failed to get salt', err)
            callback({ error: 'failure' })
          }
        } else callback({ error: 'failure' })
      }.bind(this)
    )

    socket.on('keyInfo', (cmd) => {
      if (cmd.cryptKey && cmd.signKey) {
        purenotes.cryptKey = cmd.cryptKey
        purenotes.signKey = cmd.signKey
        this.addUpdateCryptoIdent(purenotes)
      }
    })

    socket.on('keymasterQuery', () => {
      this.handleKeymasterQuery(purenotes)
    })

    socket.on('disconnect', () => {
      console.log(
        'Notes Client %s with ip %s  disconnected',
        socket.id,
        address
      )
      if (purenotes) {
        if (purenotes.roomname) {
          socket.leave(purenotes.roomname)
          this.redis.hDel(
            'lecture:' + purenotes.lectureuuid + ':idents',
            purenotes.socketid
          )
          this.notepadio
            .to(purenotes.roomname)
            .emit('identDelete', { id: purenotes.socketid })
          // console.log('notes disconnected leave room', purenotes.roomname)
          purenotes.roomname = null
        }
      }
    })

    {
      const pollstate = await this.getPollinfo(purenotes)
      if (pollstate) socket.emit(pollstate.command, pollstate.data)
    }
  }

  async getNotesToken(oldtoken) {
    const newtoken = {
      lectureuuid: oldtoken.lectureuuid,
      purpose: 'notes', // in case a bug is there, no one should escape the realm
      name: oldtoken.name,
      user: oldtoken.user,
      appversion: oldtoken.appversion,
      noteshandler: this.noteshandlerURL,
      maxrenew: oldtoken.maxrenew - 1
    }
    if (!oldtoken.maxrenew || !(oldtoken.maxrenew > 0))
      return { error: 'maxrenew token failed', oldtoken: oldtoken }
    return { token: await this.signNotesJwt(newtoken), decoded: newtoken }
  }

  async getPresentationinfo(args) {
    try {
      let lectprop = this.redis.hmGet('lecture:' + args.lectureuuid, [
        'casttoscreens',
        'backgroundbw',
        'showscreennumber'
      ])
      lectprop = await lectprop
      return {
        casttoscreens: lectprop[0] !== null ? lectprop[0] : 'false',
        backgroundbw: lectprop[1] !== null ? lectprop[1] : 'true',
        showscreennumber: lectprop[2] !== null ? lectprop[2] : 'false'
      }
    } catch (error) {
      console.log('getPresentationinfo', error)
      return null
    }
  }

  async getPollinfo(args) {
    try {
      const pollinfo = await this.redis.hGetAll(
        'lecture:' + args.lectureuuid + ':pollstate'
      )
      if (pollinfo.command && pollinfo.data)
        return { command: pollinfo.command, data: JSON.parse(pollinfo.data) }
      else return null
    } catch (error) {
      console.log('getPollInfo failed', error)
      return null
    }
  }
}
