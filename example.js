'use strict';
var Ora = require('./');

var spinner = new Ora({
	text: 'Loading unicorns',
	spinner: process.argv[2],
	split: true
});

spinner.start();

setTimeout(() => {
	spinner.setColor('yellow');
	spinner.setText('Loading rainbows');
}, 1000);

setTimeout(() => {
	spinner.done();
}, 2000);

// $ node example.js nameOfSpinner
