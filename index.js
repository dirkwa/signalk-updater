module.exports = function (app) {
  const plugin = {
    id: 'signalk-update',
    name: 'SignalK Update',
    description: 'Update/upgrade plugin for SignalK (skeleton).',
    schema: {
      type: 'object',
      properties: {}
    },
    start: function (_options) {
      app.debug('signalk-update start (skeleton — no update logic implemented)');
    },
    stop: function () {
      app.debug('signalk-update stop');
    }
  };

  return plugin;
};
