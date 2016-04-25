module.exports = function(SSH, db) {

  return function(id, host, username, password, key, minutes, standard) {

    var the_interval = minutes * 60 * 1000;

    var hostSplit = host.split(":");

    var obj = {
      id: id,
      host: host,
      isRunning: false,
      isPaused: false,
      lastChecks: []
    }
    obj.pause = function(state) {
      obj.isPaused = state
      db.update({
        _id: id
      }, {
        $set: {
          paused: state
        }
      }, function(err, numReplaced) {
        if (err) {
          console.log(`Error updating DB for id (${id})`);
        }
      });
    };

    obj.timer = setInterval(function() {
      if (obj.isPaused == true) {
        return;
      }
      if (obj.isRunning) {
        return;
      }
      obj.isRunning = true;
      var arg = {
        host: hostSplit[0],
        user: username,
        port: (hostSplit[1]) ? hostSplit[1] : 22
      };

      if (password) {
        arg.password = password;
      } else {
        arg.key = key;
      }

      var ssh = new SSH(arg);

      obj.lastChecks = [];
      ssh
        .exec('/usr/sbin/service --status-all', {
          out: function(stdout) {
            var re = /\[ (\+|\-|\?) \]\s+(.*)/g;
            var matches_array = re.exec(stdout);
            var checkObj = {}

            switch (matches_array[1]) {
              case '+': //running
                checkObj['status'] = 0
                checkObj['name'] = matches_array[2]
                break;
              case '-': //stopped
                checkObj['status'] = 1
                checkObj['name'] = matches_array[2]
                break;
              case '?': //unknown
                checkObj['status'] = -1
                checkObj['name'] = matches_array[2]
                break;
            }
            obj.lastChecks.push(checkObj);
          }
        })
        .exec('/sbin/initctl list', {
          out: function(stdout) {
            var re = /(.*?)\s(start|stop)/g
            while ((matches_array = re.exec(stdout)) !== null) {
              var checkObj = {}
              switch (matches_array[2]) {
                case 'start': //running
                  checkObj['status'] = 0
                  checkObj['name'] = matches_array[1]
                  break;
                case 'stop': //stopped
                  checkObj['status'] = 1
                  checkObj['name'] = matches_array[1]
                  break;
              }
              obj.lastChecks.push(checkObj);
            }

          },
          exit: function(code) {
            obj.isRunning = false;
            var stopCount = 0;
            for (var i = 0; i < obj.lastChecks.length; i++) {
              if (obj.lastChecks[i].status == 1) {
                stopCount++
              }
            }

            db.update({
              _id: id
            }, {
              $set: {
                checks: obj.lastChecks,
                lastCheck: new Date(),
                status: (stopCount >= obj.lastChecks.length - 1) ? 1 : 0
              }
            }, function(err, numReplaced) {
              if (err) {
                console.log(`Error updating DB for id (${id})`);
              }
            });
          }
        }).start();

    }, 5000);

    return obj;
  }

};
