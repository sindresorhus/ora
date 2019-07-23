'use strict';
const chalk = require('chalk');
const Ora = require('.');

const spinner = new Ora({
	discardStdin: false,
	text: 'Loading unicorns, not discarding stdin',
	spinner: process.argv[2]
});

const spinnerDiscardingStdin = new Ora({
	text: 'Loading unicorns',
	spinner: process.argv[2]
});

spinnerDiscardingStdin.start();

setTimeout(() => {
	spinnerDiscardingStdin.succeed();
	spinner.start();
}, 3000);

setTimeout(() => {
	spinner.color = 'yellow';
	spinner.text = `Loading ${chalk.red('rainbows')}`;
}, 4000);

setTimeout(() => {
	spinner.color = 'green';
	spinner.indent = 2;
	spinner.text = 'Loading with indent';
}, 5000);

setTimeout(() => {
	spinner.indent = 0;
	spinner.spinner = 'moon';
	spinner.text = 'Loading with different spinners';
}, 6000);

setTimeout(() => {
	spinner.succeed();
}, 7000);

// $ node example.js nameOfSpinner
