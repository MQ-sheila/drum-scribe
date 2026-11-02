/* DrumScope v0.4 browser application entry point. */
(function loadApp() {
  if (typeof module === 'object' && module.exports) {
    module.exports = require('./app-engine.js');
    return;
  }
  document.write('<script src="app-engine.js?v=0.8.91"></script>');
}());






