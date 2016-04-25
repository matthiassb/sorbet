'use strict';


var fs = require('fs-extra');
var async = require('async');
var inert = require('inert');
var Path = require('path');
var SSH = require('simple-ssh');
var Datastore = require('nedb');
var _ = require('lodash');
var Joi = require('joi');
var Hapi = require('hapi');
var server = new Hapi.Server();
var encryptor = null;

var HOME_DIR = process.env[(process.platform == 'win32') ? 'USERPROFILE' : 'HOME'];
var CONFIG_DIR = Path.join(HOME_DIR, ".sorbet");
var CONFIG_FILE = Path.join(CONFIG_DIR, "config.json");
var SYSTEMS_DB = Path.join(CONFIG_DIR, "systems.db");
var SORBET_CONFIG = null;
var SCHEDULES = [];

var db = new Datastore({
  filename: Path.join(SYSTEMS_DB),
  autoload: true
});
var scheduler = require('./lib/scheduler.js')(SSH, db);

server.connection({
  port: 6767,
  routes: {
    files: {
      relativeTo: Path.join(__dirname, 'resources')
    }
  }
});

server.route({
  method: 'GET',
  path: '/assets/{file*}',
  handler: function(request, reply) {
    return reply.file("assets/" + request.params.file)
  }
});

server.route({
  method: 'GET',
  path: '/',
  handler: function(request, reply) {
    db.find({}, function(err, docs) {
      if (err) {
        return reply({
          "message": err.message
        }).code(500);
      }
      if (docs.length == 0) {
        docs.push({
          host: "No Systems Added"
        })
      } else {
        docs.forEach(function(entry) {
          switch (entry.status) {
            case -1:
              entry.label = "label-warning";
              entry.statusText = "Pending";
              break;
            case 0:
              entry.label = "label-success";
              entry.statusText = "Success";
              break;
            case 1:
              entry.label = "label-danger";
              entry.statusText = "Error";
              break;
          }
          entry.host = entry.host.split(":")[0]
        })
      }
      reply.view('index', docs)
    });
  }
});
server.route({
  method: 'POST',
  path: '/svc/systems',
  handler: function(request, reply) {

    var schema = Joi.object().keys({
      host: Joi.string().required(),
      username: Joi.string().required(),
      password: Joi.string(),
      ssh_key: Joi.string()
    }).xor('password', 'ssh_key');

    Joi.validate(request.payload, schema, function(err, value) {
      if (err) {
        err.details[0].message = err.details[0].message.replace("\"value\" ", "");
        return reply({
          "message": err.details[0].message
        }).code(400)
      }
      value.status = -1;
      value.lastCheck = null;
      if(value.password){
        var plainPass = value.password;
        value.password = encryptor.encrypt(value.password);
      }


      db.insert(value, function(err, newDoc) {
        if (err) {
          return reply({
            "message": err.message
          }).code(500);
        }
        if(plainPass){
          SCHEDULES.push(scheduler(newDoc["_id"], value.host, value.username, plainPass));
        } else {
          SCHEDULES.push(scheduler(newDoc["_id"], value.host, value.username, null, value.ssh_key));
        }
        reply({
          "id": newDoc["_id"],
          "message": "System added"
        })
      });
    })
  }
});

server.route({
  method: 'GET',
  path: '/svc/systems/{id}',
  handler: function(request, reply) {

    db.findOne({
      _id: request.params.id
    }, {
      password: 0,
      ssh_key: 0
    }, function(err, docs) {
      if (err) {
        return reply({
          "message": err.message
        }).code(500);
      }
      docs["checks"] = _.sortBy(docs["checks"], ['name']);
      reply(docs)
    });
  }
});

async.series([
    function(callback) {
      server.register(require('vision'), function(err) {

        if (err) {
          callback("Error registering vision");
        }

        server.views({
          engines: {
            html: require('handlebars')
          },
          path: Path.join(__dirname, 'resources/layouts'),
          isCached: false
        });

        callback(null);
      });
    },
    function(callback) {
      server.register(require('inert'), function() {
        callback(null);
      });
    },
    function(callback) {
      var options = {
        opsInterval: 1000,
        reporters: [{
          reporter: require('good-console'),
          events: {
            log: '*',
            response: '*'
          }
        }]
      };
      server.register({
        register: require('good'),
        options: options
      }, function(err) {
        if (err) {
          callback("Error registering good");
        } else {
          callback(null);
        }
      });
    },
    function(callback) {
      db.ensureIndex({
        fieldName: 'host',
        unique: true
      }, function(err) {
        if (err) {
          callback(err);
        } else {
          callback(null);
        }
      });
    }
  ],
  function(err, results) {
    if (err) {
      console.log(err);
    } else {

      fs.ensureFileSync(CONFIG_DIR);

      var contents = fs.readFileSync(CONFIG_FILE).toString();
      if (contents.length == 0) {
        SORBET_CONFIG = {};
      } else {
        SORBET_CONFIG = require(CONFIG_FILE);
      }


      server.start(function(err) {
        if (err) {
          throw err;
        }
        if(!SORBET_CONFIG['encKey']){
          require('crypto').randomBytes(48, function(err, buffer) {
            var token = buffer.toString('hex');
            updateConfig('encKey', token)
            encryptor = require('simple-encryptor')(token);
          });
        } else {
          encryptor = require('simple-encryptor')(SORBET_CONFIG['encKey']);
        }
        db.find({}, function(err, docs) {
          docs.forEach(function(doc) {
            if(doc.password){
              SCHEDULES.push(scheduler(doc["_id"], doc.host, doc.username, encryptor.decrypt(doc.password)));
            } else {
              SCHEDULES.push(scheduler(doc["_id"], doc.host, doc.username, null, doc.ssh_key));
            }

          })
        });
        db.persistence.setAutocompactionInterval(60000)
        console.log('Server running at:', server.info.uri);
      });
    }
  });

function updateConfig(key, value){
  SORBET_CONFIG[key] = value;
  fs.writeFile(CONFIG_FILE, JSON.stringify(SORBET_CONFIG, null, 2) , 'utf-8');
}
