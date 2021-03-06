var rules = require('../rules');
var util = require('../util');
var pluginMgr = require('../plugins');
var fileMgr = require('../util/file-mgr');
var transproto = require('../util/transproto');
var getEncodeTransform = transproto.getEncodeTransform;
var getDecodeTransform = transproto.getDecodeTransform;
var getRawHeaderNames = require('hparser').getRawHeaderNames;

var HTTP_RE = /^https?:/;
var MAX_PAYLOAD_SIZE = 1024 * 256;

function resolveRules(req, callback, rules) {
  if (!rules) {
    return callback();
  }
  req.curUrl = req.fullUrl = util.getFullUrl(req);
  if (rules.initRules) {
    rules.initRules(req);
  } else {
    var _pluginRules = rules.resolveRules(req);
    // 插件不支持rulesFile协议
    delete req.rules.rulesFile;
    util.mergeRules(req, _pluginRules);
  }
  var urlParamsRule = req.rules.urlParams;
  util.parseRuleJson(urlParamsRule, function(urlParams) {
    if (urlParams) {
      var _url = util.replaceUrlQueryString(req.url, urlParams);
      if (req.url !== _url) {
        req.url = _url;
        req.curUrl = req.fullUrl = util.getFullUrl(req);
        req.rules = rules.resolveRules(req);
        req.rules.urlParams = urlParamsRule;
        if (req.headerRulesMgr) {
          var _rules = req.rules;
          req.rules = req.headerRulesMgr.resolveRules(req);
          util.mergeRules(req, _rules);
        }
      }
    }
    callback();
  });
}

function setupRules(req, next) {
  resolveRules(req, function() {
    rules.resolveRulesFile(req, function() {
      pluginMgr.resolveWhistlePlugins(req);
      pluginMgr.getRules(req, function(pluginRules) {
        req.pluginRules = pluginRules;
        resolveRules(req, function() {
          var ruleUrl = util.rule.getUrl(req.rules.rule);
          if (ruleUrl !== req.fullUrl && HTTP_RE.test(ruleUrl)) {
            ruleUrl = util.encodeNonLatin1Char(ruleUrl);
          }
          req.options = util.parseUrl(ruleUrl || req.fullUrl);
          var rawNames = req.rawHeaderNames = Array.isArray(req.rawHeaders) ?
            getRawHeaderNames(req.rawHeaders) : {};
          rawNames.connection = rawNames.connection || 'Connection';
          rawNames['proxy-authorization'] = rawNames['proxy-authorization'] || 'Proxy-Authorization';
          next();
        }, pluginRules);
      });
    });
  }, rules);
}

function getDecoder(obj) {
  return function(socket, callback) {
    var encoding = obj._originEncoding;
    var decoder;
    if (obj._needGunzip || socket || encoding !== obj.headers['content-encoding']) {
      obj._needGunzip = true;
      decoder = encoding && util.getUnzipStream(encoding);
    }
    var handleError = function(err) {
      obj.emit('error', err);
    };
    decoder && decoder.on('error', handleError);
    if (socket) {
      delete obj.headers['content-length'];
      var enTrans = getEncodeTransform();
      var deTrans = getDecodeTransform();
      enTrans.pipe(socket).pipe(deTrans);
      enTrans.on('error', handleError);
      deTrans.on('error', handleError);
      if (decoder) {
        decoder.pipe(enTrans);
      } else {
        decoder = enTrans;
      }
      socket = deTrans;
    }
    callback(decoder, socket);
  };
}

function getEncoder(obj, req) {
  return function(socket, callback) {
    var encoding;
    var enable = req && req.enable;
    if (enable && enable.gzip && (obj._needGunzip || !obj._originEncoding)) {
      encoding = 'gzip';
    } else {
      encoding = obj._needGunzip && obj.headers;
    }
    var encoder = encoding && util.getZipStream(encoding);
    var handleError = function(err) {
      obj.emit('error', err);
    };
    encoder && encoder.on('error', handleError);
    if (socket) {
      delete obj.headers['content-length'];
      var enTrans = getEncodeTransform();
      var deTrans = getDecodeTransform();
      enTrans.on('error', handleError);
      deTrans.on('error', handleError);
      enTrans.pipe(socket).pipe(deTrans);
      socket = enTrans;
      if (encoder) {
        deTrans.pipe(encoder);
      } else {
        encoder = deTrans;
      }
      socket.pipe = function(stream) {
        return encoder.pipe(stream);
      };
      obj.emit('bodyStreamReady', socket);
    }
    callback(socket || encoder);
  };
}

module.exports = function(req, res, next) {
  req.reqId = util.getReqId();
  req.curUrl = req.fullUrl = util.getFullUrl(req);
  req._originEncoding = req.headers['content-encoding'];
  req.onDecode = function(callback) {
    var decode = getDecoder(req);
    pluginMgr.getReqReadPipe(req, function(socket) {
      decode(socket, callback);
    });
  };
  req.onEncode = function(callback) {
    var encode = getEncoder(req);
    pluginMgr.getReqWritePipe(req, function(socket) {
      encode(socket, callback);
    });
  };
  res.onDecode = function(callback) {
    var decode = getDecoder(res, req);
    pluginMgr.getResReadPipe(req, res, function(socket) {
      decode(socket, callback);
    });
  };
  res.onEncode = function(callback) {
    var encode = getEncoder(res, req);
    pluginMgr.getResWritePipe(req, res, function(socket) {
      encode(socket, callback);
    });

  };
  rules.initHeaderRules(req, true);
  pluginMgr.resolvePipePlugin(req, function() {
    var reqReadPort = req._pipePluginPorts.reqReadPort;
    if (reqReadPort || req._pipePluginPorts.reqWritePort) {
      delete req.headers['content-length'];
    }
    var hasBodyFilter = rules.resolveBodyFilter(req);
    req._bodyFilters = null;
    if (hasBodyFilter || reqReadPort) {
      req._needGunzip = true;
      var payloadSize = MAX_PAYLOAD_SIZE;
      if (!hasBodyFilter) {
        payloadSize = rules.hasReqScript(req) ? 0 : 1;
      }
      req.getPayload(function (err, payload) {
        req._reqBody = fileMgr.decode(payload);
        setupRules(req, next);
      }, payloadSize);
    } else {
      setupRules(req, next);
    }
  });
};

