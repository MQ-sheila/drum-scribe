/* DrumScope v0.4 browser core entry point. */
(function loadCore() {
  if (typeof module === 'object' && module.exports) {
    module.exports = require('./core-engine.js');
    return;
  }
  document.write('<script src="core-engine.js?v=0.8.96"></script>');
  document.write('<script src="core-v04.js?v=0.8.96"></script>');
  document.write('<script src="core-horizontal.js?v=0.8.96"></script>');
}());






