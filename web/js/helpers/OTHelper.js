!function(exports) {
  'use strict';

  var dynamicOTLoad = false;
  var otPromise;

  // in IE dynamic loading the library doesn't work. For the time being, as a stopgap measure,
  // loading it statically.
  if (dynamicOTLoad) {
    var OPENTOK_API = 'https://static.opentok.com/webrtc/v2/js/opentok.min.js';
    otPromise = LazyLoader.load(OPENTOK_API,
                                './resolutionAlgorithms.js');
  } else {
    otPromise = LazyLoader.load('/js/helpers/resolutionAlgorithms.js');
  }

  var PrefResolutionAlgProv;
  otPromise.then(function () {
    PrefResolutionAlgProv= exports.PreferredResolutionAlgorithmProvider;
  });

  var MSG_MULTIPART = 'signal';
  var SIZE_MAX = 7800;

  var HEAD_SIZE =
    JSON.stringify({ _head: { id: 99, seq: 99, tot: 99}, data: "" }).length;
  var USER_DATA_SIZE = SIZE_MAX - HEAD_SIZE;
  var logger =
    new Utils.MultiLevelLogger('OTHelper.js', Utils.MultiLevelLogger.DEFAULT_LEVELS.all);

  var otLoaded = otPromise.then(function() {
    var hasRequirements = OT.checkSystemRequirements();
    logger.log('checkSystemRequirements:', hasRequirements);
    if (!hasRequirements) {
      OT.upgradeSystemRequirements();
      throw new Error('Unsupported browser, probably needs upgrade');
    }
    return;
  });

  var messageOrder = 0;
  var _msgPieces = {};

  var _session;
  var _publisher;
  var _publisherInitialized = false;
  var _screenShare;

  var _screenShareCapability = null;

  // Done intentionally (to use string codes for our error codes)
  // so as to not overwrite existing OT library codes
  var PUB_SCREEN_ERROR_CODES = {
    accessDenied: 1500,
    extNotInstalled: 'OT0001',
    extNotRegistered: 'OT0002',
    notSupported: 'OT0003',
    errPublishingScreen: 'OT0004'
  };

  //
  // Multipart message sending proccess
  //
  function composeSegment(aMsgId, aSegmentOrder, aTotalSegments, aUsrMsg) {
    var obj = {
      type: aUsrMsg.type,
      data: JSON.stringify({
        _head: {
          id: aMsgId,
          seq: aSegmentOrder,
          tot: aTotalSegments
        },
        data: aUsrMsg.data ?
                aUsrMsg.data.substr(aSegmentOrder * USER_DATA_SIZE, USER_DATA_SIZE) :
                ''
      })
    };
    if (aUsrMsg.to) {
      obj.to = aUsrMsg.to;
    }
    return obj;
  }

  function sendSignal(msg) {
    return new Promise(function(resolve, reject) {
      var msgId = ++messageOrder;
      var totalSegments = msg.data ? Math.ceil(msg.data.length / USER_DATA_SIZE) : 1;

      var messagesSent = [];
      for (var segmentOrder = 0; segmentOrder < totalSegments; segmentOrder++) {
        var signalData = composeSegment(msgId, segmentOrder, totalSegments, msg);
        messagesSent[segmentOrder] =
          new Promise(function(resolveMessage, rejectMessage) {
            _session.signal(signalData, function(error) {
              (error && (rejectMessage(error) || true)) || resolveMessage();
            });
          });
      }
      Promise.all(messagesSent).then(resolve).catch(reject);
    });
  }

  // END Multipart message sending proccess

  //
  // Multipart message reception proccess
  //
  function parseMultiPartMsg(aEvt) {
    var dataParsed;
    dataParsed = JSON.parse(aEvt.data);
    return {
      connectionId: aEvt.from.connectionId,
      head: dataParsed._head,
      data: dataParsed.data
    };
  }

  function receiveMultipartMsg(aFcClients, aEvt) {
    var parsedMsg = parseMultiPartMsg(aEvt);

    var connection = _msgPieces[parsedMsg.connectionId];
    var newPromise = null;
    // First msg from a client
    if (!connection) {
      connection = {};
      _msgPieces[parsedMsg.connectionId] = connection;
    }

    var msg = connection[parsedMsg.head.id];

    // First piece of a message
    if (!msg) {
      msg = {
        have: 0,
        data: new Array(parsedMsg.head.tot),
        promiseSolver: null
      };
      // Get a new solver
      newPromise = new Promise(function (resolve, reject) {
        msg.promiseSolver = resolve;
      });
      aFcClients.forEach(function(aFc) {
        newPromise.then(aFc);
      });
      connection[parsedMsg.head.id] = msg;
    }
    // This shouldn't be needed since we can only set one handler per signal
    // now, but doesn't hurt
    if (!msg.data[parsedMsg.head.seq]) {
      msg.data[parsedMsg.head.seq] = parsedMsg.data;
      msg.have++;
    }
    // If we have completed the message, fulfill the promise
    if (msg.have >= parsedMsg.head.tot ) {
      aEvt.data = msg.data.join('');
      msg.promiseSolver(aEvt);
      delete connection[parsedMsg.head.id];
    }
  }

  // END Reception multipart message proccess

  // We need to intercept the messages which type is multipart and wait until
  // the message is complete before to send it (launch client event)
  // aHandlers is an array of objects
  function _setHandlers(aReceiver, aHandlers) {
    var _interceptedHandlers = {};

    // First add the handlers removing the ones we want to intercept...
    for(var i = 0; i < aHandlers.length; i++) {
      var _handlers = {};
      Object.
        keys(aHandlers[i]).
        forEach(function(evtName) {
          var handler = aHandlers[i][evtName];
          if (evtName.startsWith(MSG_MULTIPART)) {
            _interceptedHandlers[evtName] = _interceptedHandlers[evtName] || [];
            _interceptedHandlers[evtName].push(handler.bind(aReceiver));
          } else {
            _handlers[evtName] = handler.bind(aReceiver);
          }
        });
      aReceiver.on(_handlers);
    }

    // And then add the intercepted handlers
    Object.
      keys(_interceptedHandlers).
      forEach(function(evtName) {
        _interceptedHandlers[evtName] =
          receiveMultipartMsg.bind(undefined, _interceptedHandlers[evtName]);
      });
    aReceiver.on(_interceptedHandlers);
  }

  // aHandlers is either an object with the handlers for each event type
  // or an array of objects
  function connectToSession(aApiKey, aSessionId, aToken, aHandlers) {
    if (!Array.isArray(aHandlers)) {
      aHandlers = [aHandlers];
    }
    return otLoaded.then(function() {
      return new Promise(function(resolve, reject) {
        if (!(aApiKey && aSessionId && aToken)) {
          return reject({
            message: 'Invalid parameters received. ' +
                     'ApiKey, sessionId and Token are mandatory'
          });
        }
        _session = OT.initSession(aApiKey, aSessionId);

        aHandlers && _setHandlers(_session, aHandlers);

        _session.connect(aToken, function(error) {
          error && reject(error) || resolve(_session);
        });
      });
    });
  };

  function removeListener(evtName) {
    _session.off(evtName);
  }

  function disconnectFromSession() {
    _session.disconnect();
  }

  function publish(aDOMElement, aProperties) {
    return new Promise(function(resolve, reject) {
        _publisher = OT.initPublisher(aDOMElement, aProperties, function(error) {
        if (error) {
          reject({ message: 'Error initializing publisher. ' + error.message });
        } else {
          _session.publish(_publisher, function(error) {
            if (error) {
                reject(error);
              } else {
                _publisherInitialized = true;
                resolve();
              }
          });
        }
      });
    });
  }

  function subscribeTo(aStream, name, value) {
    var arrSubscribers = _session.getSubscribersForStream(aStream);
    // TODO Currently we expect only one element in arrSubscriber
    Array.isArray(arrSubscribers) && arrSubscribers.forEach(function(subscriber) {
      subscriber['subscribeTo' + name](value);
    });
  }

  function togglePublisherVideo(value) {
    _publisher.publishVideo(value);
  }

  function toggleSubscribersVideo(aStream, value) {
    subscribeTo(aStream, 'Video', value);
  }

  function togglePublisherAudio(value) {
    _publisher.publishAudio(value);
  }

  function toggleSubscribersAudio(aStream, value) {
    subscribeTo(aStream, 'Audio', value);
  }

  function registerScreenShareExtension(aParams) {
    Object.keys(aParams).forEach(function(aKey) {
      OT.registerScreenSharingExtension(aKey, aParams[aKey]);
    });
  }

  function stopShareScreen() {
    // Should I return something like true/false or deleted element?
    _screenShare && _session.unpublish(_screenShare);
    _screenShare = null;
  }

  function getScreenShareCapability() {
    if (!_screenShareCapability) {
      _screenShareCapability = new Promise(function(resolve, reject) {
        OT.checkScreenSharingCapability(function(response) {
          if (!response.supported) {
            reject({
              code: PUB_SCREEN_ERROR_CODES.notSupport,
              message: 'This browser does not support screen sharing.'
            });
          } else if (response.extensionRegistered === false) {
            reject({
              code: PUB_SCREEN_ERROR_CODES.extNotRegistered,
              message: 'This browser does not support screen sharing.'
            });
          } else if (response.extensionInstalled === false) {
            reject({
              code: PUB_SCREEN_ERROR_CODES.extNotInstalled,
              message: 'Please install the screen sharing extension and load your app over https.'
            });
          } else {
            resolve();
          }
        });
      });
    }
    return _screenShareCapability;
  }

  function shareScreen(aDOMElement, aProperties, aHandlers) {
    var screenShareCapability = getScreenShareCapability();

    if (!Array.isArray(aHandlers)) {
      aHandlers = [aHandlers];
    }

    return screenShareCapability.then(function() {
      return new Promise(function(resolve, reject) {
        _screenShare =  OT.initPublisher(aDOMElement, aProperties, function(error) {
          if (error) {
            reject(error);
          } else {
            _session.publish(_screenShare, function(error) {
              if (error) {
                reject({
                  code: PUB_SCREEN_ERROR_CODES.errPublisheScreen,
                  message: error.message
                });
              } else {
                resolve();
              }
            });
          }
        });
        aHandlers && _setHandlers(_screenShare, aHandlers);
      });
    });
  }

  function subscribe(stream, targetElement, properties) {
    return new Promise(function(resolve, reject) {
      var subscriber = _session.subscribe(stream, targetElement, properties, function(error) {
        error ? reject(error) : resolve(subscriber);
      });
    });
  }

  function setPreferredResolution(aSubscriber, aTotalDimension, aSubsDimension,
                                 aSubsNumber, aAlgorithm) {
    var algInfo = PrefResolutionAlgProv.getAlg(aAlgorithm);
    var chosenAlgorithm = algInfo.chosenAlgorithm;
    var algorithm = algInfo.algorithm;
    var streamDimension = aSubscriber.stream.videoDimensions;
    var newDimension =
      algorithm(streamDimension, aTotalDimension, aSubsDimension, aSubsNumber);
    logger.log('setPreferedResolution -', chosenAlgorithm, ':', aSubscriber.stream.streamId,
               'of', aSubsNumber, ': Existing:', streamDimension, 'Requesting:', newDimension);
    aSubscriber.setPreferredResolution(newDimension);
  }

  var OTHelper = {
    connectToSession: connectToSession,
    publish: publish,
    get isPublisherReady() {
      return _publisherInitialized;
    },
    sendSignal: sendSignal,
    disconnectFromSession: disconnectFromSession,
    removeListener: removeListener,
    toggleSubscribersVideo: toggleSubscribersVideo,
    togglePublisherVideo: togglePublisherVideo,
    toggleSubscribersAudio: toggleSubscribersAudio,
    togglePublisherAudio: togglePublisherAudio,
    registerScreenShareExtension: registerScreenShareExtension,
    shareScreen: shareScreen,
    stopShareScreen: stopShareScreen,
    subscribe: subscribe,
    screenShareErrorCodes: PUB_SCREEN_ERROR_CODES,
    setPreferredResolution: setPreferredResolution,
    get publisherId() {
      return _publisher.stream.id;
    },
    isMyself: function(connection) {
      return _session &&
             _session.connection.connectionId === connection.connectionId;
    }
  };

  exports.OTHelper = OTHelper;

}(this);
