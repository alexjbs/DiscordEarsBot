/* eslint-disable spaced-comment */
//////////////////////////////////////////
//////////////// LOGGING /////////////////
//////////////////////////////////////////
function getCurrentDateString () {
  return (new Date()).toISOString() + ' ::'
};
const __originalLog = console.log
console.log = function () {
  var args = [].slice.call(arguments)
  __originalLog.apply(console.log, [getCurrentDateString()].concat(args))
}
//////////////////////////////////////////
//////////////////////////////////////////

const fs = require('fs')
const util = require('util')
const path = require('path')
//////////////////////////////////////////
//////////////// CONFIG //////////////////
//////////////////////////////////////////

const SETTINGS_FILE = 'settings.json'

let DISCORD_TOK = null
let witAPIKEY = null

function loadConfig () {
  try {
    const CFG_DATA = JSON.parse(fs.readFileSync(SETTINGS_FILE, 'utf8'))

    DISCORD_TOK = CFG_DATA.discord_token
    witAPIKEY = CFG_DATA.wit_ai_token
    console.log('Config loaded!')
  } catch (e) {
    console.log('loadConfig: ' + e)
  }
}
loadConfig()
//////////////////////////////////////////
//////////////////////////////////////////
//////////////////////////////////////////

//////////////////////////////////////////
///////////////// VARIA //////////////////
//////////////////////////////////////////

function necessaryDirs () {
  if (!fs.existsSync('./temp/')) {
    fs.mkdirSync('./temp/')
  }
  if (!fs.existsSync('./data/')) {
    fs.mkdirSync('./data/')
  }
}
necessaryDirs()

function cleanTemp () {
  const dd = './temp/'
  fs.readdir(dd, (err, files) => {
    if (err) throw err

    for (const file of files) {
      fs.unlink(path.join(dd, file), err => {
        if (err) throw err
      })
    }
  })
}
cleanTemp() // clean files at startup

function sleep (ms) {
  return new Promise((resolve) => {
    setTimeout(resolve, ms)
  })
}

async function convertAudio (infile, outfile, cb) {
  try {
    const SoxCommand = require('sox-audio')
    const command = SoxCommand()
    const streamin = fs.createReadStream(infile)
    const streamout = fs.createWriteStream(outfile)
    command.input(streamin)
      .inputSampleRate(48000)
      .inputEncoding('signed')
      .inputBits(16)
      .inputChannels(2)
      .inputFileType('raw')
      .output(streamout)
      .outputSampleRate(16000)
      .outputEncoding('signed')
      .outputBits(16)
      .outputChannels(1)
      .outputFileType('wav')

    command.on('end', function () {
      streamout.close()
      streamin.close()
      cb()
    })
    command.on('error', function (err, stdout, stderr) {
      console.log('Cannot process audio: ' + err.message)
      console.log('Sox Command Stdout: ', stdout)
      console.log('Sox Command Stderr: ', stderr)
    })

    command.run()
  } catch (e) {
    console.log('convertAudio: ' + e)
  }
}
//////////////////////////////////////////
//////////////////////////////////////////
//////////////////////////////////////////

const Discord = require('discord.js')
// const DISCORD_MSG_LIMIT = 2000
const discordClient = new Discord.Client()
discordClient.on('ready', () => {
  console.log(`Logged in as ${discordClient.user.tag}!`)
})
discordClient.login(DISCORD_TOK)

const PREFIX = '*'
const _CMD_HELP = PREFIX + 'help'
const _CMD_JOIN = PREFIX + 'join'
const _CMD_LEAVE = PREFIX + 'leave'
const _CMD_DEBUG = PREFIX + 'debug'
const _CMD_TEST = PREFIX + 'hello'

const guildMap = new Map()

discordClient.on('message', async (msg) => {
  try {
    if (!('guild' in msg) || !msg.guild) return // prevent private messages to bot
    const mapKey = msg.guild.id
    if (msg.content.trim().toLowerCase() === _CMD_JOIN) {
      if (!msg.member.voice.channelID) {
        msg.reply('Error: please join a voice channel first.')
      } else {
        if (!guildMap.has(mapKey)) { await connect(msg, mapKey) } else { msg.reply('Already connected') }
      }
    } else if (msg.content.trim().toLowerCase() === _CMD_LEAVE) {
      if (guildMap.has(mapKey)) {
        const val = guildMap.get(mapKey)
        if (val.voiceChannel) val.voiceChannel.leave()
        if (val.voiceConnection) val.voiceConnection.disconnect()
        if (val.musicYTStream) val.musicYTStream.destroy()
        guildMap.delete(mapKey)
        msg.reply('Disconnected.')
        console.log('Disconnected from voice channel ' + msg.member.voice.channelID)
      } else {
        msg.reply('Cannot leave because not connected.')
      }
    } else if (msg.content.trim().toLowerCase() === _CMD_HELP) {
      msg.reply(getHelpString())
    } else if (msg.content.trim().toLowerCase() === _CMD_DEBUG) {
      console.log('toggling debug mode')
      const val = guildMap.get(mapKey)
      if (val.debug) { val.debug = false } else { val.debug = true }
    } else if (msg.content.trim().toLowerCase() === _CMD_TEST) {
      msg.reply('hello back =)')
    }
  } catch (e) {
    console.log('discordClient message: ' + e)
    msg.reply('Error#180: Something went wrong, try again or contact the developers if this keeps happening.')
  }
})

function getHelpString () {
  let out = '**COMMANDS:**\n'
  out += '```'
  out += PREFIX + 'join\n'
  out += PREFIX + 'leave\n'
  out += '```'
  return out
}

const { Readable } = require('stream')

const SILENCE_FRAME = Buffer.from([0xF8, 0xFF, 0xFE])

class Silence extends Readable {
  _read () {
    this.push(SILENCE_FRAME)
    this.destroy()
  }
}

async function connect (msg, mapKey) {
  try {
    const voiceChannel = await discordClient.channels.fetch(msg.member.voice.channelID)
    if (!voiceChannel) return msg.reply('Error: The voice channel does not exist!')
    const textChannel = await discordClient.channels.fetch(msg.channel.id)
    if (!textChannel) return msg.reply('Error: The text channel does not exist!')
    const voiceConnection = await voiceChannel.join()
    voiceConnection.play(new Silence(), { type: 'opus' })
    guildMap.set(mapKey, {
      textChannel: textChannel,
      voiceChannel: voiceChannel,
      voiceConnection: voiceConnection,
      musicQueue: [],
      musicDispatcher: null,
      musicYTStream: null,
      currentPlayingTitle: null,
      currentPlayingQuery: null,
      debug: false
    })
    speakImpl(voiceConnection, mapKey)
    voiceConnection.on('disconnect', async (e) => {
      if (e) console.log(e)
      guildMap.delete(mapKey)
    })
    msg.reply('connected!')
    console.log('Connected to voice channel ' + msg.member.voice.channelID)
  } catch (e) {
    console.log('connect: ' + e)
    msg.reply('Error: unable to join your voice channel.')
    throw e
  }
}

function speakImpl (voiceConnection, mapKey) {
  voiceConnection.on('speaking', async (user, speaking) => {
    if (speaking.bitfield === 0 /*|| user.bot*/) {
      return
    }
    console.log(`I'm listening to ${user.username}`)

    const filename = './temp/audio_' + mapKey + '_' + user.username.replace(/[^a-z0-9]/gi, '_').toLowerCase() + '_' + Date.now() + '.tmp'
    const ws = fs.createWriteStream(filename)

    // this creates a 16-bit signed PCM, stereo 48KHz stream
    const audioStream = voiceConnection.receiver.createStream(user, { mode: 'pcm' })
    audioStream.pipe(ws)

    audioStream.on('error', (e) => {
      console.log('audioStream: ' + e)
    })
    ws.on('error', (e) => {
      console.log('ws error: ' + e)
    })
    audioStream.on('end', async () => {
      const stats = fs.statSync(filename)
      const fileSizeInBytes = stats.size
      const duration = fileSizeInBytes / 48000 / 4
      console.log('duration: ' + duration)

      if (duration < 0.5 || duration > 19) {
        console.log('TOO SHORT / TOO LONG; SKPPING')
        fs.unlinkSync(filename)
        return
      }

      const newfilename = filename.replace('.tmp', '.raw')
      fs.rename(filename, newfilename, (err) => {
        if (err) {
          console.log('ERROR270:' + err)
          fs.unlinkSync(filename)
        } else {
          const val = guildMap.get(mapKey)
          const infile = newfilename
          const outfile = newfilename + '.wav'
          try {
            convertAudio(infile, outfile, async () => {
              const out = await transcribeWitai(outfile)
              if (out != null) { processCommandsQuery(out, mapKey, user) }
              if (!val.debug) {
                fs.unlinkSync(infile)
                fs.unlinkSync(outfile)
              }
            }).catch((error) => { // try to hadle "UnhandledPromiseRejectionWarning:
              // TypeError: Cannot read property 'text_Channel' of undefined"
              console.log('convertAudio error occured!')
              console.error(error)
            })
          } catch (e) {
            console.log('tmpraw rename: ' + e)
            if (!val.debug) {
              fs.unlinkSync(infile)
              fs.unlinkSync(outfile)
            }
          }
        }
      })
    })
  })
}

function processCommandsQuery (txt, mapKey, user) {
  if (txt && txt.length) {
    try {
      const val = guildMap.get(mapKey)
      val.textChannel.send(user.username + ': ' + txt)
    } catch (e) {
      console.log('processCommandsQuery 837:' + e)
    }
  }
}

//////////////////////////////////////////
//////////////// SPEECH //////////////////
//////////////////////////////////////////
let witAiLastCallTS = null
const witClient = require('node-witai-speech')
async function transcribeWitai (file) {
  try {
    // ensure we do not send more than one request per second
    if (witAiLastCallTS != null) {
      let now = Math.floor(new Date())
      while (now - witAiLastCallTS < 1000) {
        console.log('sleep')
        await sleep(100)
        now = Math.floor(new Date())
      }
    }
  } catch (e) {
    console.log('transcribeWitai 837:' + e)
  }

  try {
    console.log('transcribeWitai')
    const extractSpeechIntent = util.promisify(witClient.extractSpeechIntent)
    var stream = fs.createReadStream(file)
    witAiLastCallTS = Math.floor(new Date())
    const output = await extractSpeechIntent(witAPIKEY, stream, 'audio/wav')
    console.log(output)
    stream.destroy()
    if (output && '_text' in output && output._text.length) { return output._text }
    if (output && 'text' in output && output.text.length) { return output.text }
    return output
  } catch (e) { console.log('transcribeWitai 851:' + e) }
}
//////////////////////////////////////////
//////////////////////////////////////////
//////////////////////////////////////////
