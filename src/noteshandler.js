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
    this.screenio = args.screenio
    this.getFileURL = args.getFileURL

    this.noteshandlerURL = args.noteshandlerURL

    this.signNotesJwt = args.signNotesJwt
    this.signAvsJwt = args.signAvsJwt

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
      features: socket.decoded_token.features,
      purpose: 'notes'
    }

    let curtoken = socket.decoded_token
    let routerres
    let routerurl = new Promise((resolve) => {
      routerres = resolve
    })

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
    this.emitVideoquestions(socket, purenotes)

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
          encData: cmd.encData,
          keyindex: cmd.keyindex,
          iv: cmd.iv,
          videoquestion: cmd.videoquestion
            ? { id: purenotes.socketid }
            : undefined,
          userhash: userhash
        })

        // console.log("chat send", cmd.text,socket.decoded_token);
      }
      // console.log("chatquestion",cmd);
    })

    socket.on('closevideoquestion', (cmd) => {
      this.closeVideoQuestion(purenotes, { id: purenotes.socketid }).catch(
        (error) => {
          console.log('Problem in closeVideoQuestion', error)
        }
      )
    })

    socket.on('avoffer', (cmd) => {
      this.handleVQoffer(purenotes, cmd).catch((error) => {
        console.log('Problem in handleVQoffer', error)
      })
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

    socket.on('getrouting', async (cmd, callback) => {
      let tempOut
      if (cmd.dir === 'out' && cmd.id === purenotes.socketid) {
        let toid
        try {
          await Promise.any([
            routerurl,
            new Promise((resolve, reject) => {
              toid = setTimeout(reject, 20 * 1000)
            })
          ])
          if (toid) clearTimeout(toid)
          toid = undefined
          tempOut = await this.getTempOutTransport(purenotes, await routerurl)
        } catch (error) {
          callback({ error: 'getrouting: timeout or error tempout: ' + error })
        }
      }

      if (
        cmd &&
        cmd.id &&
        cmd.dir &&
        (cmd.dir === 'in' || tempOut) /* || cmd.dir === 'out' */ // a notes can only receive, later with special permission
      ) {
        try {
          let toid
          await Promise.any([
            routerurl,
            new Promise((resolve, reject) => {
              toid = setTimeout(reject, 20 * 1000)
            })
          ])
          if (toid) clearTimeout(toid)
          toid = undefined
          this.getRouting(
            purenotes,
            { ...cmd, tempOut },
            await routerurl,
            callback
          )
        } catch (error) {
          callback({ error: 'getrouting: timeout or error: ' + error })
        }
      } else callback({ error: 'getrouting: malformed request' })
    })

    socket.on('gettransportinfo', (cmd, callback) => {
      let geopos
      if (cmd && cmd.geopos && cmd.geopos.longitude && cmd.geopos.latitude)
        geopos = {
          longitude: cmd.geopos.longitude,
          latitude: cmd.geopos.latitude
        }
      this.getTransportInfo(
        {
          ipaddress: address,
          geopos,
          lectureuuid: purenotes.lectureuuid,
          clientid: socket.id,
          canWrite: false
        },
        (ret) => {
          if (ret.url) {
            if (routerres) {
              const res = routerres
              routerres = undefined
              res(ret.url)
            }
            routerurl = ret.url
          } else routerurl = undefined
          callback(ret)
        }
      ).catch((error) => {
        console.log('Problem in getTransportInfo', error)
      })
    })

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

    socket.on('disconnect', async () => {
      console.log(
        'Notes Client %s with ip %s  disconnected',
        socket.id,
        address
      )
      if (purenotes) {
        if (purenotes.roomname) {
          socket.leave(purenotes.roomname)
          try {
            const proms = []
            proms.push(
              this.redis.hDel(
                'lecture:' + purenotes.lectureuuid + ':idents',
                purenotes.socketid
              )
            )
            proms.push(
              this.redis.hDel(
                'lecture:' + purenotes.lectureuuid + ':videoquestion',
                'permitted:' + purenotes.socketid
              )
            )
            this.notepadio
              .to(purenotes.roomname)
              .emit('identDelete', { id: purenotes.socketid })

            const promres = await Promise.all(proms)
            if (promres[1] > 0) {
              this.notepadio
                .to(purenotes.roomname)
                .emit('closevideoquestion', { id: purenotes.socketid })
              this.screenio
                .to(purenotes.roomname)
                .emit('closevideoquestion', { id: purenotes.socketid })
              this.notesio
                .to(purenotes.roomname)
                .emit('closevideoquestion', { id: purenotes.socketid })
            }
          } catch (error) {
            console.log('Problem disconnect:', error)
          }
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
      features: oldtoken.features,
      noteshandler: this.noteshandlerURL,
      maxrenew: oldtoken.maxrenew - 1
    }
    if (!oldtoken.maxrenew || !(oldtoken.maxrenew > 0))
      return { error: 'maxrenew token failed', oldtoken: oldtoken }
    return { token: await this.signNotesJwt(newtoken), decoded: newtoken }
  }

  async getTempOutTransport(args, routerurl) {
    try {
      // first check permissions
      const exists = await this.redis.hExists(
        'lecture:' + args.lectureuuid + ':videoquestion',
        'permitted:' + args.socketid
      )
      if (!exists) return
      // very well we have the permission, so generate a token for temperory perms

      const routercol = this.mongo.collection('avsrouters')

      const majorid = args.lectureuuid
      const clientid = args.lectureuuid + ':' + args.socketid
      const router = await routercol.findOne(
        {
          url: routerurl
        },
        {
          projection: {
            _id: 0,
            url: 1,
            region: 1,
            key: 1,
            spki: 1,
            primaryRealms: { $elemMatch: { $eq: majorid } },
            hashSalt: 1,
            localClients: { $elemMatch: { $eq: clientid } },
            remoteClients: { $elemMatch: { $eq: clientid } }
          }
        }
      )

      const calcHash = async (input) => {
        const hash = createHash('sha256')
        hash.update(input)
        // console.log('debug router info', router)
        hash.update(router.hashSalt)
        return hash.digest('base64')
      }

      const realmhash = calcHash(args.lectureuuid)
      const clienthash = calcHash(args.socketid)

      let token = {}
      // todo hash table
      token.accessWrite = [
        (await realmhash).replace(/[+/]/g, '\\$&') +
          ':' +
          (await clienthash).replace(/[+/]/g, '\\$&')
      ]
      token.realm = await realmhash
      token.client = await clienthash
      token = this.signAvsJwt(token)
      return await token
    } catch (error) {
      console.log('Problem getTempOutTransport', error)
      throw new Error()
    }
  }

  async handleVQoffer(args, cmd) {
    // ok to things to do, inform the others about the offer
    // and store the information in redis

    if (
      cmd.type !== 'video' &&
      cmd.type !== 'audio' /* && cmd.type !== 'screen' */
    ) {
      return
    }

    const roomname = this.getRoomName(args.lectureuuid)

    const message = {
      id: args.socketid,
      type: cmd.type,
      db: cmd.db // loundness in case of audio
    }

    this.notepadio.to(roomname).emit('vqoffer', message)
    this.screenio.to(roomname).emit('vqoffer', message)
    this.notesio.to(roomname).emit('vqoffer', message)

    // VQ offers are not saved
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
