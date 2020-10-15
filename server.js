//BEFORE EXECUTING in console: export GOOGLE_APPLICATION_CREDENTIALS="./google_creds.json"

const WebSocket = require("ws");
const express = require("express");
const Sentry = require('@sentry/node');
const Tracing = require("@sentry/tracing")
const app = express();
const server = require("http").createServer(app);
const wss = new WebSocket.Server({ server });
const url = require('url');
const urlencoded = require('body-parser').urlencoded;

const port = 8080;
const { hostname } = require('os');
// Parse incoming POST params with Express middleware
app.use(urlencoded({ extended: false }));

//Include Google Speech to Text
const speech = require("@google-cloud/speech");
const speechClient = new speech.SpeechClient();

//load the config and client
const config = require('./config');
const { start } = require("repl");
const Voice = require("twilio/lib/rest/Voice");
const { query } = require("express");
const { userNumber } = require("./config");
// const client = require('twilio')(config.accountSid, config.authToken);
// const VoiceResponse = require('twilio').twiml.VoiceResponse;

//init sentry
Sentry.init({
  dsn: "https://a772ee6d0b1a47888fba73a289e2aabb@o458983.ingest.sentry.io/5457453",
  integrations: [
    // enable HTTP calls tracing
    new Sentry.Integrations.Http({ tracing: true }),
    // enable Express.js middleware tracing
    new Tracing.Integrations.Express({ app }),
  ],

  // We recommend adjusting this value in production, or using tracesSampler
  // for finer control
  tracesSampleRate: 1.0,
});

// RequestHandler creates a separate execution context using domains, so that every
// transaction/span/breadcrumb is attached to its own Hub instance
app.use(Sentry.Handlers.requestHandler());
// TracingHandler creates a trace for every incoming request
app.use(Sentry.Handlers.tracingHandler());


//let recognizeStream, timeout;
let streamingLimit = 290000 //4,9 minutes

//Configure Transcription Request
const request = {
  config: {
    encoding: "MULAW",
    sampleRateHertz: 8000,
    languageCode: "es-ES"
  },
  interimResults: true
};

function startStream(streamSession) {
  if(streamSession.recognizeStream){
    streamSession.recognizeStream.destroy();
    streamSession.recognizeStream = null;
  }
  streamSession.recognizeStream = speechClient
      .streamingRecognize(request)
      .on('error', (err) => {
          Sentry.captureException('recognize Stream failed for callSid: ' + streamSession.callSid + 'error: ' + err);
      })
      .on('data', (data) => {
          var transcript = data.results[0].alternatives[0].transcript
          detectGreeting(transcript,streamSession);
      });
  //restarting stream every 4,9 mins for infinite streaming
  streamSession.timeout = setTimeout(startStream, streamingLimit,streamSession);
}

function restartStream(streamSession) {
  if (streamSession.recognizeStream) {
      //recognizeStream.removeListener('data', speechCallback);
      streamSession.recognizeStream.destroy();
      streamSession.recognizeStream = null;
      startStream(actionId, userNumber)
  }
}

function detectGreeting(transcript, streamSession){
  for (let word of config.welcomeWords){
    if (transcript.includes(word)){
      if(!streamSession.call_processed){
        streamSession.call_processed = true
        processCall(streamSession)
      }
      break;
    }
  }
}


function processCall(streamSession){
    //Stop timeout streaming recognize
    client.calls(streamSession.callSid)
              .update({twiml: `<?xml version="1.0" encoding="UTF-8"?>
              <Response>
                  <Play>${config.streamMessagePlay}</Play>
                  <Stop>
                    <Stream name="${streamSession.actionId}" />
                  </Stop>
                  <Dial record="record-from-answer-dual" answerOnBridge="True" action="http://${ngrokHost}/callBack">
                  <Number>${streamSession.userNumber}</Number>
                  </Dial>
              </Response>
              `});
}


// Handle Web Socket Connection
wss.on("connection", function connection(ws) {
var streamSession = {
  callProcessed: false
}
    ws.on("message", function incoming(message) {
        const msg = JSON.parse(message);
        switch (msg.event) {
            case "connected":
                break;
            case "start":
                streamSession.userNumber = msg.start.customParameters.userNumber;
                streamSession.callSid = msg.start.callSid;
                streamSession.actionId = msg.start.customParameters.actionId;
                startStream(streamSession)
                break;
            case "media":
                // Write Media Packets to the recognize stream
                streamSession.recognizeStream.write(msg.media.payload);
                break;
            case "stop":
                streamSession.recognizeStream.destroy();
                clearTimeout(streamSession.timeout)
            break;
        }
    });
    
});

//Handle HTTP Request
app.get("/", (req, res) => res.send("Hello Cloud"));

app.post("/stream", (req, res) => {
  ngrokHost = req.headers.host
  res.set("Content-Type", "text/xml");
  let actionId = Math.floor(Math.random() * 1000);
  res.send(`
    <Response>
      <Start>
        <Stream name="${actionId}" url="wss://${ngrokHost}/">
        <Parameter name="userNumber" value ="${config.userNumber}"/>
        <Parameter name="actionId" value ="${actionId}"/>
        </Stream>
      </Start>
      <Pause length="3000" />
    </Response>
  `);
});

app.get("/makeCallStream", (req, res) => { 
  let queryObject = url.parse(req.url,true).query;
  client.calls
      .create({
        sendDigits: queryObject.sendDigits,
        url: 'http://'+ req.headers.host +'/stream',
        to: queryObject.toNumber,
        from: queryObject.fromNumber,
        statusCallback: 'http://'+ req.headers.host +'/callBack',
        //statusCallback: 'http://843441325a1b.ngrok.io/callBack',
        statusCallbackEvent: ['answered', 'completed']
       })
      .then(call => {
        callSid = call.sid;});
  res.send('Call Processed')
})

app.get("/makeCallNumber", (req, res) => { 
  let queryObject = url.parse(req.url,true).query;
  client.calls
      .create({
        sendDigits: queryObject.sendDigits,
        url: 'http://'+ req.headers.host +'/pressNumber',
        to: queryObject.toNumber,
        from: queryObject.fromNumber,
        statusCallback: 'http://'+ req.headers.host +'/callBack',
        statusCallbackEvent: ['answered', 'completed']
       })
      .then(call => {
        callSid = call.sid;});
  res.send('Call Processed')
})

app.post("/callFromTwilio", (req, res) => { 
  const response = new VoiceResponse();
  const dial = response.dial({callerId: '+441615194253'});
  dial.number('+34684239397')
  res.set("Content-Type", "text/xml");
  res.send(response.toString());
})


app.post('/pressNumber', (request, response) => {
  // Use the Twilio Node.js SDK to build an XML response
  const twiml = new VoiceResponse();

  /** helper function to set up a <Gather> */
  function gather() {
    const gatherNode = twiml.gather({ numDigits: 1, timeout: 2 });
    //gatherNode.play('https://deicol.s3.eu-west-3.amazonaws.com/asistenteDavid.wav')
    gatherNode.play('https://deicol.s3.eu-west-3.amazonaws.com/long_casual2.wav')
    // If the user doesn't enter input, loop
    twiml.redirect('/pressNumber');
  }
  //console.log(request.body)
  // If the user entered digits, call the user Number
  if (request.body.Digits) {
    
    twiml.dial({record: 'record-from-ringing',
               answerOnBridge: 'true'
  }, config.userNumber);

  } else {
    // If no input was sent, use the <Gather> verb to collect user input
    gather();
  }

  // Render the response as XML in reply to the webhook request
  response.type('text/xml');
  response.send(twiml.toString());
});

app.post("/callBack", (req, res) => {
  console.log(req.body)
  res.type('text/xml');
  res.send('<?xml version="1.0" encoding="UTF-8"?> <Response></Response>');
});

app.post("/hangUpCall", (req, res) => {
  let queryObject = url.parse(req.url,true).query;
  callSid = queryObject.callSid
  client.calls(callSid)
              .update({twiml: `<?xml version="1.0" encoding="UTF-8"?>
              <Response>
                <Hangup/>
              </Response>
              `});
  res.send('Hangup call ');
});

app.get("/debug-", function mainHandler(req, res) {
  throw new Error("My first Sentry error!");
});

// The error handler must be before any other error middleware and after all controllers
app.use(Sentry.Handlers.errorHandler());

// Optional fallthrough error handler
app.use(function onError(err, req, res, next) {
  // The error id is attached to `res.sentry` to be returned
  // and optionally displayed to the user for support.
  res.statusCode = 500;
  res.end(res.sentry + "\n");
});


server.listen(port, hostname, () => {
  console.log(`Server running at http://${hostname()}:${port}/`);
});