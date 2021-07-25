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
import {createHash} from 'crypto';
import { promisify } from "util";

export class NotesConnection {

constructor(args)
{
  this.redis = args.redis;
  this.mongo =args.mongo;
  this.notesio=args.notesio;
  this.notepadio= args.notepadio;
  this.getFileURL=args.getFileURL;

  
  this.noteshandlerURL=args.noteshandlerURL;

  this.signNotesJwt=args.signNotesJwt;



  this.SocketHandlerNotes=this.SocketHandlerNotes.bind(this);
 

};

  
async SocketHandlerNotes(socket) {
    var address = socket.client.conn.remoteAddress;
    console.log("Notes %s with ip %s  connected", socket.id,
      address);
    console.log("Notes name", socket.decoded_token.name);
    console.log("Notes lecture uuid", socket.decoded_token.lectureuuid);



    var purenotes = {
      socketid: socket.id,
      lectureuuid: socket.decoded_token.lectureuuid,
      name: socket.decoded_token.name,
      purpose: "notes",
    };


    let curtoken=socket.decoded_token;




    console.log("notes connected");
    

    //bIG TODO
    this.getLectDetail(purenotes,socket);
    
    console.log("notes send board data");
    this.sendBoardsToSocket(purenotes.lectureuuid, socket);
    purenotes.roomname = this.getRoomName(purenotes.lectureuuid);
    console.log("notes is connected to notepad, join room", purenotes.roomname);
    socket.join(purenotes.roomname);


    {
      let token=await this.getNotesToken(curtoken);
      curtoken=token.decoded; 
      socket.emit('authtoken',{token: token.token });
    }

    socket.on('reauthor', async function() {
      // we use the information from the already present authtoken
      let token=await this.getNotesToken(curtoken); 
      curtoken=token.decoded;
      socket.emit('authtoken',{token: token.token });
    }.bind(this));

    socket.on('chatquestion',function(cmd) {
      if (cmd.text) {
        let messagehash=createHash('sha256');
        let useruuid=socket.decoded_token.user.useruuid;
        let displayname=socket.decoded_token.user.displayname;
        // now we create a hash that can be used to identify a user, if and only if,
        // access to this database is available and not between lectures!
        messagehash.update(useruuid+purenotes.lectureuuid);
        let userhash=messagehash.digest('hex');

        this.notepadio.to(purenotes.roomname).emit('chatquestion',{
          displayname: displayname,
          text: cmd.text,
          userhash: userhash
        });

        //console.log("chat send", cmd.text,socket.decoded_token);
      }
      //console.log("chatquestion",cmd);
    }.bind(this));
   
    socket.on('castvote',async function(data,callback) {
      console.log("db cv data",data);
      console.log("db cv callback",callback);
     /* console.log("db cv1", data.pollid && data.pollid.match(/^[0-9a-zA-Z]{9}$/.test));
      console.log("db cv2",data.selection && ((data.selection && typeof data.selection=="string" && data.selection.match(/^[0-9a-zA-Z]{9}$/))));
      console.log("db cv3",(( typeof data.selection=="string" && data.selection.match(/^[0-9a-zA-Z]{9}$/))));
      console.log("db cv3",( Array.isArray(data.selection) && data.selection.filter((el)=>(el.match(/^[0-9a-zA-Z]{9}$/))).length>0));*/
      if (data.pollid && /^[0-9a-zA-Z]{9}$/.test(data.pollid)
        && data.selection && ((typeof data.selection == "string" && /^[0-9a-zA-Z]{9}$/.test(data.selection))
          || (Array.isArray(data.selection) && data.selection.filter((el) => (/^[0-9a-zA-Z]{9}$/.test(el))).length > 0))
      ) {
        let useruuid = socket.decoded_token.user.useruuid;
        try {
          let ballothash = createHash('sha256');
          ballothash.update(useruuid + data.pollid);
          let client=this.redis;
          let get = promisify(this.redis.get).bind(client);

          let salt = await get("pollsalt:lecture:" + purenotes.lectureuuid + ":poll:" + data.pollid);
          ballothash.update(salt);
          let ballotid = ballothash.digest('hex');
          this.notepadio.to(purenotes.roomname).emit('castvote', {
            ballotid: ballotid,
            vote: data.selection,
            pollid: data.pollid
          });
          callback({ballot: ballotid});
        } catch (err) {
          console.log("failed to get salt", err);
          callback({ error: "failure" });
        }
      } else callback({ error: "failure" });
    }.bind(this)
    );

    



    socket.on('disconnect', function () {
      console.log("Notes Client %s with ip %s  disconnected", socket.id,
        address);
      if (purenotes) {
        if (purenotes.roomname) {
          socket.leave(purenotes.roomname);
          console.log("notes disconnected leave room", purenotes.roomname);
          purenotes.roomname = null;
        }
       
      }
     
    }.bind(this));

  }




async getNotesToken(oldtoken)
{
  let newtoken={
    lectureuuid: oldtoken.lectureuuid,
    purpose: "notes", // in case a bug is there, no one should escape the realm
    name: oldtoken.name,
    user: oldtoken.user,
    noteshandler: this.noteshandlerURL,
    maxrenew: (oldtoken.maxrenew-1)
  };
  if (!oldtoken.maxrenew || !(oldtoken.maxrenew>0)) return {error: "maxrenew token failed", oldtoken: oldtoken};
  return {token: await this.signNotesJwt(newtoken), decoded: newtoken};
} 


async getBgpdf(notepadscreenid)
{
  let lecturedoc={};
  try {
    let lecturescol=this.mongo.collection("lectures");
    lecturedoc=await lecturescol.findOne({"uuid": notepadscreenid.lectureuuid}, {projection: 
      {"_id": 0, backgroundpdfuse: 1 , backgroundpdf: 1  }});
    //console.log("lecturedoc",lecturedoc);
    if (!lecturedoc.backgroundpdfuse || !lecturedoc.backgroundpdf 
      || !lecturedoc.backgroundpdf.sha) return null;
    return this.getFileURL(lecturedoc.backgroundpdf.sha,'application/pdf');

  } catch (err) {
    console.log("error in getBgpdf pictures", err);
  }
 
}

async getUsedPicts(notepadscreenid)
{
  let lecturedoc={};
  try {
    let lecturescol=this.mongo.collection("lectures");
    lecturedoc=await lecturescol.findOne({"uuid": notepadscreenid.lectureuuid}, {projection: 
      {"_id": 0, usedpictures: 1   }});
    //console.log("lecturedoc",lecturedoc);
    if (!lecturedoc.usedpictures) return [];

    return lecturedoc.usedpictures.map((el)=>
                        {return {name: el.name, mimetype: el.mimetype, 
                            sha: el.sha.buffer.toString('hex'),
                            url: this.getFileURL(el.sha.buffer,el.mimetype),
                           urlthumb: this.getFileURL(el.tsha.buffer,el.mimetype)}});
    // ok now I have the picture, but I also have to generate the urls  

  } catch (err) {
    console.log("error in getUsedPicts pictures", err);
  }
}



async getLectDetail(notepadscreenid,socket)
{ // TODO should be feed from mongodb

  let lecturedoc={};
  try {
    let lecturescol=this.mongo.collection("lectures");

    let andquery=[];

    andquery.push({"uuid": notepadscreenid.lectureuuid });

    // TODO add course stuff
    //console.log("andquery", andquery);
    lecturedoc=await lecturescol.findOne({"uuid": notepadscreenid.lectureuuid}, {projection: 
            {"_id": 0, title: 1, coursetitle: 1, ownersdisplaynames: 1, date:1   }});

  } catch (err) {
    console.log("error in get LectDetail", err);
  }

  var lectdetail= {
    title: lecturedoc.title,
    coursetitle: lecturedoc.coursetitle,
    instructors: lecturedoc.ownersdisplaynames,
    date: lecturedoc.date 
  };
  //if (notepadscreenid.notepaduuid) lectdetail.notepaduuid=notepadscreenid.notepaduuid;
  socket.emit('lecturedetail', lectdetail);

}

// TODO
async sendBoardsToSocket(lectureuuid, socket) {
  //we have to send first information about pictures

  let usedpict= await this.getUsedPicts({lectureuuid: lectureuuid});
  if (usedpict) {
    socket.emit('pictureinfo',usedpict);
  }
  let bgpdf= await this.getBgpdf({lectureuuid: lectureuuid});
  if (bgpdf) {
    socket.emit('bgpdfinfo',{bgpdfurl: bgpdf});
  } else {
    socket.emit('bgpdfinfo',{none: true});
  }
  
  
  this.redis.smembers("lecture:"+lectureuuid+":boards", function (err,res) { //TODO sync to mongodb
    if (err) console.log("boards in sendBoardsToSocket picture",err);
    else {
      console.log("boards",res,"lecture:"+lectureuuid+":boards");
        var length=res.length;
        var countdown=length;
        for (let index in res) {
            let boardnum=res[index];
            console.log("sendBoardsToSocket",boardnum,lectureuuid);
            this.redis.get(Buffer.from("lecture:"+lectureuuid+":board"+boardnum), function(err2,res2) {
                if (err2) console.log("get board in sendBoardsToSocket picture",err2);
                countdown--;
               // console.log("send reloadboard",boardnum,res2,length);
                var send={ number: boardnum, data: res2,
                    last: countdown==0};
                socket.emit('reloadBoard',send);
           });
        }
  }
  }.bind(this));



};


getRoomName(uuid)
{
    return uuid;
}


 




}

