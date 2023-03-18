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

import { commandOptions } from 'redis'

export class CommonConnection {
  async getBgpdf(notepadscreenid) {
    let lecturedoc = {}
    try {
      const lecturescol = this.mongo.collection('lectures')
      lecturedoc = await lecturescol.findOne(
        { uuid: notepadscreenid.lectureuuid },
        {
          projection: { _id: 0, backgroundpdfuse: 1, backgroundpdf: 1 }
        }
      )
      // console.log("lecturedoc",lecturedoc);
      if (
        !lecturedoc.backgroundpdfuse ||
        !lecturedoc.backgroundpdf ||
        !lecturedoc.backgroundpdf.sha
      )
        return null
      return this.getFileURL(lecturedoc.backgroundpdf.sha, 'application/pdf')
    } catch (err) {
      console.log('error in getBgpdf pictures', err)
    }
  }

  async getUsedPicts(notepadscreenid) {
    let lecturedoc = {}
    try {
      const lecturescol = this.mongo.collection('lectures')
      lecturedoc = await lecturescol.findOne(
        { uuid: notepadscreenid.lectureuuid },
        {
          projection: { _id: 0, usedpictures: 1 }
        }
      )
      // console.log("lecturedoc",lecturedoc);
      if (!lecturedoc.usedpictures) return []

      return lecturedoc.usedpictures.map((el) => {
        return {
          name: el.name,
          mimetype: el.mimetype,
          sha: el.sha.buffer.toString('hex'),
          url: this.getFileURL(el.sha.buffer, el.mimetype),
          urlthumb: this.getFileURL(el.tsha.buffer, el.mimetype)
        }
      })
      // ok now I have the picture, but I also have to generate the urls
    } catch (err) {
      console.log('error in getUsedPicts pictures', err)
    }
  }

  async sendBoardsToSocket(lectureuuid, socket) {
    // we have to send first information about pictures

    const usedpict = await this.getUsedPicts({ lectureuuid: lectureuuid })
    if (usedpict) {
      socket.emit('pictureinfo', usedpict)
    }
    const bgpdf = await this.getBgpdf({ lectureuuid: lectureuuid })
    if (bgpdf) {
      socket.emit('bgpdfinfo', { bgpdfurl: bgpdf })
    } else {
      socket.emit('bgpdfinfo', { none: true })
    }

    try {
      const res = await this.redis.sMembers(
        'lecture:' + lectureuuid + ':boards'
      )

      // console.log('boards', res, 'lecture:' + lectureuuid + ':boards')
      const length = res.length
      let countdown = length
      if (length === 0) socket.emit('reloadBoard', { last: true })
      for (const index in res) {
        const boardnum = res[index]
        // console.log('sendBoardsToSocket', boardnum, lectureuuid)
        try {
          const res2 = await this.redis.get(
            commandOptions({ returnBuffers: true }),
            'lecture:' + lectureuuid + ':board' + boardnum
          )

          countdown--
          // console.log('send reloadboard', boardnum, res2, length)
          const send = {
            number: boardnum,
            data: res2,
            last: countdown === 0
          }
          socket.emit('reloadBoard', send)
        } catch (error) {
          console.log('error in sendboard to sockets loop', error)
        }
      }
    } catch (error) {
      console.log('error in sendboard to sockets', error)
    }
  }

  async getLectDetail(notepadscreenid, socket) {
    // TODO should be feed from mongodb

    let lecturedoc = {}
    try {
      const lecturescol = this.mongo.collection('lectures')

      lecturedoc = await lecturescol.findOne(
        { uuid: notepadscreenid.lectureuuid },
        {
          projection: {
            _id: 0,
            title: 1,
            coursetitle: 1,
            ownersdisplaynames: 1,
            date: 1
          }
        }
      )
    } catch (err) {
      console.log('error in get LectDetail', err)
    }

    const lectdetail = {
      title: lecturedoc.title,
      coursetitle: lecturedoc.coursetitle,
      instructors: lecturedoc.ownersdisplaynames,
      date: lecturedoc.date
    }
    // if (notepadscreenid.notepaduuid) lectdetail.notepaduuid=notepadscreenid.notepaduuid;
    socket.emit('lecturedetail', lectdetail)
  }

  // sync changes to notes
  async addUpdateCryptoIdent(args) {
    const identity = {
      signKey: args.signKey,
      cryptKey: args.cryptKey,
      displayname: args.displayname,
      userhash: args.userhash,
      /* id: args.socketid, */
      purpose: args.purpose,
      lastaccess: Date.now().toString()
    }
    // Two things store it in redis until disconnect
    const oldident = this.redis.hGet(
      'lecture:' + args.lectureuuid + ':idents',
      args.socketid.toString()
    )
    this.redis.hSet('lecture:' + args.lectureuuid + ':idents', [
      args.socketid.toString(),
      JSON.stringify(identity)
    ])
    let oldid = await oldident
    if (oldid) oldid = JSON.parse(oldid)

    // and inform about new/updated identity
    const roomname = this.getRoomName(args.lectureuuid)

    if (
      oldid &&
      identity.signKey === oldid.signKey &&
      identity.cryptKey === oldid.cryptKey
    ) {
      this.notepadio.to(roomname).emit('identValidity', {
        lastaccess: identity.lastaccess,
        id: args.socketid
      })
    } else {
      this.notepadio
        .to(roomname)
        .emit('identUpdate', { identity: identity, id: args.socketid })
    }
  }

  async handleKeymasterQuery(args) {
    const now = Date.now() / 1000
    // ok, first we have to figure out if a query is already running
    try {
      await this.redis.executeIsolated(async (isoredis) => {
        await isoredis.watch('lecture:' + args.lectureuuid + ':keymaster')
        const queryInfo = await isoredis.hGet(
          'lecture:' + args.lectureuuid + ':keymaster',
          'queryTime'
        )
        /* console.log(
          'query Info',
          queryInfo,
          now - Number(queryInfo),
          now,
          Number(queryInfo)
        ) */

        if (queryInfo && now - Number(queryInfo) < 15) {
          // we have no key, so may be the kaymaster does not know that we exist
          await this.addUpdateCryptoIdent(args)
          return // do not spam the system with these queries 20 +10
        }

        const res = await isoredis
          .multi()
          .hSet('lecture:' + args.lectureuuid + ':keymaster', [
            'queryTime',
            now.toString(),
            'bidding',
            '0',
            'master',
            'none'
          ])
          .exec()
        if (res !== null) {
          const roomname = this.getRoomName(args.lectureuuid)
          // start the bidding
          this.notepadio.to(roomname).emit('keymasterQuery')
        }
      })
    } catch (error) {
      console.log('handleKeymasterQuery problem or multple attempts', error)
    }
  }

  async emitAVOffers(socket, args) {
    const alloffers = await this.redis.hGetAll(
      'lecture:' + args.lectureuuid + ':avoffers'
    )
    const offers = []
    for (const label in alloffers) {
      const labels = label.split(':')
      offers.push({
        type: labels[0],
        id: labels[1],
        time: alloffers[label]
      })
    }
    socket.emit('avofferList', { offers })
  }

  getRoomName(uuid) {
    return uuid
  }
}
