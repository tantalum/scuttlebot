var assert = require('assert')
var path = require('path')
var fs = require('fs')
var pull = require('pull-stream')
var cat = require('pull-cat')
var pushable = require('pull-pushable')
var toPull = require('stream-to-pull-stream')
var spawn = require('child_process').spawn
var mkdirp = require('mkdirp')
var rimraf = require('rimraf')
var mdm = require('mdmanifest')
var valid = require('../lib/validators')
var apidoc = require('../lib/apidocs').plugins

module.exports = {
  name: 'plugins',
  version: '1.0.0',
  manifest: mdm.manifest(apidoc),
  permissions: {
    master: {allow: ['install', 'uninstall', 'enable', 'disable']}
  },
  init: function (server, config) {
    var installPath = config.path
    config.plugins = config.plugins || {}
    mkdirp.sync(path.join(installPath, 'node_modules'))

    // helper to enable/disable plugins
    function configPluginEnabled (b) {
      return function (pluginName, cb) {
        checkInstalled(pluginName, function (err) {
          if (err) return cb(err)

          config.plugins[pluginName] = b 
          writePluginConfig(pluginName, b)
          if (b)
            cb(null, '\''+pluginName+'\' has been enabled. Restart Scuttlebot server to use the plugin.')
          else
            cb(null, '\''+pluginName+'\' has been disabled. Restart Scuttlebot server to stop using the plugin.')
        })
      }
    }

    // helper to check if a plugin is installed
    function checkInstalled (pluginName, cb) {
      if (!pluginName || typeof pluginName !== 'string')
        return cb(new Error('plugin name is required'))
      var modulePath = path.join(installPath, 'node_modules', pluginName)
      fs.stat(modulePath, function (err) {
        if (err)
          cb(new Error('Plugin "'+pluginName+'" is not installed.'))
        else
          cb()
      })
    }

    // write the plugin config to ~/.ssb/config
    function writePluginConfig (pluginName, value) {
      var cfgPath = path.join(config.path, 'config')
      var existingConfig = {}
      
      // load ~/.ssb/config
      try { existingConfig = JSON.parse(fs.readFileSync(cfgPath, 'utf-8')) }
      catch (e) {}

      // update the plugins config
      existingConfig.plugins = existingConfig.plugins || {}
      existingConfig.plugins[pluginName] = value

      // write to disc
      fs.writeFileSync(cfgPath, JSON.stringify(existingConfig, null, 2), 'utf-8')
    }

    return { 
      install: function (pluginName, opts) {
        var p = pushable()
        var dryRun = opts && opts['dry-run']

        if (!pluginName)
          return pull.error(new Error('plugin name is required'))

        // build args
        // --global-style: dont dedup at the top level, gives proper isolation between each plugin
        // --loglevel error: dont output warnings, because npm just whines about the lack of a package.json in ~/.ssb
        // --json: output stdout in JSON, so we can extract the final module name
        var args = ['install', pluginName, '--global-style', '--loglevel', 'error', '--json']
        if (dryRun)
          args.push('--dry-run')

        var stdoutCollected
        var nDone = 2
        function doneSuccess (err, data) {
          if (data)
            stdoutCollected = data.map(function (b) { return b.toString('utf-8') }).join('')
          
          if (--nDone === 0) {
              var moduleName, version = ''
              try {
                // read the stdout for the module name
                // - pluginName may actually be a URL or some other kind of identifier
                var jsonOut = JSON.parse(stdoutCollected)
                moduleName = Object.keys(jsonOut.dependencies)[0]
                version = '@'+jsonOut.dependencies[moduleName].version
              } catch (e) {}

              // fallback to trying to extract from the given url/identifier
              if (!moduleName) 
                moduleName = path.basename(pluginName)

              // enable the plugin
              config.plugins[moduleName] = true
              writePluginConfig(moduleName, true)
              p.push(new Buffer('"'+moduleName+version+'" has been installed. Restart Scuttlebot server to enable the plugin.\n', 'utf-8'))
              p.end()
          }
        }

        // exec npm
        var child = spawn('npm', args, { cwd: installPath })
          .on('close', function (code) {
            if (code == 0 && !dryRun)
              doneSuccess()
            else
              p.end(new Error('"'+pluginName+'" failed to install. See log output above.'))
          })

        // collect stdout
        pull(toPull(child.stdout), pull.collect(doneSuccess))

        // build output stream
        return cat([
          pull.values([new Buffer('Installing "'+pluginName+'"...\n', 'utf-8')]),
          toPull(child.stderr),
          p
        ])
      },
      uninstall: function (pluginName, opts) {
        var p = pushable()
        if (!pluginName || typeof pluginName !== 'string')
          return pull.error(new Error('plugin name is required'))

        var modulePath = path.join(installPath, 'node_modules', pluginName)

        rimraf(modulePath, function (err) {
          if (!err) {
            writePluginConfig(pluginName, false)
            p.push(new Buffer('"'+pluginName+'" has been uninstalled. Restart Scuttlebot server to disable the plugin.\n', 'utf-8'))
            p.end()
          } else
            p.end(err)
        })
        return p
      },
      enable: configPluginEnabled(true),
      disable: configPluginEnabled(false)
    }
  }
}

module.exports.loadUserPlugins = function (createSbot, config) {
  // iterate all modules
  var nodeModulesPath = path.join(config.path, 'node_modules')
  try {
    console.log('Loading plugins from', nodeModulesPath)
    fs.readdirSync(nodeModulesPath).forEach(function (filename) {
      if (filename.charAt(0) == '.')
        return // ignore
      if (!config.plugins[filename])
        return console.log('Skipping disabled plugin "'+filename+'"')
      console.log('Loading plugin "'+filename+'"')

      try {
        // load module
        var plugin = require(path.join(nodeModulesPath, filename))

        // check the signature
        assertSbotPlugin(plugin)

        // load
        createSbot.use(plugin)
      } catch (e) {
        console.error('Error loading plugin "'+filename+'":', e.message)
      }
    })
  } catch (e) {
    // node_modules dne, ignore
  }
}

// predictate to check if an object appears to be a sbot plugin
function assertSbotPlugin (obj) {
  // function signature:
  if (typeof obj == 'function')
    return

  // object signature:
  assert(obj && typeof obj == 'object',   'module.exports must be an object')
  assert(typeof obj.name == 'string',     'module.exports.name must be a string')
  assert(typeof obj.version == 'string',  'module.exports.version must be a string')
  assert(obj.manifest &&
         typeof obj.manifest == 'object', 'module.exports.manifest must be an object')
  assert(typeof obj.init == 'function',   'module.exports.init must be a function')
}
