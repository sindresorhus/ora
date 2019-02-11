'use strict';
const Ora = require('.');

const spinner = new Ora({
	text: 'Loading unicorns',
	spinner: process.argv[2]
});

spinner.start();

setTimeout(() => {
	spinner.color = 'yellow';
	spinner.text = 'Loading rainbows';
}, 1000);

setTimeout(() => {
	spinner.color = 'green';
	spinner.indent = 2;
	spinner.text = 'Loading with indent';
}, 2000);

setTimeout(() => {
	spinner.indent = 0;
	spinner.spinner = 'moon';
	spinner.text = 'Loading with different spinners';
}, 3000);

setTimeout(() => {
	spinner.succeed();
}, 4000);

// $ node example.js nameOfSpinner
