//set env
var dotenv = require('node-env-file');
var env = process.env.NODE_ENV || 'development';

if (env !== "production") {
    dotenv('.env');
}

var async     = require('async');
var fs        = require('fs');
var Hashids   = require('hashids');
var mock_data = require('./stubs.js');
var moment    = require('moment');
var NRP       = require('node-redis-pubsub');
var path      = require('path');
var request   = require('request');
var Slack     = require('node-slack-upload');


// set globals
var DB_URL = process.env.DB_URL,
    CALENDAR_API_KEY = process.env.CALENDAR_API_KEY,
    CALENDAR_URL = 'https://www.googleapis.com/calendar/v3/freeBusy?fields=calendars&key=' + CALENDAR_API_KEY,
    NRP = require('node-redis-pubsub'),
    nrp = new NRP({url: process.env.REDIS_URL});

var CHANNEL_ID;

function bot(robot) {
    nrp.on('availability-check', function(data){
        var participants = findParticipants(data.participants);
        var organizer_data = findUser(data.organizer);
        var organizer = {
                            name: organizer_data.name,
                            slack_handle: organizer_data.slack
                        };
        updateAvailability(participants, function(err) {
            if(err) {
                console.log("updateAvailability failed", err);
            } else {
                emitAvailability(organizer, participants);
            }
        });
    });

    nrp.on('start-call', function(data) {
        nrp.off('start-call');
        console.log('start-call request!', data);
        var conference_link = createVideoConference();
        var users = data.participants;
        users.push(data.organizer);
        messageSlackUsers(conference_link, users);
    });

    nrp.on('end-call', function(data) {
        console.log('end-call request!', data);
        fileUpload(CHANNEL_ID);
    });
}

function createMultiParty(slackIds, cb) {
    params = {
        url: "https://slack.com/api/mpim.open",
        headers: {
            'Content-Type': 'application/json'
        },
        qs: {
            users: slackIds.join(","),
            token: process.env.HUBOT_SLACK_TOKEN
        }
    }
    request.get(params, function (err, status, body){
        console.log(err, body);
        console.log("Multi Party Channel");
        body = JSON.parse(body);
        console.log(body.group.id);
        cb(body.group.id);
    })
}

function fileUpload(groupId) {
  var slack = new Slack(process.env.HUBOT_SLACK_TOKEN);

  slack.uploadFile({
    file: fs.createReadStream(path.join(__dirname, '..', 'meeting_notes.txt')),
    filetype: 'post',
    title: 'meeting notes',
    channels: groupId
  }, function(err) {
    if (err) {
      console.error(err);
    } else {
      console.log('file uploaded');
    }
  });
}

function createVideoConference() {
    var hashids = new Hashids();
    // var random_int = Math.ceil(Math.random() * 10000);
    var random_int = 1234567890;
    var slug = hashids.encode(random_int);
    var url = "http://appear.in/" + slug;
    return url;
}

function emitAvailability(organizer, participants) {
    console.log("EMIT AVAILABILITY");
    var data = {organizer: organizer, participants: participants};
    nrp.emit('availability-response', data);
}

function findParticipants(participant_list) {
    var result = [];
    for (participant in participant_list) {
        var user = findUser(participant_list[participant]);
        var data = {name: user.name, slack_handle: user.slack, email: user.email};
        result.push(data);
    }
    return result;
}


function findUser(name) {
    for (i in mock_data) {
        if (mock_data[i].name.toLowerCase() ===  name.toLowerCase()) {
            return mock_data[i];
        }
    }
}

function findUserBySlackHandle(slack_handle) {
    for (i in mock_data) {
        if (mock_data[i].slack.toLowerCase() ===  slack_handle.toLowerCase()) {
            return mock_data[i];
        }
    }
}

function getAvailability(user, cb) {
    // Calendar && Profile && SlackPresence
    isAvailableOnCalendar(user.email, function(is_available_on_calendar) {
      if (is_available_on_calendar) {
        var participant = findUserBySlackHandle(user.slack_handle);

        // check for availability on Slack
        var is_available_on_slack = isAvailableOnSlack(participant);

        if (is_available_on_slack) {
            console.log("PARTICIPANT STATUS");
            console.log(participant.status);

          switch(participant.status) {
            case "CMIL":
              cb({status: true, message: "available"});
            case "WIWO":
              cb({status: false, message: "currently working on changing the world"});
            case "DAYOP":
              cb({status: false, message: "do not disturb"});
          }
        } else {
            cb({status: false, message: "away on slack"});
        }
      } else {
        cb({status: false, message: "unavailable"});
      }
    });
}

function isAvailableOnCalendar(email, cb) {
    console.log("is email available: ", email);
    var date = moment().format();
    var maxDate = moment().add(15, 'm').format();
    var params = {
        url: CALENDAR_URL,
        headers: {
            'Content-Type': 'application/json',
            'Authorization': 'Bearer ' + process.env.ACCESS_TOKEN
        },
        body: JSON.stringify({
            timeMin: date,
            timeMax: maxDate,
            calendarExpansionMax: 5,
            groupExpansionMax: 5,
            timezone: 'GMT',
            items: [{ id: email }]
        })
    }

    console.log('checking calendar...');
    request.post(params, function (err, status, body) {
        var userCal;
        body = JSON.parse(body);
        console.log("CURRENT ACCESS_TOKEN");
        console.log(process.env.ACCESS_TOKEN);
        if (body.error && body.error.code === 401) {
            console.log("GOOGLE CALENDAR 401");
            console.log(body.error.message);
            return
        }
        console.log(body);
        userCal = body.calendars[email];

        if (userCal.busy.length === 0) {
            console.log('user is available');
            cb(true);
        }
        if (userCal.busy.length > 0) {
            console.log('user is not available');
            cb(false);
        }
    });
}

function isAvailableOnSlack(participant) {
  return participant.presence;
}


function messageSlackUsers(link, participants) {
    console.log("Message Slack Users");
    var slackIds = [];
    for (i in participants) {
        slackIds.push(findUserBySlackHandle(participants[i].slack_handle).slack_id);
    }
    console.log(slackIds);
    createMultiParty(slackIds, function (channelId) {
        CHANNEL_ID = channelId
        params = {
            url: "https://slack.com/api/chat.postMessage",
            headers: {
                'Content-Type': 'application/json'
            },
            qs: {
                token: process.env.HUBOT_SLACK_TOKEN,
                channel: channelId,
                as_user: true,
                text: participants[participants.length-1].name + " has asked you to meet at the watercooler: " + link
            }
        }

        request.get(params, function (err, status, body) {
            if(err) {
                console.log(err, body);
                return;
            }
            nrp.emit('call-started', {});
        });
    });
}

function updateAvailability(participants, cb) {
    console.log("UPDATE AVAILABILITY");
    async.each(participants, updateAvailabilityStatus, function (err) {
        if (err) {
            console.log("Async Failed");
        } else {
            console.log("Async Succeeded");
        }
        cb(err);
    });
}

function updateAvailabilityStatus(participant, cb) {
    console.log("async each", participant);
    getAvailability(participant, function(av) {
        console.log("CALLBACK IN UPDATE");
        participant.status  = av.status;
        participant.message = av.message;
        cb(null); // called for each participant for async to keep count
    });
}

module.exports = bot;